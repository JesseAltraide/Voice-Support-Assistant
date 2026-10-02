import { describe, expect, test } from "vitest";
import { checkReply } from "./guard.js";

const NO_RECORDS = { escalationExists: false, ticketExists: false };

const speak = (reply: string, groundedTexts: string[] = []) =>
  checkReply({ reply, callerTexts: [], groundedTexts, forbiddenNames: [], records: NO_RECORDS });

// A payout has a scheduled date on its record. Reading that back is a fact; the rule that stops
// the agent promising a callback was swallowing it, which cost the payout scenario its answer.
describe("a scheduled date on a record is not a booking", () => {
  const grounded = ["This payout is under review. It was scheduled for August 16."];

  test.each([
    "This payout requires review. It was scheduled for August 16.",
    "Your payout was scheduled for August 16.",
  ])("says %j", (reply) => {
    expect(speak(reply, grounded).ok).toBe(true);
  });
});

// What the rule is actually for: nothing in this system can book a human being.
describe("scheduling a person is still forbidden", () => {
  test.each([
    "A callback is scheduled for tomorrow.",
    "Someone has been scheduled to call you.",
    "I have scheduled a call for you.",
    "A specialist is scheduled to review it.",
    "Your appointment was scheduled.",
    "A callback is booked.",
    "I have arranged for someone to ring you.",
  ])("refuses %j", (reply) => {
    const result = speak(reply);
    expect(result.ok, `should have been blocked: ${reply}`).toBe(false);
    expect(result.reasons).toContain("promise");
  });
});

// The escalation read-back the flow depends on: stating what is about to be sent is an
// intention, not a claim that it has been sent.
describe("intent is sayable, completion is not", () => {
  test.each([
    "I'll escalate this to the appropriate team.",
    "I'm going to send this to a specialist.",
    "This is what I'm going to send to the specialist: your invoice payment failed.",
    "So what I'm getting is your invoice payment failed and you need someone to look at it. Is that right?",
    "Let me put this in front of a specialist.",
  ])("allows %j", (reply) => {
    expect(speak(reply).ok, `should have been allowed: ${reply}`).toBe(true);
  });

  test.each([
    "I've escalated this for you.",
    "I have logged this with the team.",
  ])("refuses %j when no record exists", (reply) => {
    expect(speak(reply).ok).toBe(false);
  });

  test("a time commitment is still a promise, even about our own work", () => {
    expect(speak("I'll escalate this to the appropriate team right away.").ok).toBe(false);
  });
});
