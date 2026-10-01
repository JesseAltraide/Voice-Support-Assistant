import { describe, expect, it } from "vitest";
import { deriveAnswerType, needsWorkFirst, parseTypedReply, unresolvedIncrement, type TurnFacts } from "./turn-type.js";

const facts = (over: Partial<TurnFacts> = {}): TurnFacts => ({
  escalationCreated: false,
  groundedSearch: false,
  ungroundedSearch: false,
  foundLookup: false,
  toolsFailed: false,
  missedLookup: false,
  ...over,
});

describe("parseTypedReply", () => {
  it("reads the type line and returns only the spoken text", () => {
    expect(parseTypedReply("TYPE: clarify\nIs it incoming or outgoing?")).toEqual({ type: "clarify", text: "Is it incoming or outgoing?" });
  });
  it("is tolerant of case, spacing and a leaked tag", () => {
    expect(parseTypedReply("type:  Answer_Directly \nFees vary.").type).toBe("answer_directly");
    expect(parseTypedReply("<type>decline</type>\nI can't answer that.")).toEqual({ type: "decline", text: "I can't answer that." });
  });
  it("returns null type and untouched text when there is no tag", () => {
    expect(parseTypedReply("Hello there.")).toEqual({ type: null, text: "Hello there." });
  });
  it("treats an unknown type as no type, and still strips the line", () => {
    expect(parseTypedReply("TYPE: banana\nHello.")).toEqual({ type: null, text: "Hello." });
  });
  it("does not let a TYPE line in the middle of the reply be spoken", () => {
    expect(parseTypedReply("Sure.\nTYPE: decline").text).toBe("Sure.");
  });
  it("strips stray tool-call scaffolding from the spoken text", () => {
    expect(parseTypedReply("TYPE: conversational\n<function_calls>x</function_calls>Hi!").text).toBe("Hi!");
  });
});

describe("deriveAnswerType", () => {
  it("an escalation record that exists wins over anything the model declared", () => {
    expect(deriveAnswerType("conversational", facts({ escalationCreated: true })).type).toBe("escalate");
  });
  it("answer_directly needs a grounded search or a found lookup this turn", () => {
    expect(deriveAnswerType("answer_directly", facts({ groundedSearch: true })).type).toBe("answer_directly");
    expect(deriveAnswerType("answer_directly", facts({ foundLookup: true })).type).toBe("answer_directly");
  });
  it("negative: answer_directly with no retrieval is downgraded to decline, with a note", () => {
    const r = deriveAnswerType("answer_directly", facts());
    expect(r.type).toBe("decline");
    expect(r.note).toMatch(/no retrieval/i);
  });
  it("negative: answer_directly after an EMPTY search is downgraded too", () => {
    expect(deriveAnswerType("answer_directly", facts({ ungroundedSearch: true })).type).toBe("decline");
  });
  it("flags a downgrade so the spoken reply can be replaced, not just relabelled", () => {
    expect(deriveAnswerType("answer_directly", facts()).downgraded).toBe(true);
    expect(deriveAnswerType("answer_directly", facts({ groundedSearch: true })).downgraded).toBeFalsy();
    expect(deriveAnswerType("decline", facts()).downgraded).toBeFalsy();
    expect(deriveAnswerType(null, facts()).downgraded).toBeFalsy();
  });
  it("no declared type: grounded work is an answer, otherwise conversational", () => {
    expect(deriveAnswerType(null, facts({ groundedSearch: true })).type).toBe("answer_directly");
    expect(deriveAnswerType(null, facts()).type).toBe("conversational");
  });
  it("keeps clarify, decline, off_topic and conversational as declared", () => {
    for (const t of ["clarify", "decline", "off_topic", "conversational"] as const) {
      expect(deriveAnswerType(t, facts()).type).toBe(t);
    }
  });
  it("escalate declared but no record yet is kept, with a note that it is still collecting details", () => {
    const r = deriveAnswerType("escalate", facts());
    expect(r.type).toBe("escalate");
    expect(r.note).toMatch(/no escalation record/i);
  });
});

describe("needsWorkFirst (Rule 2: do the work, do not just ask)", () => {
  it("a first clarifying question with no tool work behind it must be sent back", () => {
    expect(needsWorkFirst({ type: "clarify", toolCallCount: 0, clarifyStreakBefore: 0 })).toBe(true);
  });
  it("negative: a clarifying question that came with a search or lookup is fine", () => {
    expect(needsWorkFirst({ type: "clarify", toolCallCount: 1, clarifyStreakBefore: 0 })).toBe(false);
  });
  it("negative: a follow-up clarify in the same streak is not sent back again", () => {
    expect(needsWorkFirst({ type: "clarify", toolCallCount: 0, clarifyStreakBefore: 1 })).toBe(false);
  });
  it("negative: only clarify turns are affected", () => {
    for (const type of ["answer_directly", "escalate", "decline", "conversational", "off_topic"] as const) {
      expect(needsWorkFirst({ type, toolCallCount: 0, clarifyStreakBefore: 0 })).toBe(false);
    }
  });
});

describe("unresolvedIncrement: a reply the caller could not use counts", () => {
  it("a guard trip counts, because the caller got a refusal instead of an answer", () => {
    expect(unresolvedIncrement("decline", facts(), 0, { guardTripped: true })).toBe(1);
  });
  it("any decline counts, not only one that followed an empty search", () => {
    expect(unresolvedIncrement("decline", facts(), 0)).toBe(1);
  });
  it("a repeated question counts, because the previous answer did not land", () => {
    expect(unresolvedIncrement("answer_directly", facts({ groundedSearch: true }), 0, { repeatQuestion: true })).toBe(1);
  });
  it("negative: a good answer to a new question still counts nothing", () => {
    expect(unresolvedIncrement("answer_directly", facts({ groundedSearch: true }), 0)).toBe(0);
    expect(unresolvedIncrement("conversational", facts(), 0)).toBe(0);
    expect(unresolvedIncrement("off_topic", facts(), 0, { repeatQuestion: true })).toBe(0);
  });
  it("never counts more than one per turn", () => {
    expect(unresolvedIncrement("decline", facts({ ungroundedSearch: true }), 3, { guardTripped: true, repeatQuestion: true })).toBe(1);
  });
});

describe("unresolvedIncrement (#43)", () => {
  it("a decline after an empty knowledge search counts once", () => {
    expect(unresolvedIncrement("decline", facts({ ungroundedSearch: true }), 0)).toBe(1);
  });
  it("negative: off-topic, conversational and answered turns never count", () => {
    expect(unresolvedIncrement("off_topic", facts(), 0)).toBe(0);
    expect(unresolvedIncrement("conversational", facts(), 0)).toBe(0);
    expect(unresolvedIncrement("answer_directly", facts({ groundedSearch: true }), 0)).toBe(0);
  });
  it("a decline caused by a lookup miss is NOT counted again (the tool already counted it)", () => {
    expect(unresolvedIncrement("decline", facts({ missedLookup: true }), 0)).toBe(0);
  });
  it("a second consecutive clarify counts, the first does not", () => {
    expect(unresolvedIncrement("clarify", facts(), 1)).toBe(0);
    expect(unresolvedIncrement("clarify", facts(), 2)).toBe(1);
  });
});
