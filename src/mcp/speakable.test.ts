import { describe, expect, it } from "vitest";
import { payoutSpeakable, transactionSpeakable, type PayoutRow, type TransactionRow } from "./speakable.js";

const TODAY = "2026-09-30";

const txn = (over: Partial<TransactionRow>): TransactionRow => ({
  transaction_id: "TXN-9001",
  customer_id: "CUS-1001",
  transaction_type: "outgoing payout",
  amount: 2400,
  currency: "USD",
  status: "processing",
  estimated_arrival: "2026-08-19",
  support_summary: "Payout is processing within the normal expected window.",
  ...over,
});

const payout = (over: Partial<PayoutRow>): PayoutRow => ({
  payout_id: "PAY-7001",
  transaction_id: "TXN-9001",
  customer_id: "CUS-1001",
  recipient_name: "Bright Studio",
  amount: 2400,
  currency: "USD",
  status: "processing",
  scheduled_for: "2026-08-18",
  failure_reason: null,
  ...over,
});

describe("transactionSpeakable", () => {
  it("speaks a past arrival date as 'was expected', never as future (TXN-9001)", () => {
    const { speakable } = transactionSpeakable(txn({}), [], TODAY);
    expect(speakable).toContain("It was expected on August 19.");
    expect(speakable).not.toMatch(/will arrive|expected around/i);
  });

  it("says nothing about an empty arrival date the caller did not ask about (TXN-9004)", () => {
    const r = transactionSpeakable(
      txn({ transaction_id: "TXN-9004", status: "failed", estimated_arrival: null, support_summary: "Payout failed because beneficiary details need review." }),
      [],
      TODAY,
    );
    expect(r.speakable).not.toMatch(/arriv|expected|missing|unknown/i);
    expect(r.unavailable_fields).toEqual([]);
  });

  it("reports estimated_arrival as unavailable ONLY when the caller asked for it (#62)", () => {
    const row = txn({ transaction_id: "TXN-9004", status: "failed", estimated_arrival: null });
    expect(transactionSpeakable(row, ["estimated_arrival"], TODAY).unavailable_fields).toEqual(["estimated_arrival"]);
    expect(transactionSpeakable(row, [], TODAY).unavailable_fields).toEqual([]);
  });

  it("negative: asking only for a routine status does not raise unavailable fields (TXN-9001)", () => {
    expect(transactionSpeakable(txn({}), ["summary"], TODAY).unavailable_fields).toEqual([]);
  });

  it("never speaks amounts, IDs, currency or names", () => {
    const { speakable } = transactionSpeakable(txn({}), [], TODAY);
    expect(speakable).not.toMatch(/2400|USD|TXN-|CUS-|1001/);
  });

  it("drops internal routing sentences from the record's summary", () => {
    const { speakable } = transactionSpeakable(
      txn({ status: "review required", estimated_arrival: null, support_summary: "Transaction requires compliance review. Escalate account-specific questions." }),
      [],
      TODAY,
    );
    expect(speakable).not.toMatch(/escalate|compliance/i);
    expect(speakable).toMatch(/review/i);
  });

  it("falls back to a generic line for an unknown status instead of guessing", () => {
    const { speakable } = transactionSpeakable(txn({ status: "quantum superposition", support_summary: null, estimated_arrival: null }), [], TODAY);
    expect(speakable).toMatch(/specialist/i);
  });

  it("a stale or contradictory record summary can never override the status", () => {
    const { speakable } = transactionSpeakable(
      txn({ status: "failed", estimated_arrival: null, support_summary: "Payout is processing within the normal expected window." }),
      [],
      TODAY,
    );
    expect(speakable).toMatch(/did not go through/i);
    expect(speakable).not.toMatch(/processing/i);
  });

  it("a completed transaction speaks no arrival unless asked, and asking a completed one is not 'unavailable'", () => {
    const done = txn({ status: "completed", estimated_arrival: "2026-08-15" });
    expect(transactionSpeakable(done, [], TODAY).speakable).not.toMatch(/expected/i);
    expect(transactionSpeakable(done, ["estimated_arrival"], TODAY).speakable).toContain("It was expected on August 15.");
    expect(transactionSpeakable({ ...done, estimated_arrival: null }, ["estimated_arrival"], TODAY).unavailable_fields).toEqual([]);
  });

  it("normalises status wording from the boundary", () => {
    const { speakable } = transactionSpeakable(txn({ status: "Review_Required", support_summary: null, estimated_arrival: null }), [], TODAY);
    expect(speakable).toMatch(/under review/i);
  });
});

describe("payoutSpeakable", () => {
  it("PAY-7001: composes a summary with no invented failure reason", () => {
    const { speakable, unavailable_fields } = payoutSpeakable(payout({}), [], TODAY);
    expect(speakable).toMatch(/processing/i);
    expect(speakable).not.toMatch(/fail|because|reason/i);
    expect(unavailable_fields).toEqual([]);
  });

  it("PAY-7001: asking for the failure reason says none is recorded, not 'unknown'", () => {
    const { speakable, unavailable_fields } = payoutSpeakable(payout({}), ["failure_reason"], TODAY);
    expect(speakable).toMatch(/no failure recorded/i);
    expect(unavailable_fields).toEqual([]);
  });

  it("a FAILED payout with no reason is unavailable when asked (#62)", () => {
    const { unavailable_fields } = payoutSpeakable(payout({ status: "failed", failure_reason: null }), ["failure_reason"], TODAY);
    expect(unavailable_fields).toEqual(["failure_reason"]);
  });

  it("PAY-7002: says it requires review, does not repeat the compliance reason or name the recipient", () => {
    const { speakable } = payoutSpeakable(
      payout({ payout_id: "PAY-7002", status: "review required", failure_reason: "compliance review", recipient_name: "Kente Labs", scheduled_for: "2026-08-16" }),
      [],
      TODAY,
    );
    expect(speakable).toMatch(/requires review/i);
    expect(speakable).toContain("It was scheduled for August 16.");
    expect(speakable).not.toMatch(/compliance|Kente|5300|GBP/i);
  });

  it("never speaks a failure reason that is not on the reviewed allowlist, and asking for it is unavailable", () => {
    const row = payout({ status: "failed", failure_reason: "Recipient failed sanctions screening." });
    const plain = payoutSpeakable(row, [], TODAY);
    expect(plain.speakable).not.toMatch(/sanction|screening|because/i);
    expect(plain.speakable).toMatch(/failed/i);
    expect(payoutSpeakable(row, ["failure_reason"], TODAY).unavailable_fields).toEqual(["failure_reason"]);
  });

  it("asking for the schedule of a payout with no date is unavailable, but a completed one is not", () => {
    expect(payoutSpeakable(payout({ scheduled_for: null }), ["scheduled_for"], TODAY).unavailable_fields).toEqual(["scheduled_for"]);
    expect(payoutSpeakable(payout({ status: "completed", scheduled_for: null }), ["scheduled_for"], TODAY).unavailable_fields).toEqual([]);
  });

  it("speaks the customer-safe failure reason only when the payout actually failed (PAY-7003)", () => {
    const { speakable } = payoutSpeakable(
      payout({ payout_id: "PAY-7003", status: "failed", failure_reason: "beneficiary details need review", scheduled_for: "2026-08-15" }),
      [],
      TODAY,
    );
    expect(speakable).toMatch(/failed because beneficiary details need review/i);
  });
});
