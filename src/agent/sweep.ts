import { getDb } from "../shared/db.js";
import { closeConversation } from "./store.js";

/**
 * A caller can hang up, and an end-of-call webhook can be lost. Without this, a conversation that
 * went quiet stays open forever and a caller who was half-way through giving their details is
 * silently dropped: the intent was captured and then the job vanished. The sweep closes anything
 * silent for too long and leaves a ticket when the call was abandoned mid-escalation.
 */
const STALE_AFTER_MS = 10 * 60_000;
const BATCH = 50;

const ABANDONED_SUMMARY =
  "Automatic ticket: the caller was asked for their contact details for a specialist follow-up and the call ended before giving them. The conversation transcript has what they asked about.";

export interface SweepResult {
  closed: number;
  ticketed: number;
}

export async function sweepStaleConversations(staleAfterMs = STALE_AFTER_MS): Promise<SweepResult> {
  const db = getDb();
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const { data, error } = await db
    .from("conversations")
    .select("id,status")
    .is("ended_at", null)
    .lt("last_activity_at", cutoff)
    .order("last_activity_at", { ascending: true })
    .limit(BATCH);
  if (error) throw new Error(`sweep select: ${error.message}`);

  let closed = 0;
  let ticketed = 0;
  for (const row of data ?? []) {
    const id = row.id as string;
    try {
      // closeConversation raises the abandoned ticket itself and only updates where ended_at is
      // null, so a concurrent sweep or a late end-of-call webhook cannot close the same row twice.
      const wasCollecting = row.status === "collecting_details";
      await closeConversation(id);
      closed += 1;
      if (wasCollecting) ticketed += 1;
    } catch (err) {
      // One bad row must not stop the sweep; the next run will try it again.
      console.error(`sweep failed for ${id}:`, err instanceof Error ? err.message : err);
    }
  }
  return { closed, ticketed };
}
