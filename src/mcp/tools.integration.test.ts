import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../shared/db.js";
import { buildServer } from "./build.js";

// Live-database test. Every test gets its own throwaway conversation flagged is_test, so
// tests cannot depend on each other's state or on the per-conversation lookup limit.
// All conversations (and everything cascading from them) are deleted at the end.
const db = getDb();
const created: string[] = [];
let conversationId = "";
let client: Client;

async function connect(id: string): Promise<Client> {
  const server = buildServer({ conversationId: id, turnId: null });
  const [c, s] = InMemoryTransport.createLinkedPair();
  const cl = new Client({ name: "integration-test", version: "1.0.0" });
  await Promise.all([server.connect(s), cl.connect(c)]);
  return cl;
}

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "{}";
  return { isError: res.isError === true, body: JSON.parse(text) as Record<string, any> };
}

async function counters() {
  const { data } = await db.from("conversations").select("failed_lookup_count,unresolved_count").eq("id", conversationId).single();
  return data as { failed_lookup_count: number; unresolved_count: number };
}

beforeEach(async () => {
  await client?.close();
  const { data, error } = await db
    .from("conversations")
    .insert({ channel: "text", is_test: true, caller_identifier: "integration-test" })
    .select("id")
    .single();
  if (error || !data) throw new Error(`could not create test conversation: ${error?.message}`);
  conversationId = data.id as string;
  created.push(conversationId);
  client = await connect(conversationId);
});

afterAll(async () => {
  await client?.close();
  for (const id of created) await db.from("conversations").delete().eq("id", id);
  const { count } = await db.from("conversations").select("*", { count: "exact", head: true }).in("id", created);
  expect(count ?? 0).toBe(0);
});

describe("tool registration", () => {
  it("exposes exactly the seven tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_escalation", "create_support_ticket", "log_conversation_event",
      "lookup_customer", "lookup_payout", "lookup_transaction", "search_knowledge",
    ]);
  });
});

describe("lookup_transaction", () => {
  it("TXN-9001: returns a safe sentence, speaks the past date as 'was expected', withholds amount", async () => {
    const { body } = await call("lookup_transaction", { transaction_id: "txn 9001" });
    expect(body.found).toBe(true);
    expect(body.support_summary).toContain("It was expected on August 19.");
    expect(body.amount).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/2400|USD/);
  });

  it("TXN-9004 asked for its arrival: reports it unavailable and points to a specialist (#62)", async () => {
    const { body } = await call("lookup_transaction", { transaction_id: "TXN-9004", asked_about: ["estimated_arrival"] });
    expect(body.unavailable_fields).toEqual(["estimated_arrival"]);
    expect(body.next_step).toMatch(/offer_specialist_followup/);
    expect((await counters()).unresolved_count).toBe(1);
  });

  it("negative: TXN-9001 asked only for its status raises nothing (#62)", async () => {
    const { body } = await call("lookup_transaction", { transaction_id: "TXN-9001", asked_about: ["summary"] });
    expect(body.unavailable_fields).toEqual([]);
    expect(body.next_step).toBe("give_summary");
    expect((await counters()).unresolved_count).toBe(0);
  });

  it("TXN-9003 (review required, no arrival date) says nothing about the date unprompted", async () => {
    const { body } = await call("lookup_transaction", { transaction_id: "TXN-9003" });
    expect(body.support_summary).toMatch(/under review/i);
    expect(body.support_summary).not.toMatch(/arriv|expected|compliance|escalate/i);
  });

  it("negative: a transaction that does not exist is found:false, counted, and never guessed", async () => {
    const { isError, body } = await call("lookup_transaction", { transaction_id: "TXN-0000" });
    expect(isError).toBe(false);
    expect(body.found).toBe(false);
    expect(body.support_summary).toBeNull();
    expect((await counters()).failed_lookup_count).toBe(1);
  });

  it("negative: injection-shaped input is a miss, not an error", async () => {
    const { isError, body } = await call("lookup_transaction", { transaction_id: "TXN-9001'; drop table transactions;--" });
    expect(isError).toBe(false);
    expect(body.found).toBe(false);
  });
});

describe("lookup_payout", () => {
  it("PAY-7001 (no failure reason): a summary is still produced and nothing is invented", async () => {
    const { body } = await call("lookup_payout", { payout_id: "PAY-7001" });
    expect(body.found).toBe(true);
    expect(body.support_summary).toMatch(/processing/i);
    expect(body.support_summary).not.toMatch(/fail|because|reason/i);
  });

  it("PAY-7001 asked for its failure reason: says none is recorded, does not flag unavailable", async () => {
    const { body } = await call("lookup_payout", { payout_id: "PAY-7001", asked_about: ["failure_reason"] });
    expect(body.support_summary).toMatch(/no failure recorded/i);
    expect(body.unavailable_fields).toEqual([]);
  });

  it("PAY-7002: requires review, no compliance detail, no recipient or amount", async () => {
    const { body } = await call("lookup_payout", { payout_id: "PAY-7002" });
    expect(body.support_summary).toMatch(/requires review/i);
    expect(body.next_step).toBe("give_summary_then_offer_specialist_followup");
    expect(JSON.stringify(body)).not.toMatch(/compliance|Kente|5300|GBP/i);
  });

  it("PAY-7003 (failed): speaks the reviewed, customer-safe reason", async () => {
    const { body } = await call("lookup_payout", { payout_id: "PAY-7003" });
    expect(body.support_summary).toMatch(/failed because beneficiary details need review/i);
  });

  it("negative: a payout with a conflicting transaction_id finds nothing", async () => {
    const { body } = await call("lookup_payout", { payout_id: "PAY-7001", transaction_id: "TXN-9004" });
    expect(body.found).toBe(false);
  });

  it("negative: a transaction with no payout row (TXN-9002) is found:false, not an error", async () => {
    const { isError, body } = await call("lookup_payout", { transaction_id: "TXN-9002" });
    expect(isError).toBe(false);
    expect(body.found).toBe(false);
  });
});

describe("lookup_customer", () => {
  it("links with two agreeing identifiers and returns nothing about the account", async () => {
    const { body } = await call("lookup_customer", { company_name: "lagosledger", email: "amara@lagosledger.example" });
    expect(body.found).toBe(true);
    expect(body.linked).toBe(true);
    for (const field of ["customer_id", "company_name", "plan", "account_status", "kyc_status", "support_notes", "route"]) {
      expect(body[field]).toBeUndefined();
    }
    const { data } = await db.from("conversations").select("linked_customer_id").eq("id", conversationId).single();
    expect(data?.linked_customer_id).toBe("CUS-1001");
  });

  it("negative: one identifier is not enough and does not reveal whether the company exists", async () => {
    const { body } = await call("lookup_customer", { company_name: "LagosLedger" });
    expect(body.found).toBe(false);
    expect(body.customer_id).toBeUndefined();
  });

  it("negative: two identifiers that belong to different customers find nothing", async () => {
    const { body } = await call("lookup_customer", { company_name: "LagosLedger", email: "efua@accrastack.example" });
    expect(body.found).toBe(false);
  });
});

describe("search_knowledge", () => {
  it("grounds a fees question and logs the retrieval", async () => {
    const { body } = await call("search_knowledge", { query: "What fees does RelayPay charge for international payments?" });
    expect(body.grounded).toBe(true);
    expect(body.results[0].slug).toBe("frequently-asked-questions--how-does-relaypay-charge-fees");
    const { data } = await db.from("retrieval_logs").select("result_count").eq("conversation_id", conversationId).single();
    expect(data?.result_count).toBeGreaterThan(0);
  });

  it("negative: an uncovered topic returns grounded:false AND still writes a retrieval row", async () => {
    const { body } = await call("search_knowledge", { query: "weather football recipe" });
    expect(body.grounded).toBe(false);
    expect(body.results).toEqual([]);
    const { data } = await db.from("retrieval_logs").select("result_count").eq("conversation_id", conversationId);
    expect(data).toHaveLength(1);
    expect(data?.[0]?.result_count).toBe(0);
  });
});

describe("tickets, escalations and events", () => {
  it("creates a ticket, and a repeat is deduplicated to the same row", async () => {
    const args = { category: "invoice", priority: "medium", summary: "Invoice payment failed and the caller wants it reviewed." };
    const first = await call("create_support_ticket", args);
    const second = await call("create_support_ticket", args);
    expect(first.body.status).toBe("open");
    expect(first.body.deduplicated).toBe(false);
    expect(second.body.ticket_id).toBe(first.body.ticket_id);
    expect(second.body.deduplicated).toBe(true);
    const { count } = await db.from("support_tickets").select("*", { count: "exact", head: true }).eq("conversation_id", conversationId);
    expect(count).toBe(1);
  });

  it("negative: an invalid email creates nothing and asks the agent to re-confirm", async () => {
    const { body } = await call("create_escalation", { user_name: "Test Caller", user_email: "not-an-email", category: "account", reason: "Account restricted, caller needs help." });
    expect(body.escalation_id).toBeNull();
    expect(body.error).toBe("invalid_email");
    const { count } = await db.from("escalations").select("*", { count: "exact", head: true }).eq("conversation_id", conversationId);
    expect(count).toBe(0);
  });

  it("escalation is linked to a ticket, suppressed for a test conversation, never 'booked'; a second call returns the same row", async () => {
    const args = { user_name: "Test Caller", user_email: "Test.Caller@Example.com", category: "account", reason: "Account restricted, caller needs help.", preferred_time: "tomorrow afternoon" };
    const first = await call("create_escalation", args);
    const second = await call("create_escalation", args);

    expect(first.body.deduplicated).toBe(false);
    expect(second.body.escalation_id).toBe(first.body.escalation_id);
    expect(second.body.deduplicated).toBe(true);
    expect(first.body.follow_up_summary).toMatch(/No callback time has been confirmed/);

    const { data: rows } = await db.from("escalations").select("*").eq("conversation_id", conversationId);
    expect(rows).toHaveLength(1);
    const row = rows![0]!;
    expect(row.ticket_id).toBeTruthy();
    expect(row.user_email).toBe("test.caller@example.com");
    expect(row.call_booked).toBe(false);
    expect(row.preferred_time).toBe("tomorrow afternoon");
    expect(row.handoff_email_status).toBe("suppressed");
    expect(row.handoff_summary).toContain("Reason for escalating");
    expect(row.handoff_summary).not.toMatch(/kyc|plan/i);

    const { data: conv } = await db.from("conversations").select("status").eq("id", conversationId).single();
    expect(conv?.status).toBe("escalated");
  });

  it("logs an event, and drops oversized metadata instead of storing it", async () => {
    expect((await call("log_conversation_event", { event_type: "note", summary: "integration test note" })).body.logged).toBe(true);
    const big = await call("log_conversation_event", { event_type: "note", summary: "huge metadata", metadata: { blob: "x".repeat(6000) } });
    expect(big.body.logged).toBe(true);
    const { data } = await db.from("conversation_events").select("metadata").eq("conversation_id", conversationId).eq("summary", "huge metadata").single();
    expect(data?.metadata).toEqual({ truncated: true });
  });

  it("every call is logged by the wrapper, including the misses and refusals", async () => {
    await call("lookup_transaction", { transaction_id: "TXN-9001" });
    await call("lookup_transaction", { transaction_id: "TXN-0000" });
    await call("search_knowledge", { query: "weather football recipe" });
    await call("create_escalation", { user_name: "X", user_email: "bad", category: "other", reason: "invalid contact details supplied" });
    const { data } = await db.from("tool_calls").select("tool_name,status,result_summary").eq("conversation_id", conversationId);
    expect(data).toHaveLength(4);
    expect(data?.every((r) => r.status === "ok")).toBe(true);
    expect(data?.map((r) => r.tool_name).sort()).toEqual(["create_escalation", "lookup_transaction", "lookup_transaction", "search_knowledge"]);
    expect(data?.find((r) => r.result_summary === "found=false")).toBeTruthy();
  });
});

describe("closed conversations", () => {
  it("negative: a ticket cannot be created on an ended conversation, and the failure is logged", async () => {
    const dead = randomUUID();
    await db.from("conversations").insert({ id: dead, channel: "text", is_test: true, ended_at: new Date().toISOString() });
    created.push(dead);
    const deadClient = await connect(dead);
    const res = await deadClient.callTool({ name: "create_support_ticket", arguments: { category: "other", priority: "low", summary: "should be refused" } });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ text: string }>)[0]!.text;
    expect(text).not.toMatch(/ended|conversation/i); // no internal detail leaks to the agent
    const { data } = await db.from("tool_calls").select("status,error_message").eq("conversation_id", dead);
    expect(data?.[0]?.status).toBe("error");
    expect(data?.[0]?.error_message).toMatch(/already ended/);
    await deadClient.close();
  });
});
