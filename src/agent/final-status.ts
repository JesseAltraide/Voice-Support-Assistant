export type ConversationStatus =
  | "active" | "collecting_details" | "resolved" | "escalated"
  | "ticket_created" | "declined" | "abandoned" | "error";

export interface FinalStatusInput {
  escalations: number;
  tickets: number;
  turns: number;
  lastAnswerType: string | null;
  currentStatus: string;
}

/**
 * The final status is derived from the records that exist, never from what the agent said
 * happened. Precedence: error, then escalated, then ticket_created, then the softer outcomes.
 * An error stays an error even though the failure path files a ticket.
 */
export function deriveFinalStatus(i: FinalStatusInput): ConversationStatus {
  // An escalation that exists outranks everything, including a failed turn: the support team has
  // the handoff either way, and reporting it as `error` would hide a real commitment to a caller.
  if (i.escalations > 0) return "escalated";
  // The status write can itself fail when the database is the problem, so a turn recorded as an
  // error is evidence in its own right. Without this a failed call fell through to `resolved`.
  if (i.currentStatus === "error" || i.lastAnswerType === "error") return "error";
  if (i.tickets > 0) return "ticket_created";
  if (i.turns === 0) return "abandoned";
  if (i.currentStatus === "collecting_details") return "abandoned";
  if (i.lastAnswerType === "decline") return "declined";
  return "resolved";
}
