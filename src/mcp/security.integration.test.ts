import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../shared/db.js";
import { buildServer } from "./build.js";
import type { ToolContext } from "./context.js";

// Attack tests from the security and code reviews. Each one tries the thing that must be refused.
const db = getDb();
const created: string[] = [];

async function connect(ctx: ToolContext) {
  const server = buildServer(ctx);
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "attack", version: "1.0.0" });
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

async function newConversation(): Promise<string> {
  const { data, error } = await db
    .from("conversations")
    .insert({ channel: "text", is_test: true, caller_identifier: "security-test" })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message);
  created.push(data.id as string);
  return data.id as string;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ text: string }>)[0]?.text ?? "{}";
  let body: Record<string, any> = {};
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { isError: res.isError === true, body, text };
}

afterAll(async () => {
  for (const id of created) await db.from("conversations").delete().eq("id", id);
  // Refused no-header calls have no conversation to cascade-delete with, so remove them explicitly.
  await db.from("tool_calls").delete().is("conversation_id", null).eq("error_message", "missing conversation context");
});

describe("wildcards cannot stand in for a second identifier", () => {
  let client: Client;
  // A fresh conversation per test: the deliberate misses below would otherwise trip the lookup limit.
  beforeEach(async () => { client = await connect({ conversationId: await newConversation(), turnId: null }); });

  it.each(["*", "Lagos*", "*Ledger", "%", "_agosLedger"])("company_name %s with only a customer_id finds nothing", async (company) => {
    const { body } = await call(client, "lookup_customer", { customer_id: "CUS-1001", company_name: company });
    expect(body.found).toBe(false);
  });

  it("positive control: the real company name with the same id still links", async () => {
    const { body } = await call(client, "lookup_customer", { customer_id: "CUS-1001", company_name: "LagosLedger" });
    expect(body.found).toBe(true);
  });
});

describe("the failed-lookup limit is enforced, not advisory", () => {
  it("after 3 misses even a valid reference is refused without a query", async () => {
    const id = await newConversation();
    const client = await connect({ conversationId: id, turnId: null });
    // Verified first: an unverified lookup is refused before any record is read, so it is not a
    // failed lookup and must not spend the caller's budget of them.
    await call(client, "lookup_customer", { company_name: "LagosLedger", email: "amara@lagosledger.example" });
    for (const ref of ["TXN-0001", "TXN-0002", "TXN-0003"]) {
      expect((await call(client, "lookup_transaction", { transaction_id: ref })).body.found).toBe(false);
    }
    const blocked = await call(client, "lookup_transaction", { transaction_id: "TXN-9001" });
    expect(blocked.body.found).toBe(false);
    expect(blocked.body.limit_reached).toBe(true);
    expect(blocked.body.next_step).toBe("offer_specialist_followup");
    expect((await call(client, "lookup_payout", { payout_id: "PAY-7001" })).body.limit_reached).toBe(true);
    expect((await call(client, "lookup_customer", { company_name: "LagosLedger", email: "amara@lagosledger.example" })).body.limit_reached).toBe(true);
  });
});

describe("lookups do not echo identifiers or account status", () => {
  it("no customer_id from lookup_transaction, and no raw account state from lookup_customer", async () => {
    const client = await connect({ conversationId: await newConversation(), turnId: null });
    // The account is matched first; a reference alone no longer opens a record.
    const cust = await call(client, "lookup_customer", { company_name: "AccraStack", email: "efua@accrastack.example" });
    const txn = await call(client, "lookup_transaction", { transaction_id: "TXN-9003" });
    expect(txn.body.found).toBe(true);
    expect(txn.body.customer_id).toBeUndefined();

    expect(cust.body.found).toBe(true);
    // The tool spec defines customer_id, so it is returned; it is an internal identifier the
    // speech guard keeps unspoken, not a secret the tool has to withhold.
    expect(cust.body.customer_id).toBe("CUS-1003");
    // What must never appear is the account's raw state, or support's notes about the caller.
    // support_summary may say a specialist is needed; it may not say why.
    expect(cust.body.support_notes).toBeUndefined();
    expect(cust.body.support_summary as string).not.toMatch(/restricted|review required|pending|approved|growth|starter|scale/i);
  });

  it("a second lookup for a different customer does not silently relink the conversation", async () => {
    const id = await newConversation();
    const client = await connect({ conversationId: id, turnId: null });
    await call(client, "lookup_customer", { company_name: "LagosLedger", email: "amara@lagosledger.example" });
    const second = await call(client, "lookup_customer", { company_name: "NairobiOps", email: "daniel@nairobiops.example" });
    expect(second.body.found).toBe(false);
    const { data } = await db.from("conversations").select("linked_customer_id").eq("id", id).single();
    expect(data?.linked_customer_id).toBe("CUS-1001");
  });
});

describe("a model-supplied customer_id cannot attach a ticket to someone else", () => {
  it("uses only the customer linked through lookup_customer", async () => {
    const id = await newConversation();
    const client = await connect({ conversationId: id, turnId: null });
    await call(client, "create_support_ticket", { customer_id: "CUS-1002", category: "other", priority: "low", summary: "Caller asked about a payout." });
    const { data } = await db.from("support_tickets").select("customer_id").eq("conversation_id", id).single();
    expect(data?.customer_id).toBeNull();

    await call(client, "lookup_customer", { company_name: "LagosLedger", email: "amara@lagosledger.example" });
    await call(client, "create_support_ticket", { customer_id: "CUS-1002", category: "account", priority: "low", summary: "A second, different issue." });
    const { data: linked } = await db.from("support_tickets").select("customer_id").eq("conversation_id", id).eq("category", "account").single();
    expect(linked?.customer_id).toBe("CUS-1001");
  });

  it("a linked customer in a non-standard state raises a low ticket to high, without saying so", async () => {
    const id = await newConversation();
    const client = await connect({ conversationId: id, turnId: null });
    await call(client, "lookup_customer", { company_name: "AccraStack", email: "efua@accrastack.example" });
    const res = await call(client, "create_support_ticket", { category: "account", priority: "low", summary: "Caller reports a problem with access." });
    expect(res.text).not.toMatch(/high|restricted/i);
    const { data } = await db.from("support_tickets").select("priority").eq("conversation_id", id).single();
    expect(data?.priority).toBe("high");
  });
});

describe("identity comes from the header only", () => {
  it("with no conversation header, lookups, search and actions are refused", async () => {
    const client = await connect({ conversationId: null, turnId: null });
    expect((await call(client, "lookup_transaction", { transaction_id: "TXN-9001" })).isError).toBe(true);
    expect((await call(client, "search_knowledge", { query: "payout timelines" })).isError).toBe(true);
    expect((await call(client, "create_support_ticket", { category: "other", priority: "low", summary: "no header at all" })).isError).toBe(true);
    expect((await call(client, "log_conversation_event", { event_type: "note", summary: "no header at all" })).isError).toBe(true);
  });

  it("a conversation_id argument for a different conversation is ignored", async () => {
    const mine = await newConversation();
    const other = await newConversation();
    const client = await connect({ conversationId: mine, turnId: null });
    await call(client, "create_support_ticket", { category: "other", priority: "low", summary: "should land on mine", conversation_id: other });
    const { count: onOther } = await db.from("support_tickets").select("*", { count: "exact", head: true }).eq("conversation_id", other);
    const { count: onMine } = await db.from("support_tickets").select("*", { count: "exact", head: true }).eq("conversation_id", mine);
    expect(onOther).toBe(0);
    expect(onMine).toBe(1);
  });
});

describe("the model cannot forge audit events", () => {
  it.each(["email_sent", "email_failed", "state_change", "handoff_accepted", "fallback_apology"])("event_type %s is rejected", async (type) => {
    const id = await newConversation();
    const client = await connect({ conversationId: id, turnId: null });
    const res = await call(client, "log_conversation_event", { event_type: type, summary: "forged" });
    expect(res.isError).toBe(true);
    const { count } = await db.from("conversation_events").select("*", { count: "exact", head: true }).eq("conversation_id", id).eq("event_type", type);
    expect(count).toBe(0);
  });

  it("positive control: note and decision are accepted", async () => {
    const client = await connect({ conversationId: await newConversation(), turnId: null });
    expect((await call(client, "log_conversation_event", { event_type: "note", summary: "fine" })).body.logged).toBe(true);
    expect((await call(client, "log_conversation_event", { event_type: "decision", summary: "also fine" })).body.logged).toBe(true);
  });

  it("multi-byte metadata over the byte limit is dropped, not a constraint error", async () => {
    const id = await newConversation();
    const client = await connect({ conversationId: id, turnId: null });
    const res = await call(client, "log_conversation_event", { event_type: "note", summary: "wide chars", metadata: { blob: "é".repeat(3000) } });
    expect(res.body.logged).toBe(true);
    const { data } = await db.from("conversation_events").select("metadata").eq("conversation_id", id).single();
    expect(data?.metadata).toEqual({ truncated: true });
  });

  it("a tool failure writes a 'failure' event the timeline can show", async () => {
    const id = await newConversation();
    await db.from("conversations").update({ ended_at: new Date().toISOString() }).eq("id", id);
    const client = await connect({ conversationId: id, turnId: null });
    expect((await call(client, "create_support_ticket", { category: "other", priority: "low", summary: "on an ended conversation" })).isError).toBe(true);
    const { data } = await db.from("conversation_events").select("event_type,summary").eq("conversation_id", id);
    expect(data?.some((e) => e.event_type === "failure")).toBe(true);
  });
});

describe("tickets and escalations per conversation are bounded and consistent", () => {
  it("the fourth distinct ticket is refused", async () => {
    const id = await newConversation();
    const client = await connect({ conversationId: id, turnId: null });
    const results = [];
    for (const n of [1, 2, 3, 4]) {
      results.push(await call(client, "create_support_ticket", { category: "other", priority: "low", summary: `Distinct issue number ${n} reported.` }));
    }
    expect(results.slice(0, 3).every((r) => r.body.ticket_id)).toBe(true);
    expect(results[3]!.body.ticket_id).toBeNull();
    expect(results[3]!.body.error).toBe("ticket_limit_reached");
    const { count } = await db.from("support_tickets").select("*", { count: "exact", head: true }).eq("conversation_id", id);
    expect(count).toBe(3);
  });

  it("an escalation links to the conversation's existing ticket instead of creating a second one", async () => {
    const id = await newConversation();
    const client = await connect({ conversationId: id, turnId: null });
    const ticket = await call(client, "create_support_ticket", { category: "account", priority: "medium", summary: "Account restricted and the caller wants help." });
    const esc = await call(client, "create_escalation", { user_name: "Test Caller", user_email: "t@example.com", category: "account", reason: "Caller needs a human for a restricted account." });
    expect(esc.body.ticket_id).toBe(ticket.body.ticket_id);
    const { count } = await db.from("support_tickets").select("*", { count: "exact", head: true }).eq("conversation_id", id);
    expect(count).toBe(1);
  });

  // One call can surface more than one problem. They gather onto the same escalation, so support
  // receives a single handoff about a single caller rather than two cases they must correlate.
  it("a second, different problem is appended to the open escalation instead of being lost", async () => {
    const id = await newConversation();
    const client = await connect({ conversationId: id, turnId: null });
    const contact = { user_name: "Test Caller", user_email: "t@example.com" };
    const first = await call(client, "create_escalation", { ...contact, category: "payment", reason: "An invoice payment failed and the caller cannot retry it." });
    const second = await call(client, "create_escalation", { ...contact, category: "account", reason: "Their contractor payout to Kenya is also stuck in compliance review." });

    // Still one escalation: the support team gets one handoff, not two.
    expect(second.body.escalation_id).toBe(first.body.escalation_id);
    const { count } = await db.from("escalations").select("*", { count: "exact", head: true }).eq("conversation_id", id);
    expect(count).toBe(1);

    const { data } = await db.from("escalations").select("reason,handoff_summary").eq("id", first.body.escalation_id as string).single();
    const reason = data?.reason as string;
    // Separated, not merely both present: the review screen splits on the newline, so an
    // assertion that only checked for both substrings passed happily on one run-on line.
    const issues = reason.split("\n");
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatch(/^Issue 1:/);
    expect(issues[1]).toMatch(/^Issue 2:/);
    expect(reason).toMatch(/invoice payment failed/i);
    expect(reason).toMatch(/payout to Kenya/i);
    // The brief support reads must carry the second problem too, not just the first.
    expect(data?.handoff_summary as string).toMatch(/payout to Kenya/i);
  });

  it("the same problem restated is not appended twice", async () => {
    const id = await newConversation();
    const client = await connect({ conversationId: id, turnId: null });
    const contact = { user_name: "Test Caller", user_email: "t@example.com" };
    const reason = "An invoice payment failed and the caller cannot retry it.";
    await call(client, "create_escalation", { ...contact, category: "payment", reason });
    await call(client, "create_escalation", { ...contact, category: "payment", reason: "The invoice payment failed and they cannot retry it." });

    const { data } = await db.from("escalations").select("reason").eq("conversation_id", id).single();
    // A caller repeating themselves must not read to support as two separate complaints.
    expect(data?.reason as string).not.toMatch(/Issue 2:/);
  });

  it("two escalations fired at the same instant produce exactly one row", async () => {
    const id = await newConversation();
    const client = await connect({ conversationId: id, turnId: null });
    const args = { user_name: "Race Caller", user_email: "race@example.com", category: "dispute", reason: "Caller disputes a charge, needs a human." };
    const [a, b] = await Promise.all([call(client, "create_escalation", args), call(client, "create_escalation", args)]);
    expect(a.body.escalation_id).toBeTruthy();
    expect(a.body.escalation_id).toBe(b.body.escalation_id);
    const { count } = await db.from("escalations").select("*", { count: "exact", head: true }).eq("conversation_id", id);
    expect(count).toBe(1);
    const { data } = await db.from("conversations").select("status").eq("id", id).single();
    expect(data?.status).toBe("escalated");
  });

  it("a repeat escalation repairs a conversation whose status was not set", async () => {
    const id = await newConversation();
    const client = await connect({ conversationId: id, turnId: null });
    const args = { user_name: "Repair Caller", user_email: "repair@example.com", category: "other", reason: "Caller wants a specialist to look." };
    await call(client, "create_escalation", args);
    await db.from("conversations").update({ status: "active" }).eq("id", id);
    await call(client, "create_escalation", args);
    const { data } = await db.from("conversations").select("status").eq("id", id).single();
    expect(data?.status).toBe("escalated");
  });
});

// The form's email decides whether a caller sees account records, so the way it is matched is an
// authorisation check. Matching it with ilike made it a pattern: "%@lagosledger.example" passed
// the email format check and matched a real account, which is typing your way into someone
// else's transactions. Matching must stay exact.
describe("the form email is matched exactly, never as a pattern", () => {
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

  it("wildcard addresses still look like valid emails, which is why the query must be exact", () => {
    // If this ever fails, the format check alone is no longer the thing standing in the way.
    expect(EMAIL_RE.test("%@lagosledger.example")).toBe(true);
    expect(EMAIL_RE.test("amara@lagosledger.exampl_")).toBe(true);
  });

  it("an exact match finds the account and a pattern finds nothing", async () => {
    const exact = await db.from("customers").select("customer_id").eq("contact_email", "amara@lagosledger.example");
    expect(exact.data?.[0]?.customer_id).toBe("CUS-1001");

    for (const pattern of ["%@lagosledger.example", "amara@lagosledger.exampl_", "%@%.%"]) {
      const { data } = await db.from("customers").select("customer_id").eq("contact_email", pattern);
      expect(data ?? [], `pattern matched an account: ${pattern}`).toHaveLength(0);
    }
  });
});
