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
 * All three of email, name and company must agree with the same customer to verify the caller.
 * Email and name are mandatory on the form, so the only field that can ever be missing is
 * company — if both of the mandatory two already agree and company was simply never typed,
 * that is worth one spoken question rather than an immediate guest verdict. Anything less is a
 * guest: if company was already given and the three still do not all agree, there is nothing
 * left to ask, and if even one of email or name is wrong, a correct company could never bring
 * the count to three either, so asking would only cost the caller a question with no possible
 * good answer.
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
  if (bestScore === 3 && tiedAtBest === 1) return { state: "verified", customerId: bestId };
  // Company is the only field that can ever be missing (email and name are mandatory on the
  // form), so a score of 2 with company null can only mean email and name both already agree
  // with the same customer — worth asking for company rather than an immediate guest verdict.
  // A tie here is not the same risk as a tie at 3: "unconfirmed" never attaches a customerId,
  // and the lookup_customer call that follows re-checks its own agreement and uniqueness before
  // anything links.
  if (bestScore === 2 && typed.company === null) return { state: "unconfirmed", customerId: null };
  return { state: "guest", customerId: null };
}
