import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { buildHandoffBrief, type BriefToolCall, type BriefTurn } from "./brief.js";
import { isUuid, type ToolContext } from "./context.js";
import { addEvent } from "./events.js";
import { runTool, type ToolOutcome } from "./instrument.js";
import { normalizeStatus } from "./normalize.js";

const TICKET_CATEGORIES = ["compliance", "account", "dispute", "payment", "invoice", "other"] as const;
const ESCALATION_CATEGORIES = ["compliance", "account", "dispute", "payment", "other"] as const;
const PRIORITIES = ["low", "medium", "high", "urgent"] as const;
// The model may only annotate. System events (state changes, email results, guard trips,
// fallbacks) are written by the system, so the audit trail cannot be forged by a caller
// who talks the agent into logging them.
const MODEL_EVENT_TYPES = ["note", "decision", "handoff_offer", "handoff_declined"] as const;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const UNIQUE_VIOLATION = "23505";
const MAX_TICKETS_PER_CONVERSATION = 3;
// jsonb is stored larger than its JSON text; the schema caps it at 4096 bytes.
const MAX_METADATA_BYTES = 3000;
const FOLLOW_UP =
  "Your request is logged and a support representative will follow up. No callback time has been confirmed.";

interface ConversationRow {
  id: string;
  ended_at: string | null;
  is_test: boolean;
  linked_customer_id: string | null;
}

interface TicketRef {
  ticket_id: string;
  status: string;
  deduplicated: boolean;
}

// p{Cc}: control chars (incl. C1), p{Zl}/p{Zp}: line and paragraph separators.
const clean = (s: string, max: number) => s.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);

async function openConversation(db: SupabaseClient, id: string): Promise<ConversationRow> {
  const { data, error } = await db.from("conversations").select("id,ended_at,is_test,linked_customer_id").eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("conversation not found");
  if (data.ended_at) throw new Error("conversation already ended");
  return data as ConversationRow;
}

async function loadBrief(db: SupabaseClient, conversationId: string, reason: string, caseReference: string | null): Promise<string> {
  const [turns, calls, conv] = await Promise.all([
    db.from("conversation_turns").select("user_transcript,answer_type").eq("conversation_id", conversationId).order("created_at", { ascending: true }),
    db.from("tool_calls").select("tool_name,status,result_summary").eq("conversation_id", conversationId).order("created_at", { ascending: true }),
    db.from("conversations").select("unresolved_count").eq("id", conversationId).maybeSingle(),
  ]);
  for (const r of [turns, calls, conv]) if (r.error) throw new Error(r.error.message);
  return buildHandoffBrief({
    reason,
    unresolvedCount: (conv.data?.unresolved_count as number | undefined) ?? 0,
    turns: (turns.data ?? []) as BriefTurn[],
    toolCalls: (calls.data ?? []) as BriefToolCall[],
    caseReference,
  });
}

/** Internal only: a linked customer in a non-standard state raises a low ticket to high. Never spoken. */
async function effectivePriority(db: SupabaseClient, customerId: string | null, priority: string): Promise<string> {
  if (!customerId || (priority !== "low" && priority !== "medium")) return priority;
  const { data, error } = await db.from("customers").select("account_status,kyc_status").eq("customer_id", customerId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return priority;
  const standard = normalizeStatus(data.account_status as string) === "active" && normalizeStatus(data.kyc_status as string) === "approved";
  return standard ? priority : "high";
}

async function findTicket(db: SupabaseClient, conversationId: string, category: string, hash: string): Promise<TicketRef | null> {
  const { data, error } = await db
    .from("support_tickets").select("id,status")
    .eq("conversation_id", conversationId).eq("category", category).eq("summary_hash", hash).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { ticket_id: data.id as string, status: data.status as string, deduplicated: true } : null;
}

/** One ticket per conversation, category and summary hash (unique index), at most three per conversation. */
async function createTicketRecord(
  db: SupabaseClient,
  conv: ConversationRow,
  p: { category: string; priority: string; summary: string },
): Promise<TicketRef | "limit"> {
  const hash = createHash("sha256").update(p.summary.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()).digest("hex").slice(0, 32);
  const existing = await findTicket(db, conv.id, p.category, hash);
  if (existing) return existing;

  const { count, error: countError } = await db.from("support_tickets").select("*", { count: "exact", head: true }).eq("conversation_id", conv.id);
  if (countError) throw new Error(countError.message);
  if ((count ?? 0) >= MAX_TICKETS_PER_CONVERSATION) return "limit";

  const { data, error } = await db
    .from("support_tickets")
    .insert({
      conversation_id: conv.id,
      customer_id: conv.linked_customer_id,
      category: p.category,
      priority: await effectivePriority(db, conv.linked_customer_id, p.priority),
      summary: p.summary,
      summary_hash: hash,
      // Null deliberately: a ticket collects no separate reference field. Where the caller gave
      // one it is already inside the summary, which the brief prints as the reason line.
      handoff_brief: await loadBrief(db, conv.id, p.summary, null),
    })
    .select("id,status")
    .single();

  if (error?.code === UNIQUE_VIOLATION) {
    const raced = await findTicket(db, conv.id, p.category, hash);
    if (raced) return raced;
  }
  if (error || !data) throw new Error(error?.message ?? "ticket insert returned no row");
  await addEvent(db, conv.id, "state_change", "ticket created", { ticket_id: data.id });
  return { ticket_id: data.id as string, status: data.status as string, deduplicated: false };
}

interface OpenEscalation {
  id: string;
  ticket_id: string | null;
  reason: string;
  case_reference: string | null;
}

async function findOpenEscalation(db: SupabaseClient, conversationId: string): Promise<OpenEscalation | null> {
  const { data, error } = await db
    .from("escalations").select("id,ticket_id,reason,case_reference")
    .eq("conversation_id", conversationId).in("status", ["open", "in progress"]).maybeSingle();
  if (error) throw new Error(error.message);
  return data
    ? {
        id: data.id as string,
        ticket_id: (data.ticket_id as string | null) ?? null,
        reason: (data.reason as string | null) ?? "",
        case_reference: (data.case_reference as string | null) ?? null,
      }
    : null;
}

/** Words too common to tell two problems apart. */
const REASON_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "from", "is", "was",
  "are", "were", "has", "have", "had", "their", "they", "it", "its", "this", "that", "caller",
  "customer", "needs", "wants", "about", "not", "cannot", "can", "be", "been", "by", "at",
]);

const reasonWords = (s: string) =>
  new Set(
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/).filter((w) => w.length > 2 && !REASON_STOPWORDS.has(w)),
  );

/**
 * Whether a second reason is the same problem restated rather than a new one.
 *
 * A caller repeats themselves, and an escalation listing one complaint three times wastes the
 * attention of the person reading it. A genuinely separate problem shares few content words with
 * the first, so overlap decides it.
 */
function sameProblem(existing: string, incoming: string): boolean {
  const a = reasonWords(existing);
  const b = reasonWords(incoming);
  if (b.size === 0) return true;
  const shared = [...b].filter((w) => a.has(w)).length;
  return shared / b.size >= 0.6;
}

/** Idempotent, and also run on the repeat path so a missed status update is repaired. */
async function markEscalated(db: SupabaseClient, conversationId: string): Promise<void> {
  // Deliberately not restricted to open conversations. A tool call can commit after the turn timed
  // out and the conversation closed; the escalation is real, so the status must be corrected rather
  // than leaving a live handoff filed under `error`.
  const { error } = await db.from("conversations").update({ status: "escalated" }).eq("id", conversationId);
  if (error) await addEvent(db, conversationId, "failure", "could not mark conversation escalated", { reason: error.message.slice(0, 200) });
}

function escalationOutcome(escalationId: string, ticketId: string | null, deduplicated: boolean): ToolOutcome {
  return {
    result: { escalation_id: escalationId, status: "open", follow_up_summary: FOLLOW_UP, ticket_id: ticketId, deduplicated },
    summary: `escalation ${deduplicated ? "existing" : "created"}`,
  };
}

/** Link to the ticket the agent named, else the conversation's newest ticket, else create one. */
async function attachTicket(db: SupabaseClient, conv: ConversationRow, escalationId: string, requested: string | undefined, category: string, reason: string): Promise<string | null> {
  let ticketId: string | null = null;
  if (isUuid(requested)) {
    const { data } = await db.from("support_tickets").select("id").eq("id", requested).eq("conversation_id", conv.id).maybeSingle();
    ticketId = (data?.id as string | undefined) ?? null;
  }
  if (!ticketId) {
    const { data } = await db.from("support_tickets").select("id").eq("conversation_id", conv.id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    ticketId = (data?.id as string | undefined) ?? null;
  }
  if (!ticketId) {
    const created = await createTicketRecord(db, conv, { category, priority: "high", summary: reason });
    ticketId = created === "limit" ? null : created.ticket_id;
  }
  if (ticketId) {
    const { error } = await db.from("escalations").update({ ticket_id: ticketId }).eq("id", escalationId);
    if (error) throw new Error(error.message);
  }
  return ticketId;
}

interface EscalationArgs {
  ticket_id?: string;
  user_name: string;
  user_email: string;
  category: (typeof ESCALATION_CATEGORIES)[number];
  reason: string;
  preferred_time?: string;
  case_reference?: string;
}

async function runEscalation(db: SupabaseClient, conversationId: string, args: EscalationArgs): Promise<ToolOutcome> {
  const name = clean(args.user_name, 100);
  const email = clean(args.user_email, 254).toLowerCase();
  const invalid = name.length < 2 ? "invalid_name" : !EMAIL.test(email) ? "invalid_email" : null;
  if (invalid) {
    return {
      result: { escalation_id: null, status: null, follow_up_summary: "", ticket_id: null, error: invalid, next_step: "ask_the_caller_again_and_read_it_back_before_retrying" },
      summary: `created=false reason=${invalid}`,
    };
  }

  const reason = clean(args.reason, 500);
  const conv = await openConversation(db, conversationId);
  const existing = await findOpenEscalation(db, conv.id);
  if (existing) {
    await markEscalated(db, conv.id);
    // One call can surface more than one problem. They are gathered onto the same escalation so
    // the support team receives a single handoff about a single caller, rather than separate
    // cases they must work out are the same conversation. A repeat of the same problem is not
    // appended: a caller restating themselves should not read as two complaints.
    if (sameProblem(existing.reason, reason)) {
      return escalationOutcome(existing.id, existing.ticket_id, true);
    }
    // Each issue is cleaned on its own and the separator added afterwards. Running the joined
    // text through `clean` would strip the newlines with every other control character, leaving
    // support — and the caller's own review screen — one run-on paragraph instead of a list.
    const previous = existing.reason
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line, i) => (/^Issue \d+:/.test(line) ? line : `Issue ${i + 1}: ${line}`));
    const merged = [...previous, `Issue ${previous.length + 1}: ${reason}`].join("\n").slice(0, 2000);
    const reference = existing.case_reference ?? (args.case_reference ? clean(args.case_reference, 64) || null : null);
    const { error: appendError } = await db
      .from("escalations")
      .update({ reason: merged, case_reference: reference, handoff_summary: await loadBrief(db, conv.id, merged, reference) })
      .eq("id", existing.id);
    if (appendError) throw new Error(appendError.message);
    await addEvent(db, conv.id, "state_change", "a further problem was added to the open escalation", { escalation_id: existing.id });
    return escalationOutcome(existing.id, existing.ticket_id, true);
  }

  // Absent and blank are the same thing here: the caller had nothing to give, and the brief
  // says so explicitly rather than leaving a support agent to wonder.
  const caseReference = args.case_reference ? clean(args.case_reference, 64) || null : null;
  // Claim first: the unique index decides the winner before anything else is created,
  // so a race can never leave two escalations or an orphaned ticket behind.
  const { data, error } = await db
    .from("escalations")
    .insert({
      conversation_id: conv.id,
      customer_id: conv.linked_customer_id,
      user_name: name,
      user_email: email,
      category: args.category,
      reason,
      call_booked: false,
      preferred_time: args.preferred_time ? clean(args.preferred_time, 200) : null,
      case_reference: caseReference,
      handoff_summary: await loadBrief(db, conv.id, reason, caseReference),
      // Test conversations never send real email; the composed content stays checkable.
      handoff_email_status: conv.is_test ? "suppressed" : "pending",
    })
    .select("id")
    .single();

  if (error?.code === UNIQUE_VIOLATION) {
    const raced = await findOpenEscalation(db, conv.id);
    if (raced) {
      await markEscalated(db, conv.id);
      return escalationOutcome(raced.id, raced.ticket_id, true);
    }
  }
  if (error || !data) throw new Error(error?.message ?? "escalation insert returned no row");
  const escalationId = data.id as string;

  let ticketId: string | null = null;
  try {
    ticketId = await attachTicket(db, conv, escalationId, args.ticket_id, args.category, reason);
  } catch (err) {
    // The escalation already exists and must stand; the missing link is recorded, not hidden.
    await addEvent(db, conv.id, "failure", "escalation created but ticket link failed", { reason: (err instanceof Error ? err.message : "unknown").slice(0, 200) });
  }

  await addEvent(db, conv.id, conv.is_test ? "email_suppressed" : "email_queued", conv.is_test ? "test conversation: handoff email suppressed" : "handoff email queued", { escalation_id: escalationId });
  await addEvent(db, conv.id, "state_change", "escalated", { escalation_id: escalationId });
  await markEscalated(db, conv.id);
  return escalationOutcome(escalationId, ticketId, false);
}

export function registerActionTools(server: McpServer, db: SupabaseClient, ctx: ToolContext): void {
  server.registerTool(
    "create_support_ticket",
    {
      description: "Log an issue for support follow-up. Safe to call once per issue; a repeat returns the same ticket. At most three tickets exist per conversation.",
      inputSchema: {
        category: z.enum(TICKET_CATEGORIES),
        priority: z.enum(PRIORITIES),
        summary: z.string().min(5).max(600).describe("Facts only: what the caller reported. No guesses about causes."),
      },
    },
    async (args) =>
      runTool(db, ctx, "create_support_ticket", "log an issue for support follow-up", `category=${args.category} priority=${args.priority}`, async (conversationId) => {
        const conv = await openConversation(db, conversationId);
        const ticket = await createTicketRecord(db, conv, { category: args.category, priority: args.priority, summary: clean(args.summary, 500) });
        if (ticket === "limit") {
          return {
            result: { ticket_id: null, status: null, deduplicated: false, error: "ticket_limit_reached", next_step: "offer_specialist_followup" },
            summary: "ticket refused: limit reached",
          };
        }
        return {
          result: { ticket_id: ticket.ticket_id, status: ticket.status, deduplicated: ticket.deduplicated },
          summary: `ticket ${ticket.deduplicated ? "existing" : "created"} category=${args.category}`,
        };
      }),
  );

  server.registerTool(
    "create_escalation",
    {
      description:
        "Hand the caller to human support. Needs the caller's name and a valid email that you have read back and they have confirmed. Only ONE open escalation exists per conversation; a repeat returns it. Never say a callback is booked or promise a time.",
      inputSchema: {
        ticket_id: z.string().max(64).optional(),
        user_name: z.string().max(200),
        user_email: z.string().max(320),
        category: z.enum(ESCALATION_CATEGORIES),
        reason: z.string().min(5).max(500).describe("One factual line on why a human is needed."),
        preferred_time: z.string().max(200).optional().describe("The caller's own words. Stored, never confirmed."),
        case_reference: z
          .string()
          .max(64)
          .optional()
          .describe(
            "What the caller said identifies their case: a transaction, payout or invoice reference, exactly as they gave it. Omit it if they do not have one — never invent or guess a reference.",
          ),
      },
    },
    async (args) =>
      runTool(db, ctx, "create_escalation", "hand the caller to human support", `category=${args.category}`, (conversationId) =>
        runEscalation(db, conversationId, args),
      ),
  );

  server.registerTool(
    "log_conversation_event",
    {
      description: "Record a note or decision for review. Do not put customer-record details in it.",
      inputSchema: {
        event_type: z.enum(MODEL_EVENT_TYPES),
        summary: z.string().min(2).max(500),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (args) =>
      runTool(db, ctx, "log_conversation_event", "record an agent decision", `event_type=${args.event_type}`, async (conversationId) => {
        const conv = await openConversation(db, conversationId);
        let metadata = args.metadata ?? {};
        if (Buffer.byteLength(JSON.stringify(metadata), "utf8") > MAX_METADATA_BYTES) metadata = { truncated: true };
        const { error } = await db
          .from("conversation_events")
          .insert({ conversation_id: conv.id, event_type: args.event_type, summary: clean(args.summary, 500), metadata });
        if (error) throw new Error(error.message);
        return { result: { logged: true }, summary: `logged ${args.event_type}` };
      }),
  );
}
