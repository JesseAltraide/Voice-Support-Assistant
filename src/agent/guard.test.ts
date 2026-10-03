import { describe, expect, it, test } from "vitest";
import { checkReply, DIDNT_CATCH, ESCALATED_FALLBACK, type GuardInput, guardRetryLine } from "./guard.js";

const base = (over: Partial<GuardInput>): GuardInput => ({
  reply: "",
  callerTexts: [],
  groundedTexts: [],
  forbiddenNames: [],
  ...over,
});

const reasonsOf = (over: Partial<GuardInput>) => checkReply(base(over)).reasons;

describe("clean replies pass", () => {
  it.each([
    "I can't share account details over voice, but I can log a request for a specialist. Would that help?",
    "Fees vary by transaction type, corridor and payment method, and RelayPay shows them before you confirm.",
    "Is this an incoming transfer, an outgoing payout, or an invoice payment?",
    "This transaction is still processing.",
  ])("allows: %s", (reply) => {
    expect(checkReply(base({ reply })).ok).toBe(true);
  });
});

describe("numbers must come from the caller or from this turn's sources", () => {
  const timeline = "Local payouts typically take 1 to 2 business days. International payouts usually take 2 to 5 business days.";
  it("allows a timeline that was retrieved this turn", () => {
    const r = checkReply(base({ reply: "International payouts usually take 2 to 5 business days.", groundedTexts: [timeline] }));
    expect(r.ok).toBe(true);
  });
  it("blocks the same timeline with nothing retrieved (model's own knowledge)", () => {
    expect(reasonsOf({ reply: "International payouts usually take 2 to 5 business days." })).toContain("ungrounded_number");
  });
  it("blocks an invented timeline even when something else was retrieved", () => {
    expect(reasonsOf({ reply: "It will be resolved within 24 hours.", groundedTexts: [timeline] })).toContain("ungrounded_number");
  });
  it("blocks an amount from a record", () => {
    expect(reasonsOf({ reply: "The payout was 2400 dollars.", groundedTexts: ["This transaction is still processing."] })).toContain("ungrounded_number");
  });
  // The caller's own figure may be repeated only to refuse it. Asserting it states a fact the
  // agent has no source for; denying it cannot mislead anyone.
  it("blocks a time asserted, allows the caller's own time inside a refusal", () => {
    expect(reasonsOf({ reply: "It should be there by 9am." })).toContain("ungrounded_number");
    expect(reasonsOf({ reply: "It should be there by 9am.", callerTexts: ["Will it arrive by 9am tomorrow?"] })).toContain("ungrounded_number");
    expect(checkReply(base({ reply: "I can't promise it by 9am.", callerTexts: ["Will it arrive by 9am tomorrow?"] })).ok).toBe(true);
    expect(checkReply(base({ reply: "I can't promise a specific arrival time." })).ok).toBe(true);
  });
  it("allows a past date the tool sentence supplied", () => {
    expect(checkReply(base({ reply: "It was expected on August 19.", groundedTexts: ["This transaction is still processing. It was expected on August 19."] })).ok).toBe(true);
  });
  it("blocks currency words the caller never used", () => {
    expect(reasonsOf({ reply: "That was a payment in euros." })).toContain("currency");
    expect(checkReply(base({ reply: "Do you mean euros?", callerTexts: ["I sent euros"] })).ok).toBe(true);
  });
});

describe("identifiers", () => {
  it("allows reading back an ID the caller gave", () => {
    expect(checkReply(base({ reply: "Just to confirm, that is TXN-9001?", callerTexts: ["can you check TXN-9001"] })).ok).toBe(true);
  });
  it("blocks an ID the caller never gave", () => {
    expect(reasonsOf({ reply: "The linked transaction is TXN-9003." })).toContain("ungrounded_number");
  });
  it("never speaks a customer ID, even one the caller gave", () => {
    expect(reasonsOf({ reply: "Your customer ID is CUS-1001.", callerTexts: ["my id is CUS-1001"] })).toContain("customer_id");
  });
});

describe("customer-record disclosure", () => {
  it.each([
    "You are on the Growth plan.",
    "Your account is restricted.",
    "Your account is currently pending verification.",
    "Your KYC status is approved.",
    "The account status shows active.",
    "The support notes say to escalate.",
  ])("blocks: %s", (reply) => {
    expect(checkReply(base({ reply })).ok).toBe(false);
  });

  // Tightened after the adversarial review: a record name is never spoken, because saying it
  // back confirms it. A caller guessing a company name must not get it confirmed.
  it("blocks a name from a record even when the caller said it first", () => {
    const forbiddenNames = ["Bright Studio", "LagosLedger"];
    expect(reasonsOf({ reply: "The payout is going to Bright Studio.", forbiddenNames })).toContain("record_name");
    expect(reasonsOf({ reply: "Thanks, I have LagosLedger noted.", forbiddenNames, callerTexts: ["I am Amara from LagosLedger"] })).toContain("record_name");
  });

  it("blocks an email the caller never gave, allows the caller's own for read-back", () => {
    expect(reasonsOf({ reply: "I have amara@lagosledger.example on file." })).toContain("email");
    expect(checkReply(base({ reply: "Is that jo@example.com?", callerTexts: ["it's jo@example.com"] })).ok).toBe(true);
  });
});

describe("promises the knowledge base forbids", () => {
  it.each([
    "I've booked a callback for you.",
    "Your callback is scheduled for tomorrow.",
    "I have emailed the team.",
    "The specialist has read your brief.",
    "RelayPay guarantees your payout will arrive.",
    "I promise this will be fixed.",
    "Rest assured, it will be resolved.",
  ])("blocks: %s", (reply) => {
    expect(checkReply(base({ reply })).ok).toBe(false);
  });

  // Tightened: the claim is only speakable once the record exists, not because it is phrased well.
  it("allows the escalation tool's own sentence only when the escalation record exists", () => {
    const reply = "Your request is logged and a support representative will follow up. No callback time has been confirmed.";
    expect(checkReply(base({ reply, records: { escalationExists: true, ticketExists: true } })).ok).toBe(true);
    expect(reasonsOf({ reply })).toContain("unbacked_claim");
  });

  it("a distant negation earlier in the reply does not excuse a promise", () => {
    expect(checkReply(base({ reply: "That won't be a problem at all, and rest assured it is handled." })).ok).toBe(false);
  });

  it("allows declining to guarantee", () => {
    expect(checkReply(base({ reply: "I'm sorry, RelayPay can't guarantee payout timing.", callerTexts: [] })).ok).toBe(true);
    expect(checkReply(base({ reply: "RelayPay does not guarantee a specific arrival time." })).ok).toBe(true);
  });
});

describe("voice hygiene", () => {
  it.each([
    ["markdown bold", "Here is **the answer**."],
    ["a bullet list", "Options:\n- one\n- two"],
    ["a URL", "See https://relaypay.example/help for more."],
    ["a link", "Click [here](x)."],
  ])("blocks %s", (_n, reply) => {
    expect(reasonsOf({ reply })).toContain("markup");
  });
  it("blocks an empty reply and an overlong one", () => {
    expect(reasonsOf({ reply: "   " })).toContain("empty");
    expect(reasonsOf({ reply: "word ".repeat(200) })).toContain("too_long");
  });
});

describe("reporting", () => {
  it("lists every reason that tripped", () => {
    const r = checkReply(base({ reply: "Your account is restricted and I've booked a callback within 48 hours." }));
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });
});

// All three were found in one real voice call. The caller said "My payments are currently stuck"
// and "Yes, please. Thank you." — both transcribed perfectly — and heard "Sorry, I didn't catch
// that." The guard had censored the agent's own reply, and the apology blamed the caller for it.
describe("replies the guard wrongly refused on a real call", () => {
  const speak = (reply: string, groundedTexts: string[] = []) =>
    checkReply({
      reply, callerTexts: [], groundedTexts, forbiddenNames: [],
      records: { escalationExists: false, ticketExists: false },
    });

  test("the contact read-back the prompt itself instructs the agent to say", () => {
    // The prompt mandates this sentence. The guard forbade it, so the escalation flow could not
    // begin: a rule that contradicts the instructions is a rule that breaks every call.
    expect(speak("Don't worry if I don't catch the spelling — you'll be able to check your name and email before this is sent.").ok).toBe(true);
  });

  test("an intention to log is not a claim that anything was logged", () => {
    expect(speak("To get this logged, I'll need a few details.").ok).toBe(true);
  });

  test("ordinary English containing a number word is not a figure", () => {
    // "one of them" became "1 of them", so a correct answer carrying no figure at all was
    // rejected as an ungrounded number.
    const grounded = ["Payments can be delayed by bank processing times, public holidays, compliance reviews, or issues with beneficiary details."];
    expect(speak("Do you have a transaction or payout reference number for one of them?", grounded).ok).toBe(true);
    expect(speak("One moment while I check that.").ok).toBe(true);
  });

  test("the real claims those three fixes must not have weakened", () => {
    for (const reply of [
      "I have logged this with the team.",
      "Your callback is booked.",
      "I have emailed you a confirmation.",
      "Your payout will arrive in three business days.",
      "A specialist will call you at nine am.",
    ]) {
      expect(speak(reply).ok, `should still be blocked: ${reply}`).toBe(false);
    }
  });
});

// A guard trip is our failure, not the caller's. Telling them they were misheard sends them to
// repeat themselves, and the false apology enters the history the model reads — which is how one
// censored reply turned every later "Yes." into "I didn't catch that".
describe("what is said when the guard replaces a reply", () => {
  test("never claims the caller was misheard", () => {
    expect(guardRetryLine("What is your name?")).not.toMatch(/didn't (quite )?catch/i);
    expect(guardRetryLine(null)).not.toMatch(/didn't (quite )?catch/i);
  });

  test("puts the question again so the call can carry on", () => {
    expect(guardRetryLine("What is your name?")).toContain("What is your name?");
  });

  test("does not repeat one of our own apologies back", () => {
    expect(guardRetryLine(DIDNT_CATCH)).not.toMatch(/didn't catch/i);
  });
});

// Found on a real call: once any escalation existed, EVERY later guard trip spoke this fixed line
// claiming "no callback time has been confirmed" — including when the topic being retried was a
// callback readback that had nothing to do with the earlier escalation, and even though a booked
// callback is now a real, checkable thing. The line must not assert anything about callbacks
// either way, since it is spoken for any exhausted retry, on any topic.
describe("the exhausted-retry line makes no claim about a callback", () => {
  it("says nothing about a callback in either direction", () => {
    expect(ESCALATED_FALLBACK.toLowerCase()).not.toContain("callback");
  });
});

describe("a verified caller may hear only the account facts the lookup returned", () => {
  const FACTS = ["Their plan is Growth. Their account status is active. Their verification status is approved."];
  const check = (reply: string, accountFacts?: string[]) => checkReply(base({ reply, accountFacts }));

  it("is blocked without a verified lookup, exactly as before", () => {
    expect(check("You are on the Growth plan and your account is active.").reasons).toContain("record_field");
  });

  it("is allowed when the lookup returned exactly those facts", () => {
    expect(check("You are on the Growth plan, your account is active and verification is approved.", FACTS).reasons).not.toContain("record_field");
  });

  it("a plan the record does not hold is still blocked", () => {
    expect(check("You are on the Scale plan.", FACTS).reasons).toContain("record_field");
  });

  it("a status the record does not hold is still blocked", () => {
    expect(check("Your account is restricted.", FACTS).reasons).toContain("record_field");
  });

  it("support notes are never speakable, verified or not", () => {
    expect(check("The support notes say your account has normal access.", FACTS).reasons).toContain("record_field");
  });

  it("an explanation of why an account is under review is never speakable", () => {
    const f = ["Their plan is Scale. Their account status is restricted. Their verification status is review required."];
    expect(check("Your account is restricted because compliance flagged it for review.", f).reasons).toContain("record_field");
  });
});
