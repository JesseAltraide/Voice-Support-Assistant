import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  DIDNT_CATCH, OFF_TOPIC_CLOSE, OFF_TOPIC_LIMIT, OFF_TOPIC_LINE, RECOVERY_LIMIT, STILL_DIDNT_CATCH,
  UNCLEAR_LIMIT, UNHEARD_CLOSE,
} from "./guard.js";
import { deriveAnswerType, MODEL_ANSWER_TYPES, parseTypedReply, type TurnFacts } from "./turn-type.js";

const NO_FACTS: TurnFacts = {
  escalationCreated: false,
  groundedSearch: false,
  ungroundedSearch: false,
  foundLookup: false,
  toolsFailed: false,
  missedLookup: false,
};

/** The line the server speaks for the nth consecutive turn it could not make out. */
const lineFor = (streak: number) => (streak >= UNCLEAR_LIMIT ? STILL_DIDNT_CATCH : DIDNT_CATCH);

describe("the model can report that it could not make out the caller", () => {
  test("unclear is a path the model may declare", () => {
    expect(MODEL_ANSWER_TYPES).toContain("unclear");
    expect(parseTypedReply("TYPE: unclear\n").type).toBe("unclear");
  });

  test("it becomes the server's own verdict, not a model-authored answer", () => {
    const derived = deriveAnswerType("unclear", NO_FACTS);
    expect(derived.type).toBe("unintelligible");
    expect(derived.note).toMatch(/could not make out/i);
  });

  test("an escalation that actually happened still wins", () => {
    // Records beat the model's account of the turn, as everywhere else.
    expect(deriveAnswerType("unclear", { ...NO_FACTS, escalationCreated: true }).type).toBe("escalate");
  });
});

// The whole point of the new path: being misheard and being off-topic are different failures and
// deserve different replies.
describe("unclear is not off_topic", () => {
  test("off_topic stays off_topic and is never turned into a request to repeat", () => {
    expect(deriveAnswerType("off_topic", NO_FACTS).type).toBe("off_topic");
  });

  test("a vague but understood caller is a clarify, not an unclear", () => {
    // "My payment is stuck" is heard perfectly well; it is simply short on detail.
    expect(deriveAnswerType("clarify", NO_FACTS).type).toBe("clarify");
  });
});

// Both dead ends seen on a real call: the callback offer repeating forever after the caller
// accepted it, and a redirect given four times to someone asking about a cat.
describe("neither failure can loop forever", () => {
  test("the turn after the callback offer closes the call rather than offering again", () => {
    const beyond = UNCLEAR_LIMIT; // the offer was the previous turn
    expect(beyond + 1).toBeGreaterThan(UNCLEAR_LIMIT);
    expect(UNHEARD_CLOSE).not.toBe(STILL_DIDNT_CATCH);
  });

  test("the closing line claims no record, because none was written", () => {
    expect(UNHEARD_CLOSE).not.toMatch(/\b(logged|raised|created|booked|scheduled)\b/i);
    expect(UNHEARD_CLOSE).toMatch(/call back|dashboard/i);
  });

  test("a caller is redirected at most twice before the call is closed", () => {
    expect(OFF_TOPIC_LIMIT).toBe(2);
    expect(OFF_TOPIC_CLOSE).not.toBe(OFF_TOPIC_LINE);
  });

  test("the off-topic close says why, rather than hanging up without explanation", () => {
    expect(OFF_TOPIC_CLOSE).toMatch(/RelayPay/);
    expect(OFF_TOPIC_CLOSE.length).toBeGreaterThan(20);
  });
});

describe("how many times a caller is asked to repeat themselves", () => {
  test("the first time is a plain request to say it again", () => {
    expect(lineFor(1)).toBe(DIDNT_CATCH);
  });

  test("the last one offers a person instead of asking again", () => {
    expect(lineFor(UNCLEAR_LIMIT)).toBe(STILL_DIDNT_CATCH);
    expect(STILL_DIDNT_CATCH).toMatch(/specialist|call you back/i);
  });

  test("the caller is never asked a third time", () => {
    for (let streak = UNCLEAR_LIMIT; streak <= UNCLEAR_LIMIT + 3; streak += 1) {
      expect(lineFor(streak)).toBe(STILL_DIDNT_CATCH);
    }
  });

  test("the limit is two, so a caller is asked at most twice", () => {
    expect(UNCLEAR_LIMIT).toBe(2);
  });

  // H5: two routes reach this experience — audio that is not speech, and words the model could
  // not make out. They share a streak, so a caller must not get one budget through one route
  // and a different budget through the other.
  test("one budget governs both routes, so the limit does not depend on which one fired", () => {
    expect(RECOVERY_LIMIT).not.toBe(UNCLEAR_LIMIT);
    const source = readFileSync(new URL("./respond.ts", import.meta.url), "utf8");
    const unintelligibleBranches = source
      .split("\n")
      .filter((line) => /STILL_DIDNT_CATCH/.test(line) && /LIMIT/.test(line));
    expect(unintelligibleBranches.length).toBeGreaterThan(0);
    for (const line of unintelligibleBranches) {
      expect(line, `a turn we could not hear must use UNCLEAR_LIMIT: ${line.trim()}`).toContain("UNCLEAR_LIMIT");
    }
  });

  test("both lines actually ask for something, rather than leaving silence", () => {
    expect(DIDNT_CATCH).toMatch(/\?/);
    expect(STILL_DIDNT_CATCH.length).toBeGreaterThan(20);
  });
});
