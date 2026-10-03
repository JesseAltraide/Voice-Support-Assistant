import { describeWindow } from "../mcp/callback-slots.js";
import { config } from "./config.js";

export interface NoteInput {
  unresolved: number;
  offersMade: number;
  failedLookups: number;
  clarifyStreak: number;
  turnCount: number;
  elapsedMs: number;
  escalationExists: boolean;
  /** Given on the form before a web call. Absent on a phone call, which has no form. */
  caller?: {
    name: string | null;
    email: string | null;
    timezone?: string | null;
    verifyState?: "verified" | "unconfirmed" | "guest" | null;
  };
  /** Injectable so the clock note can be asserted. Defaults to the real one. */
  now?: Date;
}

export interface NoteResult {
  notes: string[];
  /** True when this turn's notes ask the agent to make a handoff offer, so the server can count it. */
  offerMade: boolean;
}

const OFFER =
  "Offer once, in your own words, to log a request for a specialist to follow up, and ask whether they would like that.";

/**
 * Server notes for the next turn, decided in code from the stored counters, never from the agent's
 * own sense of how the call is going. The agent is only told what to say; it cannot skip an offer
 * or invent one.
 */
export function buildNotes(i: NoteInput): NoteResult {
  const notes: string[] = [];
  let offerMade = false;

  // The caller typed these before the call, so they are spelled the way they meant them. Asking
  // again wastes the opening of an escalation on something already correct, and invites a
  // mishearing where there was none.
  const name = i.caller?.name?.trim();
  const email = i.caller?.email?.trim();
  if (name && email) {
    // The address itself is deliberately withheld. The speech guard blocks any email the caller
    // did not say aloud, and a typed one was never said — so handing it to the model only
    // creates a sentence that would get the whole reply replaced. The escalation tool reads the
    // stored value directly, so the address is used correctly without being seen here.
    notes.push(
      `This caller is ${name}, and their email is already on file from the form they filled in. Do NOT ask for their name or their email, and do not say the email address: both are recorded and will be used for any escalation.`,
    );
    // What was typed was matched against the customer list in code when the call connected, so
    // the answer is already known and must not be re-derived or asked for again by voice, except
    // in the one state below that was built to ask exactly one more thing.
    const state = i.caller?.verifyState ?? "guest";
    if (state === "verified") {
      notes.push(
        "The email, name and company on the form all match the same account on file, so this caller is VERIFIED. Look up their transactions and payouts directly when they give you a reference. Do NOT ask them to confirm a company name or an email first. If they ask about their plan, account status or verification status, call lookup_customer with company_name and tell them in plain words from account_facts.",
      );
    } else if (state === "unconfirmed") {
      notes.push(
        "Both the name and the email on the form match the same account, but no company was given, so this caller is UNCONFIRMED, not yet a guest. All three must agree before anything is opened to them. If they ask about a transaction, payout or account detail, ask for the company name on the account, then call lookup_customer with it plus their name and email. If that links them, treat them as verified from then on. If it does not, say plainly: there is no account on file for you, so I can't look into transactions, payouts or anything account-related. Do not offer to log a request or escalate over this specific refusal.",
      );
    } else {
      notes.push(
        "What was typed on the form does not match any one account on file on all three of email, name and company, so this caller is a GUEST. Answer general questions about RelayPay's products, fees and timelines as usual. You cannot look anything up for them: do not call lookup_transaction, lookup_payout or lookup_customer, because there is no account to look in, and do not ask for a company name — there is nothing left to confirm. If they ask about a transaction, payout or any account detail, say so PLAINLY and DIRECTLY, in close to these words: 'There's no account on file for you, so I can't look into transactions, payouts or anything account-related.' Do not soften it with 'let me check' and do not offer to log a request or put them in front of a specialist over this — a specialist has nothing more to look up than you do without a matching account. You may still help with anything general.",
      );
    }
  }
  // A model has no clock, and a caller booking a callback says "Tuesday at ten", not an instant.
  // Without an anchor it would guess the date, and a guessed date is a slot in the wrong week.
  // The caller's own zone is named too: "ten" means ten where they are sitting.
  const zone = i.caller?.timezone?.trim();
  const now = i.now ?? new Date();
  notes.push(
    `Right now it is ${now.toISOString()}.` +
      (zone ? ` The caller's own timezone is ${zone}.` : "") +
      " Work out any time the caller names in their own timezone, and pass it to a tool as a full ISO-8601 UTC instant." +
      // Said up front rather than discovered by refusal. A caller asked "when suits you?" with no
      // hint of the window will name an evening or a Saturday, be turned down, and have to guess
      // again — which is the opposite of being helped.
      ` Callbacks can only be arranged ${describeWindow(zone ?? null, now)} in the caller's own time, on the hour or the half hour, from about an hour from now up to two weeks ahead. Say those days and hours in one short sentence when you offer a callback, before asking what suits them.`,
  );

  const [firstOffer, secondOffer] = config.unresolvedOfferAt;

  if (i.escalationExists) {
    notes.push(
      "An escalation is already logged for this call. Do not troubleshoot that issue any further. Unrelated general questions may still be answered.",
    );
  } else if (i.unresolved >= firstOffer && i.offersMade === 0) {
    offerMade = true;
    notes.push(OFFER);
  } else if (i.unresolved >= secondOffer && i.offersMade === 1) {
    offerMade = true;
    notes.push(`${OFFER} You have offered once already, so keep it brief.`);
  } else if (i.offersMade >= 2 && i.unresolved > secondOffer) {
    notes.push(
      "Wrap up politely now and point them to the support options in the RelayPay dashboard. Do not offer a specialist again.",
    );
  }

  if (i.clarifyStreak >= 2) {
    notes.push("Do not ask another clarifying question. Offer a specialist follow-up instead.");
  }
  if (i.failedLookups >= 3) {
    notes.push("The lookup limit for this call is reached. Make no more lookups; offer a specialist follow-up instead.");
  }
  if (i.elapsedMs >= config.softWrapUpMs || i.turnCount >= config.maxTurns) {
    notes.push("The call is close to its time limit. Wrap up politely in this reply.");
  }
  return { notes, offerMade };
}
