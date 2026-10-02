export const MODEL_ANSWER_TYPES = ["answer_directly", "clarify", "escalate", "decline", "conversational", "off_topic", "unclear"] as const;
export type ModelAnswerType = (typeof MODEL_ANSWER_TYPES)[number];
/**
 * `error` and `unintelligible` are server verdicts: the model can never declare them itself.
 * It can declare `unclear` — whether it made out the words is a judgement only it can make —
 * but that becomes the server's `unintelligible` and a fixed line, so the model still never
 * authors what the caller hears.
 */
export type AnswerType = Exclude<ModelAnswerType, "unclear"> | "error" | "unintelligible";

const TYPE_AT_START = /^\s*(?:TYPE\s*:\s*([A-Za-z_-]+)|<type>\s*([A-Za-z_-]+)\s*<\/type>)[ \t]*\n?/i;
const TYPE_LINE_ANYWHERE = /^\s*TYPE\s*:.*$/gim;
const SCAFFOLD_BLOCK = /<(function_calls|invoke|parameter|thinking|tool_use|tool_call)\b[^>]*>[\s\S]*?<\/\1>/gi;
const STRAY_TAG = /<\/?[a-z_][^>]*>/gi;

function asModelType(raw: string | undefined): ModelAnswerType | null {
  if (!raw) return null;
  const t = raw.trim().toLowerCase().replace(/-/g, "_");
  return (MODEL_ANSWER_TYPES as readonly string[]).includes(t) ? (t as ModelAnswerType) : null;
}

/**
 * The agent starts each reply with "TYPE: <path>" on its own line. Read it, then remove it and
 * any scaffolding the model leaked, so only plain speech can reach the caller.
 */
export function parseTypedReply(raw: string): { type: ModelAnswerType | null; text: string } {
  const head = raw.match(TYPE_AT_START);
  const type = head ? asModelType(head[1] ?? head[2]) : null;
  const body = head ? raw.slice(head[0].length) : raw;
  const text = body
    .replace(TYPE_LINE_ANYWHERE, "")
    .replace(SCAFFOLD_BLOCK, "")
    .replace(STRAY_TAG, "")
    .trim();
  return { type, text };
}

/** What actually happened this turn, read from the tool results, not from the model's account of it. */
export interface TurnFacts {
  escalationCreated: boolean;
  groundedSearch: boolean;
  ungroundedSearch: boolean;
  foundLookup: boolean;
  /** Every tool call this turn errored: the tool server or its database is unreachable. */
  toolsFailed: boolean;
  /** A lookup ran and found nothing. The tool already counted it, so the turn must not count it twice. */
  missedLookup: boolean;
}

export interface DerivedType {
  type: AnswerType;
  note?: string;
  /** The model claimed to answer but nothing was retrieved: the spoken reply must be replaced, not just relabelled. */
  downgraded?: boolean;
}

export function deriveAnswerType(declared: ModelAnswerType | null, facts: TurnFacts): DerivedType {
  if (facts.escalationCreated) return { type: "escalate" };
  // A caller whose words did not come through gets asked again, whatever the model was about to
  // say. This is not the same as off-topic: off-topic is a request we understood and do not
  // serve, while this one may be exactly our business and simply did not survive the line.
  if (declared === "unclear") return { type: "unintelligible", note: "model could not make out the request" };
  const grounded = facts.groundedSearch || facts.foundLookup;
  if (declared === "answer_directly") {
    return grounded
      ? { type: declared }
      : { type: "decline", note: "downgraded from answer_directly: no retrieval this turn", downgraded: true };
  }
  if (declared === null) {
    return grounded ? { type: "answer_directly" } : { type: "conversational", note: "no type declared" };
  }
  if (declared === "escalate") return { type: declared, note: "no escalation record yet (offering or collecting details)" };
  return { type: declared };
}

/**
 * Rule 2: an on-topic but vague caller gets the work first, then at most one question. A first
 * clarifying question with no tool work behind it is a bare question and gets sent back once.
 * Follow-ups in the same streak are not, so this can never loop or trap a caller.
 */
export function needsWorkFirst(p: { type: AnswerType; toolCallCount: number; clarifyStreakBefore: number }): boolean {
  return p.type === "clarify" && p.toolCallCount === 0 && p.clarifyStreakBefore === 0;
}

/**
 * How much one turn adds to the conversation's unresolved count (#43). Lookup misses and
 * unavailable fields are already counted by the tools, so they are not counted again here.
 */
export function unresolvedIncrement(
  type: AnswerType,
  facts: TurnFacts,
  clarifyStreakAfter: number,
  signals: { guardTripped?: boolean; repeatQuestion?: boolean } = {},
): number {
  // Off-topic and greetings are not support questions, so they never count toward a handoff.
  if (type === "off_topic" || type === "conversational") return 0;
  // A lookup that found nothing was already counted inside the tool; counting it again here would
  // trip the handoff offer early.
  if (facts.missedLookup) return 0;
  // A guard trip means the caller heard a refusal, whatever the model intended to say, and a
  // repeated question means the previous answer did not land. Both are dissatisfaction.
  if (signals.guardTripped || signals.repeatQuestion) return 1;
  if (type === "decline") return 1;
  if (type === "clarify" && clarifyStreakAfter >= 2) return 1;
  return 0;
}
