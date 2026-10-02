export type IdKind = "TXN" | "PAY" | "CUS";

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

/**
 * Speech-to-text produces "TXN 9001", "txn nine zero zero one" or "Txn9001".
 * Normalise to the canonical "TXN-9001", or null when it is not a valid ID of that
 * kind. Anything left after stripping must match exactly, so junk and injection-shaped
 * text never reaches a query.
 */
export function normalizeId(raw: string | null | undefined, kind: IdKind): string | null {
  if (!raw) return null;
  const spoken = raw
    .toLowerCase()
    .replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => DIGIT_WORDS[w] ?? w);
  const compact = spoken.replace(/[^a-z0-9]/g, "");
  const m = compact.match(/^(txn|pay|cus)(\d{4,8})$/);
  if (!m || m[1]?.toUpperCase() !== kind) return null;
  return `${kind}-${m[2]}`;
}

/** "Review_Required", "review-required" and "review required" are the same status. */
export function normalizeStatus(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw.trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Case- and spacing-insensitive. Shared so a company typed on the form and one said by voice
 *  are judged by the exact same rule lookup_customer already uses. */
export const normaliseCompany = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Whether a supplied name is consistent with the one on a record.
 *
 * Two letters minimum, so an initial is not an identifier: "A from LagosLedger" would otherwise
 * match any contact whose name begins with that letter. Every word the caller gave must be on
 * the record, in either order, so "Amara" alone still agrees with "Amara Okafor".
 */
export function namesAgree(recorded: string, supplied: string): boolean {
  const parts = (s: string) =>
    s.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, " ").split(/\s+/).filter((w) => w.length >= 2);
  const onRecord = new Set(parts(recorded));
  const given = parts(supplied);
  return given.length > 0 && given.every((part) => onRecord.has(part));
}

export type DateTense = "past" | "today" | "future";

export function todayIso(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Spoken form of an ISO date plus whether it is already gone. Null for an empty date. */
export function speakDate(
  iso: string | null | undefined,
  today: string,
): { phrase: string; tense: DateTense } | null {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return null;
  const tense: DateTense = iso < today ? "past" : iso === today ? "today" : "future";
  return { phrase: `${month} ${Number(m[3])}`, tense };
}
