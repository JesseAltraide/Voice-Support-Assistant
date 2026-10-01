import { describe, expect, it } from "vitest";
import { checkReply, type GuardInput } from "./guard.js";

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
