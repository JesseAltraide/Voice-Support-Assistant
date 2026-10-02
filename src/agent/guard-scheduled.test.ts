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

// A callback is the one commitment this system can actually keep, once a row says so. Before the
// booking table existed the rule refused it outright, because nothing could make it true.
describe("a booked callback is sayable, an unbooked one is not", () => {
  const withBooking = (reply: string, callbackBooked: boolean) =>
    checkReply({
      reply,
      callerTexts: [],
      groundedTexts: [],
      forbiddenNames: [],
      records: { escalationExists: true, ticketExists: false, callbackBooked },
    });

  const CLAIMS = ["Your callback is booked for Tuesday at 10.", "I have arranged your callback."];

  test.each(CLAIMS)("allows %j once the booking exists", (reply) => {
    expect(withBooking(reply, true).ok, `should have been allowed: ${reply}`).toBe(true);
  });

  test.each(CLAIMS)("refuses %j when nothing was booked", (reply) => {
    const result = withBooking(reply, false);
    expect(result.ok, `should have been blocked: ${reply}`).toBe(false);
    expect(result.reasons).toContain("promise");
  });

  // The exemption is for the booking claim alone. Everything else the rule forbids stays
  // forbidden in the same breath, so a real booking cannot be used to smuggle one through.
  test.each([
    "Someone has already reviewed your case.",
    "A specialist will call you tomorrow.",
    "I have scheduled a call for you right away.",
  ])("a real booking does not license %j", (reply) => {
    expect(withBooking(reply, true).ok, `should have been blocked: ${reply}`).toBe(false);
  });
});

// A reply is only as safe as its worst sentence. The first version of the booking exemption
// tested the whole reply at once, so one true booking sentence waved through every other promise
// beside it — and the single-sentence tests above could never have caught it.
describe("a booking does not launder the rest of the reply", () => {
  const ok = (reply: string, callbackBooked = true) =>
    checkReply({
      reply, callerTexts: [], groundedTexts: [], forbiddenNames: [],
      records: { escalationExists: true, ticketExists: false, callbackBooked },
    }).ok;

  test.each([
    "Your callback is booked for Tuesday at 10. Someone has already reviewed your case.",
    "Your callback is booked for Tuesday at 10. I have emailed you a confirmation.",
    "I have arranged your callback. Rest assured, I promise it will be sorted.",
    "I have arranged your callback. I have notified the team.",
  ])("refuses %j", (reply) => {
    expect(ok(reply), `should have been blocked: ${reply}`).toBe(false);
  });

  test.each([
    "Your callback is booked for Tuesday at 10.",
    "Your callback is booked for Tuesday at 10. Is there anything else I can help you with?",
    "I have arranged your callback. You will see it on your dashboard.",
  ])("still allows %j", (reply) => {
    expect(ok(reply), `should have been allowed: ${reply}`).toBe(true);
  });
});
