import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { bump, runTool, type ToolOutcome } from "./instrument.js";
import { namesAgree, normaliseCompany, normalizeId, normalizeStatus, todayIso } from "./normalize.js";
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

const CUSTOMER_MISS = { linked: false, customer_id: null, company_name: null, support_summary: null };

/**
 * Upper bound on the customer rows scanned when a company name is the only identifier. The
 * comparison happens in code, so this caps the work rather than the correctness.
 */
const CUSTOMER_SCAN_LIMIT = 500;

/** Account states that are safe to confirm as "nothing wrong here". Anything else is support's. */
const SETTLED_ACCOUNT = "active";
const SETTLED_KYC = "approved";

/**
 * The one line that may be read to the caller about their account.
 *
 * The brief asks for a summary of safe account information, not a refusal — but the escalation
 * rules forbid explaining a restriction or a compliance decision. Both hold if a settled account
 * is confirmed plainly and anything else is described only as needing a person, never named.
 * A restriction or a pending review is the caller's business to be helped with, not to be read a
 * status code about.
 */
function customerSummary(accountStatus: string, kycStatus: string): { support_summary: string; settled: boolean } {
  const settled = accountStatus === SETTLED_ACCOUNT && kycStatus === SETTLED_KYC;
  return {
    support_summary: settled
      ? "The account is open and verification is complete."
      : "There is something on this account that a specialist needs to look at.",
    settled,
  };
}
const TXN_MISS = { transaction_id: null, type: null, status: null, support_summary: null, unavailable_fields: [] };
const PAYOUT_MISS = { payout_id: null, status: null, support_summary: null, unavailable_fields: [] };

/**
 * The customer this call has been verified as, or null.
 *
 * A reference is not a password. Until lookup_customer has matched the caller against an account,
 * knowing a reference proves nothing about who is holding the phone, and references are short,
 * sequential and printed on invoices that get forwarded.
 */
async function verifiedCustomer(db: SupabaseClient, conversationId: string): Promise<string | null> {
  const { data, error } = await db
    .from("conversations")
    .select("linked_customer_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.linked_customer_id as string | null) ?? null;
}

/**
 * Returned before any record is read, so it is the same answer whether the reference exists, was
 * never issued, or belongs to somebody else. Nothing about the record leaks to an unverified
 * caller, including whether there is a record at all.
 */
const needsVerification = (shape: Record<string, unknown>): ToolOutcome => ({
  result: {
    ...shape,
    found: false,
    needs_verification: true,
    next_step: "ask_for_the_company_name_or_the_email_on_the_account_then_call_lookup_customer",
  },
  summary: "refused: caller not verified against an account",
});

export function registerLookupTools(server: McpServer, db: SupabaseClient, ctx: ToolContext): void {
  server.registerTool(
    "lookup_customer",
    {
      description:
        "Find the caller's customer record and link this conversation to it, so a ticket or escalation reaches the right account. Pass EVERY identifier the caller has given you, including their own name: contact_name, company_name, email, customer_id. Two are needed, and a caller who says \"I am Amara from LagosLedger\" has given you two — contact_name and company_name. Read support_summary aloud exactly as written and say nothing else about the account: plan, status, verification and support notes are never spoken.",
      inputSchema: {
        customer_id: z.string().max(MAX_REF).optional(),
        email: z.string().max(254).optional(),
        company_name: z.string().max(120).optional(),
        // Beyond the tool spec's three fields, because the brief's own example of "enough
        // identifying information" is a caller giving their name and their company. Without
        // somewhere to put the name, that example only ever counted as one identifier.
        contact_name: z.string().max(120).optional(),
      },
    },
    async (args) =>
      runTool(db, ctx, "lookup_customer", "link ticket/escalation to a customer", "identifiers supplied", async (conversationId) => {
        if (await lookupsBlocked(db, conversationId)) return blockedOutcome(CUSTOMER_MISS);

        const id = normalizeId(args.customer_id, "CUS");
        const email = args.email?.trim().toLowerCase() || null;
        const company = args.company_name?.trim() || null;
        // An initial is not an identifier, so it does not count towards the two required either.
        const suppliedName = args.contact_name?.trim() ?? "";
        const contact = suppliedName.length >= 2 ? suppliedName : null;
        const provided = [id, email, company, contact].filter(Boolean).length;
        // Still two. One identifier would let anyone learn whether a company has an account by
        // naming it, and "enough identifying information" is the condition the brief puts on
        // this lookup. A caller's own name now counts towards it, which is what the brief's
        // example supplies alongside the company.
        if (provided < 2) {
          return {
            result: { ...CUSTOMER_MISS, found: false, next_step: "ask_for_one_more_detail_such_as_the_email_on_the_account" },
            summary: `found=false identifiers=${provided}`,
          };
        }

        // The company name is still never put into a query: pattern characters in it (%, _ and
        // PostgREST's *) once matched every row. It is compared in code with strict equality
        // instead. When it is the ONLY identifier there is nothing to filter on, so the
        // candidate set is the customer list itself — small, and bounded — rather than an
        // arbitrary first few rows that might not contain the caller at all.
        const columns = "customer_id,company_name,contact_name,plan,account_status,kyc_status";
        let query = db.from("customers").select(columns).limit(5);
        if (id) query = query.eq("customer_id", id);
        if (email) query = query.eq("contact_email", email);
        // Exact equality on the company, which an index can serve. `eq` is not a pattern match,
        // so the characters that once made a company name match every row are literal here.
        if (!id && !email && company) query = query.eq("company_name", company);
        let { data, error } = await query;
        if (error) throw new Error(error.message);

        // Only a company name that differs in case or spacing falls through to a scan, and only
        // when nothing else could narrow the search. The comparison below is still the authority.
        if ((data ?? []).length === 0 && !id && !email && company) {
          const scan = await db.from("customers").select(columns).limit(CUSTOMER_SCAN_LIMIT);
          if (scan.error) throw new Error(scan.error.message);
          data = scan.data;
        }
        // Every supplied name must agree. A caller who gives the right company and the wrong
        // person is a miss, not a match on the company alone.
        const matches = (data ?? []).filter(
          (r) =>
            (!company || normaliseCompany(r.company_name as string) === normaliseCompany(company)) &&
            (!contact || namesAgree(r.contact_name as string, contact)),
        );
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
        // The tool spec defines these fields, so they are returned. What keeps them out of the
        // caller's ear is support_summary: it is the only grounded sentence here, so it is the
        // only thing the speech guard will let through. support_notes is support's own writing
        // about the caller and is never returned at all.
        const { support_summary, settled } = customerSummary(row.account_status as string, row.kyc_status as string);
        return {
          result: {
            found: true,
            linked: true,
            customer_id: row.customer_id,
            company_name: row.company_name,
            plan: row.plan,
            account_status: row.account_status,
            kyc_status: row.kyc_status,
            support_summary,
            next_step: settled ? "read_support_summary_then_ask_what_they_need" : "read_support_summary_then_offer_specialist_followup",
          },
          summary: `found=true linked settled=${settled}`,
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
        // Checked before the reference is even parsed, so an unverified caller learns nothing.
        const customerId = await verifiedCustomer(db, conversationId);
        if (!customerId) return needsVerification(TXN_MISS);

        const id = normalizeId(args.transaction_id, "TXN");
        if (!id) return missOutcome(db, conversationId, TXN_MISS);

        // Scoped to the caller's own account. Someone else's reference is simply not found, which
        // is the same answer as a reference that never existed.
        const { data, error } = await db
          .from("transactions")
          .select("transaction_id,customer_id,transaction_type,amount,currency,status,estimated_arrival,support_summary")
          .eq("transaction_id", id)
          .eq("customer_id", customerId)
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
        // Same rule as a transaction: a reference is not proof of who is holding the phone.
        const customerId = await verifiedCustomer(db, conversationId);
        if (!customerId) return needsVerification(PAYOUT_MISS);

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
          .limit(1)
          // Scoped to the verified account, so another customer's payout is simply not found.
          .eq("customer_id", customerId);
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
