import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { bump, runTool, type ToolOutcome } from "./instrument.js";
import { normalizeId, normalizeStatus, todayIso } from "./normalize.js";
import {
  payoutSpeakable,
  transactionSpeakable,
  type PayoutAsked,
  type PayoutRow,
  type TransactionAsked,
  type TransactionRow,
} from "./speakable.js";
import type { ToolContext } from "./context.js";

const FAILED_LOOKUP_LIMIT = 3;
const MAX_REF = 64;
const OFFER_FOLLOWUP = "offer_specialist_followup";

const askedTransaction = z
  .array(z.enum(["estimated_arrival", "summary"]))
  .max(2)
  .optional()
  .describe(
    "ONLY the fields the caller explicitly asked about. If one is empty on the record it comes back in unavailable_fields. Leave out anything the caller did not ask about.",
  );

const askedPayout = z
  .array(z.enum(["failure_reason", "scheduled_for", "summary"]))
  .max(3)
  .optional()
  .describe(
    "ONLY the fields the caller explicitly asked about. If one is empty on the record it comes back in unavailable_fields. Leave out anything the caller did not ask about.",
  );

const normaliseCompany = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

/** The limit is enforced BEFORE any query, so a blocked conversation cannot keep probing references. */
async function lookupsBlocked(db: SupabaseClient, conversationId: string): Promise<boolean> {
  const { data, error } = await db.from("conversations").select("failed_lookup_count").eq("id", conversationId).maybeSingle();
  if (error) throw new Error(error.message);
  return ((data?.failed_lookup_count as number | undefined) ?? 0) >= FAILED_LOOKUP_LIMIT;
}

function blockedOutcome(shape: Record<string, unknown>): ToolOutcome {
  return {
    result: { ...shape, found: false, limit_reached: true, next_step: OFFER_FOLLOWUP },
    summary: "refused: lookup limit reached",
  };
}

/** A miss counts as a failed lookup and as one unresolved turn (#28, #43). */
async function missOutcome(db: SupabaseClient, conversationId: string, shape: Record<string, unknown>): Promise<ToolOutcome> {
  const failed = await bump(db, conversationId, "failed_lookup_count");
  await bump(db, conversationId, "unresolved_count");
  const limitReached = failed >= FAILED_LOOKUP_LIMIT;
  return {
    result: {
      ...shape,
      found: false,
      limit_reached: limitReached,
      next_step: limitReached ? OFFER_FOLLOWUP : "say_you_could_not_find_it_and_ask_caller_to_recheck_the_reference",
    },
    summary: "found=false",
  };
}

function nextStepFor(status: string, unavailable: string[]): string {
  if (unavailable.length > 0) return "say_you_do_not_have_that_information_right_now_and_offer_specialist_followup";
  if (status === "failed" || status === "review required") return "give_summary_then_offer_specialist_followup";
  return "give_summary";
}

const CUSTOMER_MISS = { linked: false };
const TXN_MISS = { transaction_id: null, type: null, status: null, support_summary: null, unavailable_fields: [] };
const PAYOUT_MISS = { payout_id: null, status: null, support_summary: null, unavailable_fields: [] };

export function registerLookupTools(server: McpServer, db: SupabaseClient, ctx: ToolContext): void {
  server.registerTool(
    "lookup_customer",
    {
      description:
        "Link this conversation to the caller's customer record so a ticket or escalation reaches the right account. Needs TWO agreeing identifiers (customer_id, email, company_name). Used for linking only: nothing about the account is returned and nothing may be said about it.",
      inputSchema: {
        customer_id: z.string().max(MAX_REF).optional(),
        email: z.string().max(254).optional(),
        company_name: z.string().max(120).optional(),
      },
    },
    async (args) =>
      runTool(db, ctx, "lookup_customer", "link ticket/escalation to a customer", "identifiers supplied", async (conversationId) => {
        if (await lookupsBlocked(db, conversationId)) return blockedOutcome(CUSTOMER_MISS);

        const id = normalizeId(args.customer_id, "CUS");
        const email = args.email?.trim().toLowerCase() || null;
        const company = args.company_name?.trim() || null;
        const provided = [id, email, company].filter(Boolean).length;
        if (provided < 2) {
          return {
            result: { ...CUSTOMER_MISS, found: false, next_step: "ask_for_a_second_identifier_such_as_company_name_and_email" },
            summary: `found=false identifiers=${provided}`,
          };
        }

        // The company name is never put into a query: pattern characters in it (%, _ and
        // PostgREST's *) would match many rows and stand in for the second identifier.
        // Candidates come from exact matches on the other identifiers; the name is then
        // compared in code with strict equality.
        let query = db.from("customers").select("customer_id,company_name").limit(5);
        if (id) query = query.eq("customer_id", id);
        if (email) query = query.eq("contact_email", email);
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        const matches = (data ?? []).filter((r) => !company || normaliseCompany(r.company_name as string) === normaliseCompany(company));
        const row = matches.length === 1 ? matches[0] : null;
        if (!row) return missOutcome(db, conversationId, CUSTOMER_MISS);

        const { data: conv, error: convError } = await db.from("conversations").select("linked_customer_id").eq("id", conversationId).maybeSingle();
        if (convError) throw new Error(convError.message);
        const existing = conv?.linked_customer_id as string | null | undefined;
        // A conversation is linked to one customer. A later lookup for someone else is a miss,
        // not a silent relink.
        if (existing && existing !== row.customer_id) return missOutcome(db, conversationId, CUSTOMER_MISS);

        if (!existing) {
          const { error: linkError } = await db.from("conversations").update({ linked_customer_id: row.customer_id }).eq("id", conversationId);
          if (linkError) throw new Error(linkError.message);
        }
        // Nothing about the record leaves the tool: no id, no plan, no status, no routing hint.
        return {
          result: {
            found: true,
            linked: true,
            note: "Nothing about this account may be said. Say account details cannot be shared by voice.",
          },
          summary: "found=true linked",
        };
      }),
  );

  server.registerTool(
    "lookup_transaction",
    {
      description:
        "Look up a transaction the caller gave a reference for. Read support_summary aloud as written; do not add amounts, IDs, names or dates of your own.",
      inputSchema: { transaction_id: z.string().max(MAX_REF), asked_about: askedTransaction },
    },
    async (args) =>
      runTool(db, ctx, "lookup_transaction", "answer a transaction status question", "transaction reference supplied", async (conversationId) => {
        if (await lookupsBlocked(db, conversationId)) return blockedOutcome(TXN_MISS);
        const id = normalizeId(args.transaction_id, "TXN");
        if (!id) return missOutcome(db, conversationId, TXN_MISS);

        const { data, error } = await db
          .from("transactions")
          .select("transaction_id,customer_id,transaction_type,amount,currency,status,estimated_arrival,support_summary")
          .eq("transaction_id", id)
          .maybeSingle();
        if (error) throw new Error(error.message);
        if (!data) return missOutcome(db, conversationId, TXN_MISS);

        const row = data as TransactionRow;
        const { speakable, unavailable_fields } = transactionSpeakable(row, (args.asked_about ?? []) as TransactionAsked[], todayIso());
        if (unavailable_fields.length > 0) await bump(db, conversationId, "unresolved_count");
        const status = normalizeStatus(row.status);
        return {
          result: {
            found: true,
            transaction_id: row.transaction_id,
            type: row.transaction_type,
            status,
            support_summary: speakable,
            unavailable_fields,
            next_step: nextStepFor(status, unavailable_fields),
          },
          summary: `found=true status=${status} unavailable=${unavailable_fields.join(",") || "none"}`,
        };
      }),
  );

  server.registerTool(
    "lookup_payout",
    {
      description:
        "Look up a contractor payout by payout_id or by its transaction_id. Read support_summary aloud as written; never speak the recipient, amounts or IDs.",
      inputSchema: {
        payout_id: z.string().max(MAX_REF).optional(),
        transaction_id: z.string().max(MAX_REF).optional(),
        asked_about: askedPayout,
      },
    },
    async (args) =>
      runTool(db, ctx, "lookup_payout", "answer a payout status question", "payout or transaction reference supplied", async (conversationId) => {
        if (await lookupsBlocked(db, conversationId)) return blockedOutcome(PAYOUT_MISS);
        const payoutId = normalizeId(args.payout_id, "PAY");
        const txnId = normalizeId(args.transaction_id, "TXN");
        // A reference that was supplied but is malformed, or none at all, is a miss, not a wider search.
        if ((args.payout_id && !payoutId) || (args.transaction_id && !txnId) || (!payoutId && !txnId)) {
          return missOutcome(db, conversationId, PAYOUT_MISS);
        }

        // If both are given they must agree: a conflict finds nothing. The order is fixed so a
        // transaction with several payouts always returns the same one.
        let query = db
          .from("payouts")
          .select("payout_id,transaction_id,customer_id,recipient_name,amount,currency,status,scheduled_for,failure_reason")
          .order("scheduled_for", { ascending: false })
          .order("payout_id", { ascending: true })
          .limit(1);
        if (payoutId) query = query.eq("payout_id", payoutId);
        if (txnId) query = query.eq("transaction_id", txnId);
        const { data, error } = await query;
        if (error) throw new Error(error.message);
        const row = data?.[0] as PayoutRow | undefined;
        if (!row) return missOutcome(db, conversationId, PAYOUT_MISS);

        const { speakable, unavailable_fields } = payoutSpeakable(row, (args.asked_about ?? []) as PayoutAsked[], todayIso());
        if (unavailable_fields.length > 0) await bump(db, conversationId, "unresolved_count");
        const status = normalizeStatus(row.status);
        return {
          result: {
            found: true,
            payout_id: row.payout_id,
            status,
            support_summary: speakable,
            unavailable_fields,
            next_step: nextStepFor(status, unavailable_fields),
          },
          summary: `found=true status=${status} unavailable=${unavailable_fields.join(",") || "none"}`,
        };
      }),
  );
}
