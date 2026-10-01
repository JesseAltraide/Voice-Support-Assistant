import type { TurnFacts } from "./turn-type.js";

export interface ToolResult {
  name: string;
  data: Record<string, unknown> | null;
  isError: boolean;
}

export interface ExtractedFacts {
  facts: TurnFacts;
  /** Knowledge text and tool sentences from this turn: the only numbers the reply may repeat besides the caller's own. */
  groundedTexts: string[];
}

const shortName = (name: string) => (name.startsWith("mcp__") ? name.split("__").slice(2).join("__") : name);
const isString = (v: unknown): v is string => typeof v === "string";

/**
 * Read what actually happened this turn from the tool results. Every field is checked for its
 * shape before it is trusted: a result that is malformed, or that came from a failed call, counts
 * as nothing rather than as grounding.
 */
export function extractFacts(results: ToolResult[]): ExtractedFacts {
  const facts: TurnFacts = {
    escalationCreated: false, groundedSearch: false, ungroundedSearch: false, foundLookup: false,
    toolsFailed: false, missedLookup: false,
  };
  const groundedTexts: string[] = [];
  // Every call failing is a dependency outage, not an unlucky turn. A tool that answered
  // "not found" is working, so only transport-level errors count here.
  facts.toolsFailed = results.length > 0 && results.every((r) => r.isError);

  for (const r of results) {
    if (r.isError || !r.data) continue;
    const name = shortName(r.name);
    const d = r.data;

    if (name === "search_knowledge" && Array.isArray(d.results)) {
      if (d.grounded === true) {
        facts.groundedSearch = true;
        for (const item of d.results) {
          const content = (item as { content?: unknown } | null)?.content;
          if (isString(content)) groundedTexts.push(content);
        }
      } else if (d.grounded === false) {
        facts.ungroundedSearch = true;
      }
    } else if (name === "lookup_transaction" || name === "lookup_payout" || name === "lookup_customer") {
      if (d.found === true && isString(d.support_summary)) {
        facts.foundLookup = true;
        groundedTexts.push(d.support_summary);
      } else if (d.found === false) {
        facts.missedLookup = true;
      }
    } else if (name === "create_escalation" && isString(d.escalation_id)) {
      facts.escalationCreated = true;
    }
  }
  return { facts, groundedTexts };
}
