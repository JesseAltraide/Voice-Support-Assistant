import { describe, expect, it, test } from "vitest";
import { classifyInput, isClosing, isPlainAnswer, isRepeatQuestion } from "./caller-input.js";

describe("classifyInput", () => {
  it.each([
    ["", "empty"],
    ["   ", "empty"],
    ["\n\t ", "empty"],
  ])("treats %j as empty", (text, kind) => {
    expect(classifyInput(text).kind).toBe(kind);
  });

  it.each([
    "uh",
    "um",
    "mm",
    "hmm",
    "ah",
    "erm",
    "uh um uh",
    "...",
    "?!",
    "a",
    "mmmmmmm",
  ])("treats %j as noise the transcriber produced, not speech", (text) => {
    expect(classifyInput(text).kind).toBe("noise");
  });

  it.each([
    "hi",
    "no",
    "yes",
    "ok",
    "TXN-9001",
    "my payment is stuck",
    "what fees do you charge",
    "yes that's right",
  ])("treats %j as real speech", (text) => {
    expect(classifyInput(text).kind).toBe("ok");
  });

  it("negative: a short but meaningful answer during escalation is not noise", () => {
    expect(classifyInput("Jo Smith").kind).toBe("ok");
    expect(classifyInput("tomorrow").kind).toBe("ok");
  });

  it("treats a transcript with no letters or digits as noise", () => {
    expect(classifyInput("--- ,,, ...").kind).toBe("noise");
  });
});

describe("isRepeatQuestion", () => {
  it("spots the same question asked again in different words", () => {
    const prior = ["what fees do you charge for international payments"];
    expect(isRepeatQuestion("what fees do you charge for international payments", prior)).toBe(true);
    expect(isRepeatQuestion("what are the fees you charge for international payments?", prior)).toBe(true);
  });

  it("negative: a different question is not a repeat", () => {
    const prior = ["what fees do you charge for international payments"];
    expect(isRepeatQuestion("how long do payouts take", prior)).toBe(false);
    expect(isRepeatQuestion("my account was restricted", prior)).toBe(false);
  });

  it("negative: short confirmations are never repeats, however often they occur", () => {
    const prior = ["yes", "yes", "ok"];
    expect(isRepeatQuestion("yes", prior)).toBe(false);
    expect(isRepeatQuestion("ok", prior)).toBe(false);
  });

  it("negative: nothing to compare against is not a repeat", () => {
    expect(isRepeatQuestion("what fees do you charge", [])).toBe(false);
  });

  it("ignores filler words when comparing", () => {
    expect(isRepeatQuestion("so what are the fees then", ["what are the fees"])).toBe(true);
  });
});

// Found on a real call: "All right. Thank you very much." never matched FAREWELL (no "bye" or
// "done" in it) and left the call open with no end marker, even right after the agent asked
// "is there anything else".
describe("a plain thank-you after a wrap-up question is a sign-off", () => {
  const WRAP_UP = "Your callback is arranged. Is there anything else I can help you with?";

  test.each([
    "All right. Thank you very much.",
    "Thanks!",
    "Thank you so much, appreciate it.",
    "Okay, great, thanks a lot.",
  ])("closes on %j", (text) => {
    expect(isClosing(text, WRAP_UP)).toBe(true);
  });

  test.each([
    "Thanks, but can you also check my other transaction?",
    "Thanks, but can you also check my other transaction",
    "Thank you, I think my payout is still delayed",
  ])("does not close on %j — a real word slipped in", (text) => {
    expect(isClosing(text, WRAP_UP)).toBe(false);
  });

  test("the same gratitude mid-conversation, with no wrap-up question before it, does not close", () => {
    expect(isClosing("Thank you very much", "Your fees depend on the corridor and currency.")).toBe(false);
  });
});

describe("isPlainAnswer", () => {
  test.each(["Yes.", "Yes, I'd like that.", "No, thank you.", "Yeah okay", "Sure, go ahead", "No"])("%j is a plain answer", (t) => {
    expect(isPlainAnswer(t)).toBe(true);
  });
  test.each(["", "My cat is stuck", "I want to set up my account", "Yes I would like to know about the fees for international payments please", "Tell me about it"])(
    "%j is not",
    (t) => {
      expect(isPlainAnswer(t)).toBe(false);
    },
  );
});
