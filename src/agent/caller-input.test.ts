import { describe, expect, it } from "vitest";
import { classifyInput, isRepeatQuestion } from "./caller-input.js";

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
