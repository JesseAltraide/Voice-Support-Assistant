import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { getDb, requireEnv } from "../shared/db.js";
import { agentAuthToken, mcpAuthToken } from "./config.js";
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

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Vapi authenticates with the same bearer secret, set on the assistant's custom-LLM config and
// its server URL. Mounted before the JSON parser so each route sets its own body limit.
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

// A malformed body must never return Express's default page, which can carry a stack trace.
app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ error: "bad_request" });
});

const port = Number(process.env.PORT ?? process.env.AGENT_PORT ?? 3002);
const host = process.env.HOST ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
app.listen(port, host, () => {
  console.log(`agent server listening on http://${host}:${port}`);
});
