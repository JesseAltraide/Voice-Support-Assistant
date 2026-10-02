/**
 * Whether the form the caller filled in is enough to trust them with their own records.
 *
 * Kept apart from the route so it is testable on its own, the same reason draft.ts and
 * transcript.ts exist. Every comparison runs in code, never in a database query built from what
 * the caller typed — the lesson from the wildcard bug this same verification step had.
 */
import { namesAgree, normaliseCompany } from "../mcp/normalize.js";

export interface CustomerCandidate {
  customer_id: string;
  contact_email: string;
  contact_name: string;
  company_name: string;
}

export type VerifyState = "verified" | "unconfirmed" | "guest";

export interface VerifyResult {
  state: VerifyState;
  customerId: string | null;
}

/**
 * Two of three agreeing identifiers (email, name, company) link the call to that account outright.
 * Exactly one agreeing, with company never given, leaves room to ask for it. Anything else is a
 * guest: if company was already given and still only one field agreed, there is nothing left to
 * ask, and if neither email nor name agreed with any customer at all, a correct company could
 * never raise the count past one either, so asking for it would only cost the caller a question
 * with no possible good answer.
 */
export function verifyCaller(
  candidates: CustomerCandidate[],
  typed: { email: string | null; name: string | null; company: string | null },
): VerifyResult {
  let bestId: string | null = null;
  let bestScore = 0;
  let tiedAtBest = 0;
  for (const row of candidates) {
    const score =
      (typed.email !== null && row.contact_email === typed.email ? 1 : 0) +
      (typed.name !== null && namesAgree(row.contact_name, typed.name) ? 1 : 0) +
      (typed.company !== null && normaliseCompany(row.company_name) === normaliseCompany(typed.company) ? 1 : 0);
    if (score === 0) continue;
    if (score > bestScore) {
      bestScore = score;
      bestId = row.customer_id;
      tiedAtBest = 1;
    } else if (score === bestScore) {
      tiedAtBest += 1;
    }
  }
  // A tie at the winning score means two different customers were equally well matched —
  // sharing a company name, say, with a first name that tolerantly matches both. Picking
  // whichever row the query happened to return first would link the call to a specific
  // customer's records on the strength of an ambiguity, not an identification.
  if (bestScore >= 2 && tiedAtBest === 1) return { state: "verified", customerId: bestId };
  // A tie at score 1 is not the same risk: "unconfirmed" never attaches a customerId here, and
  // the lookup_customer call that follows re-checks its own two-identifier agreement with its
  // own uniqueness rule before anything links. Scoring the account the email actually matched
  // is still meaningful even if an unrelated row happens to share the typed name by coincidence.
  if (bestScore >= 1 && typed.company === null) return { state: "unconfirmed", customerId: null };
  return { state: "guest", customerId: null };
}
