import { createHash } from "node:crypto";
import { addEvent } from "../mcp/events.js";
import { getDb } from "../shared/db.js";
import { withRetry } from "../shared/retry.js";
import { config } from "./config.js";
import { deriveFinalStatus, type ConversationStatus } from "./final-status.js";
import type { AnswerType } from "./turn-type.js";

const db = () => getDb();
const UNIQUE_VIOLATION = "23505";

export interface ConversationState {
  id: string;
  status: string;
  channel: string;
  is_test: boolean;
  linked_customer_id: string | null;
  unresolved_count: number;
  handoff_offers_made: number;
  failed_lookup_count: number;
  clarify_streak: number;
  turn_count: number;
  started_at: string;
  ended_at: string | null;
  /** Typed on the form before a web call. Null on a phone call, which has no form. */
  caller_name: string | null;
  caller_email: string | null;
}

const STATE_COLUMNS =
  "id,status,channel,is_test,linked_customer_id,unresolved_count,handoff_offers_made,failed_lookup_count,clarify_streak,turn_count,started_at,ended_at,caller_name,caller_email";

function must<T>(result: { data: T; error: { message: string } | null }, what: string): NonNullable<T> {
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  if (result.data === null || result.data === undefined) throw new Error(`${what}: no row returned`);
  return result.data as NonNullable<T>;
}

function check(error: { message: string } | null, what: string): void {
  if (error) throw new Error(`${what}: ${error.message}`);
}

/** A retried Vapi request for the same call returns the same conversation instead of a second one. */
export async function createConversation(p: {
  channel: "voice" | "text";
  isTest: boolean;
  callerIdentifier?: string | null;
  vapiCallId?: string | null;
}): Promise<string> {
  if (p.vapiCallId) {
    const { data } = await db().from("conversations").select("id").eq("vapi_call_id", p.vapiCallId).maybeSingle();
    if (data) return data.id as string;
  }
  const { data, error } = await db()
    .from("conversations")
    .insert({ channel: p.channel, is_test: p.isTest, caller_identifier: p.callerIdentifier ?? null, vapi_call_id: p.vapiCallId ?? null })
    .select("id")
    .single();
  if (error?.code === UNIQUE_VIOLATION && p.vapiCallId) {
    const { data: raced } = await db().from("conversations").select("id").eq("vapi_call_id", p.vapiCallId).single();
    if (raced) return raced.id as string;
  }
  return must({ data, error }, "create conversation").id as string;
}

// The reads and writes a turn cannot proceed without are retried past a transient network blip.
export async function getConversation(id: string): Promise<ConversationState | null> {
  const { data, error } = await withRetry(async () => db().from("conversations").select(STATE_COLUMNS).eq("id", id).maybeSingle());
  check(error, "get conversation");
  return (data as ConversationState | null) ?? null;
}

export async function openTurn(conversationId: string, userTranscript: string): Promise<{ id: string; createdAt: string }> {
  const row = must(
    await withRetry(async () =>
      db().from("conversation_turns").insert({ conversation_id: conversationId, user_transcript: userTranscript.slice(0, 2000) }).select("id,created_at").single(),
    ),
    "open turn",
  );
  return { id: row.id as string, createdAt: row.created_at as string };
}

export async function completeTurn(
  turnId: string,
  p: { assistant: string; answerType: AnswerType | null; note: string | null; guardTripped: boolean },
): Promise<void> {
  const { error } = await withRetry(async () =>
    db()
    .from("conversation_turns")
    .update({
      assistant_response: p.assistant,
      answer_type: p.answerType,
      uncertainty_note: p.note?.slice(0, 500) ?? null,
      speech_guard_tripped: p.guardTripped,
      completed_at: new Date().toISOString(),
    })
    .eq("id", turnId),
  );
  check(error, "complete turn");
}

/** The most recent answer types, newest first, for detecting a run of turns that made no progress. */
export async function recentAnswerTypes(conversationId: string, limit: number): Promise<string[]> {
  const { data, error } = await db()
    .from("conversation_turns")
    .select("answer_type")
    .eq("conversation_id", conversationId)
    .not("answer_type", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  check(error, "recent answer types");
  return (data ?? []).map((r) => r.answer_type as string);
}

export interface RecentTurn {
  answerType: string | null;
  guardTripped: boolean;
  assistant: string | null;
}

/** Recent turns, newest first, with enough detail to see a run of failed recovery attempts. */
export async function recentTurns(conversationId: string, limit: number): Promise<RecentTurn[]> {
  const { data, error } = await db()
    .from("conversation_turns")
    .select("answer_type,speech_guard_tripped,assistant_response")
    .eq("conversation_id", conversationId)
    .not("answer_type", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  check(error, "recent turns");
  return (data ?? []).map((r) => ({
    answerType: r.answer_type as string | null,
    guardTripped: r.speech_guard_tripped === true,
    assistant: (r.assistant_response as string | null) ?? null,
  }));
}

/** Only turns the caller actually got an answer to. A turn abandoned mid-flight has no answer type. */
export async function answeredCallerTexts(conversationId: string): Promise<string[]> {
  const { data, error } = await db()
    .from("conversation_turns")
    .select("user_transcript")
    .eq("conversation_id", conversationId)
    .not("answer_type", "is", null)
    .order("created_at", { ascending: true });
  check(error, "answered caller texts");
  return (data ?? []).map((r) => r.user_transcript as string);
}

export async function callerTexts(conversationId: string): Promise<string[]> {
  const { data, error } = await db()
    .from("conversation_turns")
    .select("user_transcript")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });
  check(error, "caller texts");
  return (data ?? []).map((r) => r.user_transcript as string);
}

export async function recentExchanges(conversationId: string, limit: number): Promise<Array<{ user: string; assistant: string | null }>> {
  const { data, error } = await db()
    .from("conversation_turns")
    .select("user_transcript,assistant_response")
    .eq("conversation_id", conversationId)
    .not("assistant_response", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  check(error, "recent exchanges");
  return (data ?? []).reverse().map((r) => ({ user: r.user_transcript as string, assistant: r.assistant_response as string | null }));
}

async function countRows(table: "escalations" | "support_tickets", conversationId: string): Promise<number> {
  const { count, error } = await db().from(table).select("*", { count: "exact", head: true }).eq("conversation_id", conversationId);
  check(error, `count ${table}`);
  return count ?? 0;
}

export async function hasEscalation(conversationId: string): Promise<boolean> {
  return (await countRows("escalations", conversationId)) > 0;
}

/** Which records actually exist, so a claim in a reply can be checked against a fact. */
export async function recordFlags(
  conversationId: string,
): Promise<{ escalationExists: boolean; ticketExists: boolean; callbackBooked: boolean }> {
  const [escalations, tickets, callbacks] = await Promise.all([
    countRows("escalations", conversationId),
    countRows("support_tickets", conversationId),
    // Status matters here in a way it does not for the others: a cancelled booking must not
    // leave the agent free to keep saying a callback is arranged.
    (async () => {
      const { count, error } = await db()
        .from("callback_bookings")
        .select("*", { count: "exact", head: true })
        .eq("conversation_id", conversationId)
        .eq("status", "booked");
      check(error, "count callback_bookings");
      return count ?? 0;
    })(),
  ]);
  return { escalationExists: escalations > 0, ticketExists: tickets > 0, callbackBooked: callbacks > 0 };
}

let namesCache: { at: number; names: string[] } | null = null;

/** Names from customer and payout records, for the speech guard. Cached briefly. */
export async function loadForbiddenNames(): Promise<string[]> {
  if (namesCache && Date.now() - namesCache.at < config.forbiddenNamesTtlMs) return namesCache.names;
  const [customers, payouts] = await Promise.all([
    db().from("customers").select("company_name,contact_name"),
    db().from("payouts").select("recipient_name"),
  ]).catch((err) => {
    // These names only feed the speech guard. A stale list is far better than failing the turn,
    // and an empty one would silently weaken the guard, so the previous list is reused.
    if (namesCache) return [{ data: null, error: err }, { data: null, error: err }] as const;
    throw err;
  });
  if (customers.error || payouts.error) {
    if (namesCache) {
      console.error("using stale forbidden-name cache:", customers.error?.message ?? payouts.error?.message);
      return namesCache.names;
    }
    check(customers.error, "load customer names");
    check(payouts.error, "load recipient names");
  }
  const names = new Set<string>();
  for (const c of customers.data ?? []) {
    names.add(c.company_name as string);
    names.add(c.contact_name as string);
  }
  for (const p of payouts.data ?? []) if (p.recipient_name) names.add(p.recipient_name as string);
  namesCache = { at: Date.now(), names: [...names].filter((n) => n && n.trim().length >= 3) };
  return namesCache.names;
}

export async function setStatus(conversationId: string, status: ConversationStatus): Promise<void> {
  const { error } = await db().from("conversations").update({ status }).eq("id", conversationId).is("ended_at", null);
  check(error, "set status");
}

export async function resetClarifyStreak(conversationId: string): Promise<void> {
  const { error } = await db().from("conversations").update({ clarify_streak: 0 }).eq("id", conversationId);
  check(error, "reset clarify streak");
}

/** Tool calls run under a per-conversation header, so link them to the turn by their time window. */
export async function attachTurnRecords(conversationId: string, turnId: string, sinceIso: string): Promise<void> {
  const results = await Promise.all(
    (["tool_calls", "retrieval_logs"] as const).map((table) =>
      db().from(table).update({ turn_id: turnId }).eq("conversation_id", conversationId).is("turn_id", null).gte("created_at", sinceIso),
    ),
  );
  for (const r of results) check(r.error, "attach turn records");
}

/**
 * The failure path is written by the server, not the agent, so it works when the agent is what
 * failed: an event, the error status, and a ticket so the caller's issue is not lost.
 */
export async function failConversation(conversationId: string, reason: string): Promise<boolean> {
  const summary = "Automatic ticket: the support assistant failed during this call. The caller's request may not have been handled.";
  // The ticket comes first and is retried: it is the thing that makes the spoken apology true.
  // The event and the status are best-effort around it, so neither can stop the ticket landing.
  let logged = false;
  try {
    const { error } = await withRetry(async () =>
      db().from("support_tickets").insert({
        conversation_id: conversationId,
        customer_id: null,
        category: "other",
        priority: "high",
        summary,
        summary_hash: createHash("sha256").update(summary.toLowerCase()).digest("hex").slice(0, 32),
      }),
    );
    logged = !error || error.code === UNIQUE_VIOLATION;
    if (error && error.code !== UNIQUE_VIOLATION) console.error(`failure ticket: ${error.message}`);
  } catch (err) {
    console.error("failure ticket could not be written:", err instanceof Error ? err.message : err);
  }
  await addEvent(db(), conversationId, "failure", "agent failed during the call", { reason: reason.slice(0, 300) }).catch(() => {});
  await setStatus(conversationId, "error").catch(() => {});
  return logged;
}

/**
 * The tool server is unreachable, so the agent cannot look anything up, search approved knowledge
 * or create an escalation. The server writes the ticket on its own database connection, which is a
 * different dependency, so the caller can still be told something true.
 */
export async function logDependencyFailure(conversationId: string, reason: string): Promise<boolean> {
  const summary = `Automatic ticket: the support assistant could not reach its tools during this call (${reason.slice(0, 120)}). The caller's request was not handled.`;
  try {
    const { error } = await withRetry(async () =>
      db().from("support_tickets").insert({
        conversation_id: conversationId,
        customer_id: null,
        category: "other",
        priority: "high",
        summary,
        summary_hash: createHash("sha256").update(summary.toLowerCase()).digest("hex").slice(0, 32),
      }),
    );
    if (error && error.code !== UNIQUE_VIOLATION) {
      console.error(`dependency ticket: ${error.message}`);
      return false;
    }
  } catch (err) {
    console.error("dependency ticket could not be written:", err instanceof Error ? err.message : err);
    return false;
  }
  await addEvent(db(), conversationId, "failure", "tool server unreachable", { reason: reason.slice(0, 300) }).catch(() => {});
  return true;
}

const ABANDONED_SUMMARY =
  "Automatic ticket: the caller was asked for their contact details for a specialist follow-up and the call ended before giving them. The conversation transcript has what they asked about.";

/**
 * Claim before acting: the status is moved off `collecting_details` conditionally, so only the
 * caller that actually changed the row writes the ticket. Two closes racing produce one ticket.
 * If the ticket write fails the claim is rolled back, so the next attempt tries again rather than
 * leaving the intent silently dropped.
 */
export async function ticketAbandoned(conversationId: string): Promise<boolean> {
  const { data: claimed, error: claimError } = await db()
    .from("conversations")
    .update({ status: "abandoned" })
    .eq("id", conversationId)
    .eq("status", "collecting_details")
    .select("id,linked_customer_id");
  if (claimError) throw new Error(`abandon claim: ${claimError.message}`);
  if (!claimed || claimed.length === 0) return false;

  try {
    const { error } = await withRetry(async () =>
      db().from("support_tickets").insert({
        conversation_id: conversationId,
        customer_id: (claimed[0]?.linked_customer_id as string | null) ?? null,
        category: "other",
        priority: "high",
        summary: ABANDONED_SUMMARY,
        summary_hash: createHash("sha256").update(ABANDONED_SUMMARY.toLowerCase()).digest("hex").slice(0, 32),
      }),
    );
    if (error && error.code !== UNIQUE_VIOLATION) throw new Error(error.message);
  } catch (err) {
    // Release the claim: a claim that fails silently discards the job forever.
    await db().from("conversations").update({ status: "collecting_details" }).eq("id", conversationId).eq("status", "abandoned");
    console.error("abandoned ticket failed, claim released:", err instanceof Error ? err.message : err);
    return false;
  }
  await addEvent(db(), conversationId, "state_change", "call ended while collecting details; ticket raised");
  return true;
}

/** Idempotent. Final status comes from the records that exist (see final-status.ts). */
export async function closeConversation(conversationId: string): Promise<ConversationStatus> {
  const conv = await getConversation(conversationId);
  if (!conv) throw new Error("conversation not found");
  if (conv.ended_at) return conv.status as ConversationStatus;

  // A caller who hangs up while giving their contact details has already told us what they need.
  // Ticketing here, rather than only in the sweep, covers the normal hangup: the sweep only ever
  // sees conversations that are still open, so a closed one would never be ticketed at all.
  if (conv.status === "collecting_details") await ticketAbandoned(conversationId);

  const [escalations, tickets, lastTurn, turns] = await Promise.all([
    countRows("escalations", conversationId),
    countRows("support_tickets", conversationId),
    db().from("conversation_turns").select("answer_type").eq("conversation_id", conversationId).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db().from("conversation_turns").select("user_transcript").eq("conversation_id", conversationId).order("created_at", { ascending: true }),
  ]);
  check(lastTurn.error, "last turn");
  check(turns.error, "turns");

  const asked = (turns.data ?? []).map((t) => t.user_transcript as string);
  const status = deriveFinalStatus({
    escalations,
    tickets,
    turns: asked.length,
    lastAnswerType: (lastTurn.data?.answer_type as string | null | undefined) ?? null,
    currentStatus: conv.status,
  });
  // Templated from the records, so a failed model call can never block closing a conversation.
  const topics = asked.slice(0, 3).map((t) => `"${t.replace(/\s+/g, " ").slice(0, 80)}"`).join("; ");
  const summary = `${asked.length} turn(s). Outcome: ${status}. Escalations: ${escalations}. Tickets: ${tickets}. Unresolved: ${conv.unresolved_count}.${topics ? ` Asked about: ${topics}.` : ""}`;

  const { error } = await db()
    .from("conversations")
    .update({ status, summary, ended_at: new Date().toISOString() })
    .eq("id", conversationId)
    .is("ended_at", null);
  check(error, "close conversation");
  await addEvent(db(), conversationId, "state_change", `conversation closed: ${status}`);
  return status;
}
