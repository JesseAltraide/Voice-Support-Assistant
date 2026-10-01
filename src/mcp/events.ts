import type { SupabaseClient } from "@supabase/supabase-js";

/** Must match the check constraint on conversation_events.event_type in db/schema.sql. */
export type EventType =
  | "state_change" | "decision" | "handoff_offer" | "handoff_accepted" | "handoff_declined"
  | "email_queued" | "email_sent" | "email_failed" | "email_suppressed" | "speech_guard"
  | "failure" | "holding_line" | "fallback_apology" | "limit_hit" | "note";

/**
 * Best-effort: losing an event row must not undo a ticket or escalation that already
 * exists. A failed write is logged loudly instead of thrown.
 */
export async function addEvent(
  db: SupabaseClient,
  conversationId: string,
  eventType: EventType,
  summary: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db
    .from("conversation_events")
    .insert({ conversation_id: conversationId, event_type: eventType, summary: summary.slice(0, 500), metadata });
  if (error) console.error(`conversation_events insert failed (${eventType}): ${error.message}`);
}
