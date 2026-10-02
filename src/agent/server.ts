import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { describeSlot, SUPPORT_TIMEZONE } from "../mcp/callback-slots.js";
import { draftPayload } from "./draft.js";
import { getDb, requireEnv } from "../shared/db.js";
import { agentAuthToken, mcpAuthToken } from "./config.js";
import { dispatchHandoffEmails } from "./handoff-email.js";
import { endConversation, handleTurn, NotFoundError } from "./respond.js";
import { createConversation } from "./store.js";
import { sweepStaleConversations } from "./sweep.js";
import { vapiRouter } from "./vapi.js";

/**
 * Everything the server needs is checked here, so a misconfigured deploy fails loudly at boot
 * rather than passing its health check and then breaking on a caller's first turn.
 */
const expected = Buffer.from(agentAuthToken());
mcpAuthToken();
requireEnv("ANTHROPIC_API_KEY");
// Co-hosted, the localhost default is correct and MCP_SERVER_URL is not needed. Deployed apart,
// that default would silently point at nothing, so require it.
if (process.env.PORT && !process.env.MCP_SERVER_URL && process.env.MCP_COLOCATED !== "1") {
  throw new Error("MCP_SERVER_URL must be set when the tool server is deployed separately");
}
getDb(); // Supabase credentials are read lazily, so touch the client once to validate them now.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE_CHARS = 1000;

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Accept "Bearer <token>" and a bare token. Vapi's custom-LLM config sends the key in different
  // shapes depending on how it is entered, and a mismatch there 401s every single turn of a call
  // with no clue why. The secret itself is still required and still compared in constant time.
  const header = (req.headers.authorization ?? "").trim();
  const supplied = Buffer.from(header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : header);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    // Shape only, never the value: a rejected call otherwise gives no clue whether the caller sent
    // nothing, a truncated token, or the right length with the wrong content.
    const shape = header
      ? `scheme=${header.toLowerCase().startsWith("bearer ") ? "Bearer" : "none"} length=${supplied.length} expected=${expected.length}`
      : "no authorization header";
    console.warn(`401 on ${req.method} ${req.path}: ${shape}`);
    res.status(401).json({ error: "unauthorised" });
    return;
  }
  next();
}

function fail(res: Response, err: unknown): void {
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: "conversation_not_found" });
    return;
  }
  console.error("request failed:", err instanceof Error ? err.message : err);
  res.status(500).json({ error: "internal_error" });
}

const app = express();
app.disable("x-powered-by");
// Behind Render's proxy, so req.ip is the caller rather than the proxy and the rate limit
// buckets per caller instead of lumping everyone together.
app.set("trust proxy", 1);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// The caller-facing voice page and the two public values it needs. Both are mounted before
// requireAuth below, which otherwise gates every remaining route: a caller has no bearer token.
// Only the *public* Vapi key is exposed here. VAPI_PRIVATE_KEY is account-scoped and never
// leaves the server.
// The page asks for a microphone, so the headers that matter are the ones bounding who may
// do that and who may frame the Start button: a framed page could be used to start calls the
// caller did not intend, which costs real money.
app.use((_req, res, next) => {
  res.setHeader("Permissions-Policy", "microphone=(self), camera=(), geolocation=()");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=31536000");
  next();
});

/**
 * A bound on how often one caller may hit the public routes.
 *
 * None of them can be guessed into, but all three reach the database on every request and
 * nothing else stands in front of them. In process and per instance, which matches how the
 * conversation lock already works here; a second instance would need shared state.
 */
/** The one address check, shared by every route that writes a contact email. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const PUBLIC_WINDOW_MS = 60_000;
const PUBLIC_MAX_REQUESTS = 30;
const publicHits = new Map<string, { count: number; resetAt: number }>();

function rateLimitPublic(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  const key = req.ip ?? "unknown";
  const seen = publicHits.get(key);
  if (!seen || seen.resetAt <= now) {
    publicHits.set(key, { count: 1, resetAt: now + PUBLIC_WINDOW_MS });
    // Dropping expired keys on write keeps the map from growing without a sweeper of its own.
    if (publicHits.size > 1000) {
      for (const [k, v] of publicHits) if (v.resetAt <= now) publicHits.delete(k);
    }
    next();
    return;
  }
  seen.count += 1;
  if (seen.count > PUBLIC_MAX_REQUESTS) {
    res.status(429).json({ error: "too_many_requests" });
    return;
  }
  next();
}

/**
 * The end-of-call check on the caller's own details.
 *
 * Both routes are public, because the caller's browser has no bearer token. What stands in for
 * one is the Vapi call id: an unguessable identifier that only the browser on that call holds.
 * Neither route reveals anything about a conversation that has no escalation, and the only
 * fields they return are the ones the caller gave us in the first place.
 */
/** The conversation a Vapi call id belongs to, or null. Shared by everything keyed on a call. */
const conversationForCall = async (callId: unknown) => {
  if (typeof callId !== "string" || !/^[0-9a-f-]{32,40}$/i.test(callId)) return null;
  const conv = await getDb()
    .from("conversations")
    .select("id,caller_timezone")
    .eq("vapi_call_id", callId)
    .maybeSingle();
  return conv.error || !conv.data ? null : conv.data;
};

/** The callback reserved on this call, read back in the caller's own timezone. */
const callBooking = async (conv: { id: string; caller_timezone: string | null }) => {
  const { data, error } = await getDb()
    .from("callback_bookings")
    .select("slot_start")
    .eq("conversation_id", conv.id)
    .eq("status", "booked")
    .maybeSingle();
  if (error || !data) return null;
  const slotStart = new Date(data.slot_start as string);
  return { slot_start: slotStart.toISOString(), reads_as: describeSlot(slotStart, conv.caller_timezone) };
};

const callEscalation = async (callId: unknown) => {
  const conv = await conversationForCall(callId);
  if (!conv) return null;
  const db = getDb();
  const esc = await db
    .from("escalations")
    .select("id,user_name,user_email,reason,case_reference,contact_confirmed_at,handoff_email_status")
    .eq("conversation_id", conv.id as string)
    .in("status", ["open", "in progress"])
    .maybeSingle();
  return esc.error || !esc.data ? null : esc.data;
};

/**
 * What the caller typed before the call, attached to the conversation once Vapi has created it.
 *
 * The browser posts this the moment the call connects, which can be before the server has seen
 * the call at all, so a miss is retried briefly rather than dropped: losing it would send the
 * agent back to asking for a spelling the caller already gave us.
 */
app.post("/call/details", rateLimitPublic, express.json({ limit: "4kb" }), async (req, res) => {
  const body = (req.body ?? {}) as { call_id?: unknown; name?: unknown; email?: unknown; timezone?: unknown };
  if (typeof body.call_id !== "string" || !/^[0-9a-f-]{32,40}$/i.test(body.call_id)) {
    res.status(400).json({ error: "bad_call_id" });
    return;
  }
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const name = str(body.name, 100);
  const email = str(body.email, 254).toLowerCase();
  if (name.length < 2 || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "invalid_details" });
    return;
  }
  // IANA zones only, so what reaches the record can be read back as a time.
  const zone = str(body.timezone, 64);
  const timezone = /^[A-Za-z]+\/[A-Za-z_+-]+(\/[A-Za-z_+-]+)?$/.test(zone) ? zone : null;

  const db = getDb();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const { data } = await db
      .from("conversations")
      .update({ caller_name: name, caller_email: email, caller_timezone: timezone })
      .eq("vapi_call_id", body.call_id)
      .select("id");
    if ((data ?? []).length > 0) {
      res.json({ ok: true });
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  // The call never reached us. The agent falls back to asking by voice, which still works.
  res.status(404).json({ error: "no_conversation" });
});

app.get("/escalation/draft", rateLimitPublic, async (req, res) => {
  const conv = await conversationForCall(req.query.call_id);
  const [row, callback] = conv
    ? await Promise.all([callEscalation(req.query.call_id), callBooking(conv)])
    : [null, null];
  // The same answer whether the call is unknown or simply had nothing to show: distinguishing
  // them would say whether a given call id exists. A booking alone is worth showing, because a
  // time agreed by voice is exactly the thing a caller wants to see written down.
  if (!row && !callback) {
    res.status(404).json({ error: "no_escalation" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json(draftPayload(row, callback));
});

app.post("/escalation/confirm", rateLimitPublic, express.json({ limit: "4kb" }), async (req, res) => {
  const body = (req.body ?? {}) as { call_id?: unknown; name?: unknown; email?: unknown };
  const row = await callEscalation(body.call_id);
  if (!row) {
    res.status(404).json({ error: "no_escalation" });
    return;
  }
  // Once the brief has gone out, the recorded address is the one support actually received it
  // at. Rewriting it afterwards would leave the row describing a delivery that never happened.
  if (row.handoff_email_status === "sent") {
    res.status(409).json({ error: "already_sent" });
    return;
  }
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 100) : "";
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase().slice(0, 254) : "";
  // The same check the escalation tool applies, because this writes the same two fields.
  if (name.length < 2 || !EMAIL_RE.test(email)) {
    res.status(400).json({ error: "invalid_details" });
    return;
  }
  const { error } = await getDb()
    .from("escalations")
    .update({ user_name: name, user_email: email, contact_confirmed_at: new Date().toISOString() })
    .eq("id", row.id as string);
  if (error) {
    res.status(500).json({ error: "could_not_save" });
    return;
  }
  res.json({ ok: true });
});

app.use(express.static(fileURLToPath(new URL("../../public", import.meta.url)), {
  dotfiles: "deny",
  index: ["index.html"],
  redirect: false,
}));

app.get("/config", rateLimitPublic, (_req, res) => {
  // Not cached: a value fixed at an edge would outlive a key rotation.
  res.setHeader("Cache-Control", "no-store");
  res.json({
    publicKey: process.env.VAPI_PUBLIC_KEY ?? "",
    assistantId: process.env.VAPI_ASSISTANT_ID ?? "",
  });
});

// Vapi authenticates with the same bearer secret, set on the assistant's custom-LLM config and
// its server URL. Mounted before the JSON parser so each route sets its own body limit.
/**
 * What the support team sees. Behind the bearer token, unlike the caller-facing routes: this
 * returns the names, addresses and problems of real customers, so an unguessable call id is
 * not enough protection here.
 */
app.get("/admin/escalations", requireAuth, async (_req, res) => {
  const db = getDb();
  const { data, error } = await db
    .from("escalations")
    .select(
      "id,created_at,user_name,user_email,category,reason,status,case_reference,preferred_time,contact_confirmed_at,handoff_email_status,handoff_email_error,conversation_id",
    )
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    res.status(500).json({ error: "could_not_read" });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  res.json({
    escalations: (data ?? []).map((e) => ({
      ...e,
      // Split back into the issues the caller actually raised, rather than one block of text.
      issues: String(e.reason ?? "").split("\n").filter(Boolean),
    })),
    callbacks: await upcomingCallbacks(),
  });
});

/**
 * The callbacks support still has to make, soonest first.
 *
 * This is a rota, not a queue: it is ordered by when the call is due rather than when it was
 * booked, because a booking made this morning for next week matters less than one made last week
 * for this afternoon. Times just gone are kept for an hour so a missed one stays visible.
 */
async function upcomingCallbacks() {
  const db = getDb();
  const since = new Date(Date.now() - 60 * 60_000).toISOString();
  const { data, error } = await db
    .from("callback_bookings")
    .select("id,slot_start,slot_end,caller_timezone,conversation_id,escalation_id")
    .eq("status", "booked")
    .gte("slot_start", since)
    .order("slot_start", { ascending: true })
    .limit(100);
  if (error || !data?.length) return [];

  const ids = [...new Set(data.map((b) => b.conversation_id as string))];
  const convs = await db.from("conversations").select("id,caller_name").in("id", ids);
  const nameById = new Map((convs.data ?? []).map((c) => [c.id as string, (c.caller_name as string | null) ?? null]));

  return data.map((b) => {
    const slot = new Date(b.slot_start as string);
    return {
      ...b,
      caller_name: nameById.get(b.conversation_id as string) ?? null,
      // Support reads this, so it is in support's own hours. The caller's zone rides alongside
      // so whoever rings knows what time it is where the phone is ringing.
      reads_as: describeSlot(slot, SUPPORT_TIMEZONE),
      caller_reads_as: describeSlot(slot, (b.caller_timezone as string | null) ?? null),
    };
  });
}

app.use(requireAuth, vapiRouter());

/**
 * Plain-text endpoint over the same handler Vapi will use. Voice cannot be scripted, so this is
 * how every scenario runs headless and how the evaluation set is filled. Conversations created
 * here are test conversations unless the caller says otherwise, so they never send real email.
 */
app.post("/chat", requireAuth, express.json({ limit: "20kb" }), async (req, res) => {
  const body = (req.body ?? {}) as { conversation_id?: unknown; message?: unknown; test?: unknown };
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length < 1 || message.length > MAX_MESSAGE_CHARS) {
    res.status(400).json({ error: `message must be 1 to ${MAX_MESSAGE_CHARS} characters` });
    return;
  }
  if (body.conversation_id !== undefined && (typeof body.conversation_id !== "string" || !UUID.test(body.conversation_id))) {
    res.status(400).json({ error: "conversation_id must be a UUID" });
    return;
  }
  try {
    const conversationId =
      (body.conversation_id as string | undefined) ??
      (await createConversation({ channel: "text", isTest: body.test !== false, callerIdentifier: "text-endpoint" }));
    const r = await handleTurn({ conversationId, text: message });
    res.json({
      conversation_id: r.conversationId,
      reply: r.reply,
      answer_type: r.answerType,
      ended: r.ended,
      escalation_created: r.escalationCreated,
      speech_guard_tripped: r.guardTripped,
      speech_guard_reasons: r.guardReasons,
      tool_calls: r.toolCalls,
      agent_ms: r.agentMs,
      ms: r.ms,
    });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/chat/end", requireAuth, express.json({ limit: "2kb" }), async (req, res) => {
  const id = (req.body as { conversation_id?: unknown } | undefined)?.conversation_id;
  if (typeof id !== "string" || !UUID.test(id)) {
    res.status(400).json({ error: "conversation_id must be a UUID" });
    return;
  }
  try {
    res.json({ conversation_id: id, final_status: await endConversation(id) });
  } catch (err) {
    fail(res, err);
  }
});

/**
 * The sweep runs on a timer here and is also callable, so a lost end-of-call webhook or a caller
 * who simply hangs up cannot leave a conversation open forever. It is safe to run concurrently.
 */
app.post("/admin/sweep", requireAuth, async (_req, res) => {
  try {
    res.json(await sweepStaleConversations());
  } catch (err) {
    fail(res, err);
  }
});

const sweepTimer = setInterval(() => {
  void sweepStaleConversations().catch((err) => console.error("sweep failed:", err instanceof Error ? err.message : err));
}, 5 * 60_000);
sweepTimer.unref();

// Separate from the conversation sweep and far more frequent: the caller has been told a
// representative will follow up, and every minute the brief sits undelivered is a minute that
// promise is not yet true. Runs once at startup so a restart flushes anything left behind.
const emailFailed = (err: unknown) =>
  console.error("handoff email sweep failed:", err instanceof Error ? err.message : err);
const emailTimer = setInterval(() => void dispatchHandoffEmails().catch(emailFailed), 60_000);
emailTimer.unref();
void dispatchHandoffEmails().catch(emailFailed);

// A malformed body must never return Express's default page, which can carry a stack trace.
app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ error: "bad_request" });
});

const port = Number(process.env.PORT ?? process.env.AGENT_PORT ?? 3002);
const host = process.env.HOST ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
app.listen(port, host, () => {
  console.log(`agent server listening on http://${host}:${port}`);
});
