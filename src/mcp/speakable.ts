import { normalizeStatus, speakDate } from "./normalize.js";

export interface TransactionRow {
  transaction_id: string;
  customer_id: string;
  transaction_type: string;
  amount: number | null;
  currency: string;
  status: string;
  estimated_arrival: string | null;
  support_summary: string | null;
}

export interface PayoutRow {
  payout_id: string;
  transaction_id: string | null;
  customer_id: string;
  recipient_name: string | null;
  amount: number | null;
  currency: string;
  status: string;
  scheduled_for: string | null;
  failure_reason: string | null;
}

/** Fields a caller can ask about that a record may not have (#62), per record type. */
export type TransactionAsked = "estimated_arrival" | "summary";
export type PayoutAsked = "failure_reason" | "scheduled_for" | "summary";

export interface Speakable<A extends string> {
  /** One ready-to-say sentence group, built in code. The agent reads this, not raw fields. */
  speakable: string;
  /** Only fields the caller asked about that are empty. Empty fields nobody asked about stay silent. */
  unavailable_fields: A[];
}

const GENERIC_TXN = "I can see this transaction, but a specialist would need to confirm its status.";
const GENERIC_PAYOUT = "I can see this payout, but a specialist would need to confirm its status.";

const TXN_STATUS: Record<string, string> = {
  processing: "This transaction is still processing.",
  completed: "This transaction has completed.",
  delayed: "This transaction is delayed.",
  failed: "This transaction did not go through.",
  "review required": "This transaction is under review.",
};

const PAYOUT_STATUS: Record<string, string> = {
  scheduled: "This payout is scheduled.",
  processing: "This payout is processing.",
  completed: "This payout has completed.",
  failed: "This payout failed.",
  "review required": "This payout requires review.",
};

/**
 * Allowlist, not a filter. The record's free text is NEVER spoken: it can carry internal
 * routing advice or compliance detail ("Escalate account-specific questions", "failed
 * sanctions screening"). Only a reason that has been reviewed and listed here is said,
 * and only for a payout that actually failed. Anything else is treated as unavailable.
 */
const SPEAKABLE_FAILURE_REASONS: Record<string, string> = {
  "beneficiary details need review": "beneficiary details need review",
};

function speakableReason(raw: string | null): string | null {
  if (!raw) return null;
  return SPEAKABLE_FAILURE_REASONS[raw.trim().toLowerCase()] ?? null;
}

function datedSentence(
  iso: string | null,
  today: string,
  past: string,
  future: string,
  todaySentence: string,
): string | null {
  const d = speakDate(iso, today);
  if (!d) return null;
  if (d.tense === "past") return past.replace("{d}", d.phrase);
  if (d.tense === "future") return future.replace("{d}", d.phrase);
  return todaySentence;
}

export function transactionSpeakable(
  row: TransactionRow,
  asked: TransactionAsked[],
  today: string,
): Speakable<TransactionAsked> {
  const status = normalizeStatus(row.status);
  // The status sentence always leads and always comes from code, so a stale or odd
  // record summary can never contradict the status.
  const parts = [TXN_STATUS[status] ?? GENERIC_TXN];

  const askedArrival = asked.includes("estimated_arrival");
  const unavailable: TransactionAsked[] = [];
  // A completed transaction has no arrival to report unless the caller asks about it.
  if (status !== "completed" || askedArrival) {
    const arrival = datedSentence(
      row.estimated_arrival,
      today,
      "It was expected on {d}.",
      "It is currently expected around {d}, though timing is not guaranteed.",
      "It is expected today, though timing is not guaranteed.",
    );
    if (arrival) parts.push(arrival);
    else if (askedArrival && status !== "completed") unavailable.push("estimated_arrival");
  }
  return { speakable: parts.join(" "), unavailable_fields: unavailable };
}

export function payoutSpeakable(row: PayoutRow, asked: PayoutAsked[], today: string): Speakable<PayoutAsked> {
  const status = normalizeStatus(row.status);
  const reason = status === "failed" ? speakableReason(row.failure_reason) : null;
  const base = reason
    ? `This payout failed because ${reason}.`
    : (PAYOUT_STATUS[status] ?? GENERIC_PAYOUT);

  const parts = [base];
  const unavailable: PayoutAsked[] = [];

  const askedSchedule = asked.includes("scheduled_for");
  if (status !== "completed" || askedSchedule) {
    const scheduled = datedSentence(
      row.scheduled_for,
      today,
      "It was scheduled for {d}.",
      "It is scheduled for {d}.",
      "It is scheduled for today.",
    );
    if (scheduled) parts.push(scheduled);
    else if (askedSchedule && status !== "completed") unavailable.push("scheduled_for");
  }

  if (asked.includes("failure_reason")) {
    if (status !== "failed") parts.push("There is no failure recorded for this payout.");
    else if (!reason) unavailable.push("failure_reason");
  }
  return { speakable: parts.join(" "), unavailable_fields: unavailable };
}
