import { describe, expect, test } from "vitest";
import { isClosing } from "./caller-input.js";

const WRAP_UP = "Is there anything else I can help you with?";
const OTHER_QUESTION = "Is that the right transaction, the one on the 14th?";

describe("the caller says the call is over", () => {
  test.each([
    "goodbye",
    "bye",
    "ok bye",
    "thanks, goodbye",
    "no that's all",
    "that's everything, thanks",
    "nothing else",
    "nothing further",
    "we're done",
    "I'm done",
    "that's it, thank you",
    "thanks, have a good day",
    "that's all for now",
  ])("closes on %j", (text) => {
    expect(isClosing(text, WRAP_UP)).toBe(true);
  });

  test("a farewell closes the call whatever was asked before it", () => {
    expect(isClosing("goodbye", OTHER_QUESTION)).toBe(true);
    expect(isClosing("that's everything", null)).toBe(true);
  });
});

// Ending a call that was not finished is far worse than leaving one running a few seconds longer,
// so everything below must stay open.
describe("what must not end the call", () => {
  test.each([
    "that's all I know",
    "that's all I remember about it",
    "that's all the detail I have",
    "that's everything I can recall",
    "that's all I said to them",
  ])("keeps the line open on %j — the caller is still answering", (text) => {
    expect(isClosing(text, WRAP_UP)).toBe(false);
  });

  test("a bare no answers a question that is not a wrap-up", () => {
    expect(isClosing("no", OTHER_QUESTION)).toBe(false);
    expect(isClosing("nope", "Did the payment leave your account?")).toBe(false);
  });

  test("a bare no with no preceding question is not a sign-off", () => {
    expect(isClosing("no", null)).toBe(false);
    expect(isClosing("no", undefined)).toBe(false);
  });

  test("a bare no does close after a wrap-up question", () => {
    expect(isClosing("no", WRAP_UP)).toBe(true);
    expect(isClosing("no thanks", "Anything else before I let you go?")).toBe(true);
  });

  test.each([
    "can I ask something else?",
    "is that everything you need from me?",
    "no, why is that?",
  ])("a question is never a sign-off: %j", (text) => {
    expect(isClosing(text, WRAP_UP)).toBe(false);
  });

  test("a long sentence containing the words is still making a point", () => {
    const text = "well that's all very well but I still have not been told why the payout was late";
    expect(isClosing(text, WRAP_UP)).toBe(false);
  });

  test.each(["", "   ", "um", "hello", "yes", "my payout is late", "I need help with an invoice"])(
    "does not close on %j",
    (text) => {
      expect(isClosing(text, WRAP_UP)).toBe(false);
    },
  );

  test("a no inside a longer sentence is not the bare acknowledgement", () => {
    expect(isClosing("no I still need the invoice", WRAP_UP)).toBe(false);
  });
});

describe("robustness", () => {
  test("punctuation and case do not matter", () => {
    expect(isClosing("THAT'S ALL!", WRAP_UP)).toBe(true);
    expect(isClosing("That's all.", WRAP_UP)).toBe(true);
    expect(isClosing("thats all", WRAP_UP)).toBe(true);
  });

  test("the wrap-up question is matched case-insensitively too", () => {
    expect(isClosing("no", "ANYTHING ELSE?")).toBe(true);
  });
});
