export interface BriefTurn {
  user_transcript: string;
  answer_type: string | null;
}

export interface BriefToolCall {
  tool_name: string;
  status: string;
  result_summary: string | null;
}

export interface BriefInput {
  reason: string;
  unresolvedCount: number;
  turns: BriefTurn[];
  toolCalls: BriefToolCall[];
}

const HANDLED: Record<string, string> = {
  answer_directly: "answered from the knowledge base",
  clarify: "clarifying question asked",
  escalate: "escalated to a specialist",
  decline: "declined, not covered by approved knowledge",
  conversational: "conversational",
  off_topic: "off topic, redirected",
  error: "an error occurred",
};

const MAX_TURNS = 10;
const MAX_LOOKUPS = 6;
const MAX_TURN_CHARS = 160;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Facts only, assembled from saved records. No model wrote this, so it cannot invent
 * anything and cannot fail because a model call failed. It holds no customer-record
 * fields: lookup results are already reduced to safe summaries by the tool layer.
 */
export function buildHandoffBrief(input: BriefInput): string {
  const lines: string[] = ["Handoff brief (built from saved records)"];

  if (input.turns.length === 0) {
    lines.push("Nothing recorded for this conversation.");
  } else {
    lines.push("Asked, in order:");
    input.turns.slice(-MAX_TURNS).forEach((t, i) => {
      const handled = HANDLED[t.answer_type ?? ""] ?? "no outcome recorded";
      lines.push(`${i + 1}. "${clip(oneLine(t.user_transcript), MAX_TURN_CHARS)}" - ${handled}`);
    });
  }

  const lookups = input.toolCalls.filter((c) => c.tool_name.startsWith("lookup_")).slice(-MAX_LOOKUPS);
  if (lookups.length > 0) {
    lines.push("Lookups:");
    for (const c of lookups) {
      lines.push(`- ${c.tool_name}: ${c.status === "ok" ? clip(oneLine(c.result_summary ?? "no summary"), 120) : "failed"}`);
    }
  }

  lines.push(`Unresolved questions: ${input.unresolvedCount}`);
  lines.push(`Reason for escalating: ${clip(oneLine(input.reason), 200)}`);
  return lines.join("\n");
}
