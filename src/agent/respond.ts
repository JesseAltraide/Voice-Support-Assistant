import { addEvent } from "../mcp/events.js";
import { bump } from "../mcp/instrument.js";
import { getDb } from "../shared/db.js";
import { config } from "./config.js";
import { extractFacts } from "./facts.js";
import {
  checkReply, DIDNT_CATCH, ERROR_FALLBACK, ERROR_FALLBACK_UNLOGGED, ESCALATED_FALLBACK, NO_PROGRESS_CLOSE,
  OFF_TOPIC_LINE, SAFE_FALLBACK, STATE_YOUR_PROBLEM, STILL_DIDNT_CATCH, TOOLS_DOWN_FALLBACK,
} from "./guard.js";
import { classifyInput, isRepeatQuestion } from "./caller-input.js";
import { mcpHealthy } from "./mcp-health.js";
import { buildNotes } from "./notes.js";
import { callerMessage, escapeCaller, LOOKUP_FIRST_NOTE, mentionsReference, WORK_FIRST_NOTE } from "./prompt.js";
import { AgentSession, type RawTurn } from "./session.js";
import * as store from "./store.js";
import { deriveAnswerType, needsWorkFirst, parseTypedReply, unresolvedIncrement, type AnswerType } from "./turn-type.js";

export class NotFoundError extends Error {}

export interface TurnRequest {
  conversationId: string;
  text: string;
  /** False once the caller has gone (interrupted, hung up), so the reply will never be heard. */
  isDelivered?: () => boolean;
}

export interface TurnResult {
  conversationId: string;
  reply: string;
  answerType: AnswerType;
  ended: boolean;
  guardTripped: boolean;
  guardReasons: string[];
  escalationCreated: boolean;
  toolCalls: number;
  /** Time spent inside the agent session only; the rest of `ms` is database work around it. */
  agentMs: number;
  ms: number;
}

const ENDED_REPLY = "This call has ended. Thank you for calling RelayPay.";
const REBUILD_EXCHANGES = 6;
const CONTEXT_CLIP = 160;

const log = (what: string) => (err: unknown) => console.error(`${what}:`, err instanceof Error ? err.message : err);

// ---- sessions: one long-lived Agent SDK session per call, discarded when idle --------------

const sessions = new Map<string, AgentSession>();

function sessionFor(id: string): { session: AgentSession; isNew: boolean } {
  const existing = sessions.get(id);
  if (existing && !existing.dead) return { session: existing, isNew: false };
  const session = new AgentSession(id);
  sessions.set(id, session);
  return { session, isNew: true };
}

/**
 * Start the model session while the caller is still hearing the greeting. The first turn cost 7 to
 * 12 seconds cold and 1.5 to 2.6 warm, so this is the difference between a natural opening and a
 * long silence. Safe to call more than once; failures are ignored because it is only an optimisation.
 */
export function warmSession(conversationId: string): void {
  try {
    sessionFor(conversationId);
  } catch (err) {
    console.error("warm failed:", err instanceof Error ? err.message : err);
  }
}

export async function disposeSession(id: string): Promise<void> {
  const s = sessions.get(id);
  sessions.delete(id);
  await s?.close();
}

const idleSweep = setInterval(() => {
  for (const [id, s] of sessions) if (s.dead || Date.now() - s.lastUsed > config.sessionIdleMs) void disposeSession(id);
}, 60_000);
idleSweep.unref();

// ---- one turn at a time per conversation: Vapi can send the next request before the last ends ----

const locks = new Map<string, Promise<void>>();

function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const next = (locks.get(id) ?? Promise.resolve()).then(fn);
  const settled = next.then(() => undefined, () => undefined);
  locks.set(id, settled);
  void settled.then(() => {
    if (locks.get(id) === settled) locks.delete(id);
  });
  return next;
}

// ---- the turn ---------------------------------------------------------------------------

/** A session that had to be recreated (restart, idle timeout, earlier failure) is refilled from stored turns. */
async function rebuildNote(conversationId: string): Promise<string> {
  const clip = (s: string) => escapeCaller(s).slice(0, CONTEXT_CLIP);
  const exchanges = await store.recentExchanges(conversationId, REBUILD_EXCHANGES);
  const lines = exchanges.map((e) => `caller said "${clip(e.user)}"; you replied "${clip(e.assistant ?? "")}"`);
  return `Earlier in this call, for context only: ${lines.join(" | ")}`;
}

async function failTurn(conversationId: string, turnId: string | null, err: unknown, started: number): Promise<TurnResult> {
  const reason = err instanceof Error ? err.message : String(err);
  // Logged to stdout as well as to the turn row. The row is the audit trail, but it is no use when
  // the database is the thing that failed, and an operator reading platform logs would otherwise
  // see a call fail with no line explaining why.
  console.error(`turn failed for conversation ${conversationId}:`, reason);
  // Written by the server, not the agent. The ticket is attempted first and the spoken line follows
  // what actually landed: if the database is what failed, the apology does not claim it was logged.
  const logged = await store.failConversation(conversationId, reason).catch(() => {
    log("failConversation")(err);
    return false;
  });
  const reply = logged ? ERROR_FALLBACK : ERROR_FALLBACK_UNLOGGED;
  if (turnId) {
    await store.completeTurn(turnId, { assistant: reply, answerType: "error", note: reason, guardTripped: false }).catch(log("completeTurn"));
  }
  await store.closeConversation(conversationId).catch(log("closeConversation"));
  await disposeSession(conversationId);
  return {
    conversationId, reply, answerType: "error", ended: true, guardTripped: false,
    guardReasons: [], escalationCreated: false, toolCalls: 0, agentMs: 0, ms: Date.now() - started,
  };
}

function fallbackFor(escalationCreated: boolean): string {
  return escalationCreated ? ESCALATED_FALLBACK : SAFE_FALLBACK;
}

/** A turn where real support work happened, so the call has gone somewhere. */
const SUBSTANTIVE = new Set(["answer_directly", "decline", "escalate", "clarify"]);

const countTrailing = (types: string[], match: string): number => {
  let n = 0;
  for (const t of types) {
    if (t !== match) break;
    n += 1;
  }
  return n;
};

/**
 * A turn the model is never asked to handle: unintelligible audio, or a caller who keeps greeting
 * without getting to a question. The reply is fixed text, so it costs no tokens and cannot say
 * anything unsafe, and the turn is still recorded like any other.
 */
async function codeOwnedTurn(
  conversationId: string,
  transcript: string,
  p: { reply: string; answerType: AnswerType; note: string; countsUnresolved: boolean; ended?: boolean; started: number },
): Promise<TurnResult> {
  const turn = await store.openTurn(conversationId, transcript);
  await Promise.allSettled([
    store.completeTurn(turn.id, { assistant: p.reply, answerType: p.answerType, note: p.note, guardTripped: false }),
    bump(getDb(), conversationId, "turn_count"),
    p.countsUnresolved ? bump(getDb(), conversationId, "unresolved_count") : undefined,
  ]);
  if (p.ended) {
    await store.closeConversation(conversationId).catch(log("closeConversation"));
    await disposeSession(conversationId);
  }
  return {
    conversationId, reply: p.reply, answerType: p.answerType, ended: p.ended === true, guardTripped: false,
    guardReasons: [], escalationCreated: false, toolCalls: 0, agentMs: 0, ms: Date.now() - p.started,
  };
}

/**
 * The tool server is unreachable, so the agent has no knowledge search, no lookups and no way to
 * create an escalation. Rather than let it answer from its own memory or offer a handoff it cannot
 * keep, the server writes the ticket on its own database connection — a different dependency — and
 * ends the call with something true.
 */
async function dependencyFailure(
  conversationId: string,
  turnId: string,
  reason: string,
  toolCalls: number,
  agentStarted: number,
  started: number,
): Promise<TurnResult> {
  const logged = await store.logDependencyFailure(conversationId, reason).catch(() => false);
  const reply = logged ? TOOLS_DOWN_FALLBACK : ERROR_FALLBACK_UNLOGGED;
  await store
    .completeTurn(turnId, { assistant: reply, answerType: "error", note: `tool server unreachable: ${reason}`, guardTripped: false })
    .catch(log("completeTurn"));
  await store.closeConversation(conversationId).catch(log("closeConversation"));
  await disposeSession(conversationId);
  return {
    conversationId, reply, answerType: "error", ended: true, guardTripped: false, guardReasons: [],
    escalationCreated: false, toolCalls, agentMs: Date.now() - agentStarted, ms: Date.now() - started,
  };
}

async function runTurn(p: TurnRequest): Promise<TurnResult> {
  const started = Date.now();
  const id = p.conversationId;
  const conv = await store.getConversation(id);
  if (!conv) throw new NotFoundError("conversation not found");
  if (conv.ended_at) {
    return {
      conversationId: id, reply: ENDED_REPLY, answerType: "conversational", ended: true, guardTripped: false,
      guardReasons: [], escalationCreated: false, toolCalls: 0, agentMs: 0, ms: Date.now() - started,
    };
  }

  // Judged before the model runs: noise costs nothing to answer, and a caller who never gets to a
  // question should not keep a metered call open.
  // Repeat detection compares only against turns the caller actually heard an answer to.
  const [recentTypes, priorForRepeat] = await Promise.all([store.recentAnswerTypes(id, 20), store.answeredCallerTexts(id)]);
  const input = classifyInput(p.text);
  if (input.kind !== "ok") {
    const streak = countTrailing(recentTypes, "unintelligible") + 1;
    return codeOwnedTurn(id, p.text, {
      reply: streak >= 2 ? STILL_DIDNT_CATCH : DIDNT_CATCH,
      answerType: "unintelligible",
      note: `caller input was ${input.kind}; consecutive ${streak}`,
      countsUnresolved: streak >= 2,
      started,
    });
  }

  const [turn, prior, recordsBefore, names] = await Promise.all([
    store.openTurn(id, p.text),
    store.callerTexts(id),
    store.recordFlags(id),
    store.loadForbiddenNames(),
  ]);
  const escalated = recordsBefore.escalationExists;
  const callerAll = [...prior, p.text];

  const { notes, offerMade } = buildNotes({
    unresolved: conv.unresolved_count,
    offersMade: conv.handoff_offers_made,
    failedLookups: conv.failed_lookup_count,
    clarifyStreak: conv.clarify_streak,
    turnCount: conv.turn_count,
    elapsedMs: Date.now() - Date.parse(conv.started_at),
    escalationExists: escalated,
  });

  // One budget for the whole turn, including any repair. Per-call timeouts let a repaired turn
  // run to roughly double the limit, which on a call is twice the silence.
  const turnDeadline = started + config.turnTimeoutMs;
  const remaining = () => Math.max(1000, turnDeadline - Date.now());

  // Checked before the model is called: with the tools gone there is nothing useful it can do, and
  // a wasted round trip is wasted silence on a call.
  if (!(await mcpHealthy())) {
    return dependencyFailure(id, turn.id, "tool server did not answer its health check", 0, started, started);
  }

  const { session, isNew } = sessionFor(id);
  // Losing the recap only costs the agent context; it must never cost the caller the turn.
  const context = isNew && conv.turn_count > 0 ? [await rebuildNote(id).catch(() => "")].filter(Boolean) : [];
  let raw: RawTurn;
  const agentStarted = Date.now();
  try {
    raw = await session.ask(callerMessage(p.text, [...context, ...notes]), remaining());
  } catch (err) {
    sessions.delete(id);
    return failTurn(id, turn.id, err, started);
  }

  let parsed = parseTypedReply(raw.text);
  let extracted = extractFacts(raw.toolResults);
  let derived = deriveAnswerType(parsed.type, extracted.facts);

  // Rule 2: a bare first clarifying question is sent back once, so the caller gets the work first.
  let repaired = false;
  // Repairing costs another model round trip, so it is skipped when the turn is nearly out of time.
  if (
    remaining() > config.repairMinRemainingMs &&
    needsWorkFirst({ type: derived.type, toolCallCount: raw.toolCallCount, clarifyStreakBefore: conv.clarify_streak })
  ) {
    repaired = true;
    try {
      const repairNote = mentionsReference(p.text) ? LOOKUP_FIRST_NOTE : WORK_FIRST_NOTE;
      raw = await session.ask(callerMessage(p.text, [...notes, repairNote]), remaining());
    } catch (err) {
      sessions.delete(id);
      return failTurn(id, turn.id, err, started);
    }
    parsed = parseTypedReply(raw.text);
    extracted = extractFacts(raw.toolResults);
    derived = deriveAnswerType(parsed.type, extracted.facts);
  }
  const { facts, groundedTexts } = extracted;
  // Claims are checked against records that exist now, including any this turn just created.
  const records = {
    escalationExists: recordsBefore.escalationExists || facts.escalationCreated,
    ticketExists: recordsBefore.ticketExists || raw.toolResults.some((r) => !r.isError && typeof r.data?.ticket_id === "string"),
  };
  if (extracted.facts.toolsFailed) {
    return dependencyFailure(id, turn.id, "all tool calls failed", raw.toolCallCount, agentStarted, started);
  }
  // A fixed, code-owned line is spoken as-is: there is nothing for the guard to police, and the
  // caller hears the same safe wording every time.
  const codeOwned = derived.type === "off_topic" ? OFF_TOPIC_LINE : null;
  const guard = codeOwned
    ? { ok: true, reasons: [] as string[] }
    : checkReply({ reply: parsed.text, callerTexts: callerAll, groundedTexts, forbiddenNames: names, records });

  let spoken = codeOwned ?? parsed.text;
  let answerType: AnswerType = derived.type;
  let note: string | null = derived.note ?? null;
  if (repaired) note = `${note ? `${note}. ` : ""}first reply asked without doing any work; sent back once`;
  // What the model actually said is kept for review whenever the server overrides it.
  const said = `model said: "${parsed.text.replace(/\s+/g, " ").slice(0, 200)}"`;
  if (derived.downgraded && !codeOwned) {
    // Claiming an answer with nothing retrieved is not allowed through: the reply is replaced, not relabelled.
    spoken = SAFE_FALLBACK;
    note = `${derived.note}. ${said}`;
  }
  if (!guard.ok) {
    // An escalation logged earlier in the call counts too, so the caller is not offered one twice.
    spoken = fallbackFor(records.escalationExists);
    answerType = records.escalationExists ? "escalate" : "decline";
    note = `speech guard: ${guard.reasons.join(",")}. ${said}`;
  }

  // A caller who only ever greets is asked once to say what they need, and the call is closed on
  // the next one: the line is metered, and there is nothing to work with.
  // Only for a call that has never got anywhere. A caller who has been helped and is saying
  // "thanks, that's all" also produces conversational turns, and closing on them would be rude
  // and wrong; so would interrupting an escalation mid-collection.
  const neverProgressed = !recentTypes.some((t) => SUBSTANTIVE.has(t));
  if (answerType === "conversational" && !escalated && neverProgressed && conv.status !== "collecting_details") {
    const greetings = countTrailing(recentTypes, "conversational") + 1;
    if (greetings >= 3) {
      await store.completeTurn(turn.id, { assistant: NO_PROGRESS_CLOSE, answerType, note: `no progress after ${greetings} greetings`, guardTripped: false }).catch(log("completeTurn"));
      await store.closeConversation(id).catch(log("closeConversation"));
      await disposeSession(id);
      return {
        conversationId: id, reply: NO_PROGRESS_CLOSE, answerType, ended: true, guardTripped: false, guardReasons: [],
        escalationCreated: false, toolCalls: raw.toolCallCount, agentMs: Date.now() - agentStarted, ms: Date.now() - started,
      };
    }
    if (greetings === 2) spoken = STATE_YOUR_PROBLEM;
  }

  // The caller left before hearing this. The turn is kept as evidence that it was attempted, but
  // with no answer type, so it counts toward nothing: not the streaks, not the handoff offer, and
  // not the repeated-question check when Vapi re-sends the same words.
  if (p.isDelivered?.() === false) {
    await store
      .completeTurn(turn.id, { assistant: spoken, answerType: null, note: "caller disconnected before the reply was delivered", guardTripped: !guard.ok })
      .catch(log("completeTurn"));
    return {
      conversationId: id, reply: spoken, answerType, ended: false, guardTripped: !guard.ok, guardReasons: guard.reasons,
      escalationCreated: facts.escalationCreated, toolCalls: raw.toolCallCount,
      agentMs: Date.now() - agentStarted, ms: Date.now() - started,
    };
  }

  const clarifyAfter = answerType === "clarify" ? conv.clarify_streak + 1 : 0;
  const repeatQuestion = isRepeatQuestion(p.text, priorForRepeat);
  const increment = Math.max(
    unresolvedIncrement(answerType, facts, clarifyAfter, { guardTripped: !guard.ok, repeatQuestion }),
    derived.downgraded ? 1 : 0,
  );
  const collecting = answerType === "escalate" && !facts.escalationCreated && !escalated;
  const wasCollecting = conv.status === "collecting_details";

  // The reply is already computed and checked. A bookkeeping write that fails must never throw it
  // away, because on a call that is silence. Every write is logged; none of them can block speech.
  const writes = await Promise.allSettled([
    store.completeTurn(turn.id, { assistant: spoken, answerType, note, guardTripped: !guard.ok }),
    store.attachTurnRecords(id, turn.id, turn.createdAt),
    bump(getDb(), id, "turn_count"),
    answerType === "clarify" ? bump(getDb(), id, "clarify_streak") : conv.clarify_streak > 0 ? store.resetClarifyStreak(id) : undefined,
    increment > 0 ? bump(getDb(), id, "unresolved_count") : undefined,
    offerMade ? bump(getDb(), id, "handoff_offers_made") : undefined,
    offerMade ? addEvent(getDb(), id, "handoff_offer", "specialist follow-up offered (server note)") : undefined,
    !guard.ok ? addEvent(getDb(), id, "speech_guard", "reply replaced by a safe line", { reasons: guard.reasons }) : undefined,
    collecting ? store.setStatus(id, "collecting_details") : wasCollecting && answerType !== "escalate" ? store.setStatus(id, "active") : undefined,
  ]);
  for (const w of writes) {
    if (w.status === "rejected") console.error("turn bookkeeping write failed:", w.reason);
  }

  return {
    conversationId: id, reply: spoken, answerType, ended: false, guardTripped: !guard.ok, guardReasons: guard.reasons,
    escalationCreated: facts.escalationCreated, toolCalls: raw.toolCallCount,
    agentMs: Date.now() - agentStarted, ms: Date.now() - started,
  };
}

/**
 * Never throws for a conversation that exists. Anything that goes wrong after the caller has
 * spoken becomes a spoken apology plus a ticket, because an HTTP error on a voice call is silence.
 */
export async function handleTurn(p: TurnRequest): Promise<TurnResult> {
  try {
    return await withLock(p.conversationId, () => runTurn(p));
  } catch (err) {
    if (err instanceof NotFoundError) throw err;
    console.error("turn failed outside the agent:", err instanceof Error ? err.message : err);
    return failTurn(p.conversationId, null, err, Date.now());
  }
}

export async function endConversation(conversationId: string): Promise<string> {
  return withLock(conversationId, async () => {
    await disposeSession(conversationId);
    return store.closeConversation(conversationId);
  });
}
