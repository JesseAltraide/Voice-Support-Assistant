import { afterAll, describe, expect, it } from "vitest";
import { getDb } from "../shared/db.js";
import { sweepStaleConversations } from "./sweep.js";

// The sweep exists because a webhook can be lost and a caller can simply hang up. These run
// against the live database; every row is created here and deleted afterwards.
const db = getDb();
const created: string[] = [];

async function makeConversation(p: { status: string; minutesIdle: number; turns?: string[] }): Promise<string> {
  const idleAt = new Date(Date.now() - p.minutesIdle * 60_000).toISOString();
  const { data, error } = await db
    .from("conversations")
    .insert({ channel: "text", is_test: true, caller_identifier: "sweep-test", status: p.status, last_activity_at: idleAt })
    .select("id")
    .single();
  if (error || !data) throw new Error(error?.message);
  const id = data.id as string;
  created.push(id);
  for (const t of p.turns ?? []) {
    await db.from("conversation_turns").insert({ conversation_id: id, user_transcript: t, answer_type: "escalate" });
  }
  return id;
}

const conversation = async (id: string) =>
  (await db.from("conversations").select("status,ended_at,summary").eq("id", id).single()).data;
const ticketCount = async (id: string) =>
  (await db.from("support_tickets").select("*", { count: "exact", head: true }).eq("conversation_id", id)).count ?? 0;

afterAll(async () => {
  for (const id of created) await db.from("conversations").delete().eq("id", id);
});

describe("sweepStaleConversations", () => {
  it("closes a conversation that has gone silent, so no call stays open forever", async () => {
    const id = await makeConversation({ status: "active", minutesIdle: 30, turns: ["what are your fees"] });
    await sweepStaleConversations();
    const row = await conversation(id);
    expect(row?.ended_at).not.toBeNull();
    expect(row?.summary).toContain("turn(s)");
  });

  it("a call abandoned while collecting details leaves a ticket, so the intent is not lost", async () => {
    const id = await makeConversation({
      status: "collecting_details",
      minutesIdle: 30,
      turns: ["my account was restricted", "my name is Jo"],
    });
    await sweepStaleConversations();
    const row = await conversation(id);
    expect(row?.status).toBe("ticket_created");
    expect(row?.ended_at).not.toBeNull();
    expect(await ticketCount(id)).toBe(1);
    const { data: ticket } = await db.from("support_tickets").select("summary,priority").eq("conversation_id", id).single();
    expect(ticket?.summary).toMatch(/abandoned|before giving/i);
  });

  it("negative: a conversation still in progress is left alone", async () => {
    const id = await makeConversation({ status: "active", minutesIdle: 1, turns: ["hello"] });
    await sweepStaleConversations();
    expect((await conversation(id))?.ended_at).toBeNull();
  });

  it("negative: an already closed conversation is not touched or re-ticketed", async () => {
    const id = await makeConversation({ status: "collecting_details", minutesIdle: 30, turns: ["hi"] });
    await sweepStaleConversations();
    const first = await conversation(id);
    const tickets = await ticketCount(id);
    await sweepStaleConversations();
    const second = await conversation(id);
    expect(second?.ended_at).toBe(first?.ended_at);
    expect(await ticketCount(id)).toBe(tickets);
  });

  it("is safe to run twice at once: the claim means only one sweep tickets a row", async () => {
    const id = await makeConversation({ status: "collecting_details", minutesIdle: 30, turns: ["restricted account"] });
    await Promise.all([sweepStaleConversations(), sweepStaleConversations()]);
    expect(await ticketCount(id)).toBe(1);
  });

  it("reports what it did, so a silent sweep is distinguishable from a working one", async () => {
    await makeConversation({ status: "active", minutesIdle: 30, turns: ["hello"] });
    const result = await sweepStaleConversations();
    expect(result.closed).toBeGreaterThanOrEqual(1);
    expect(typeof result.ticketed).toBe("number");
  });
});
