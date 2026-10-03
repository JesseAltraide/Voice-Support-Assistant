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
  /** Plain-words account facts from a lookup_customer that linked the caller this turn. */
  accountFacts: string[];
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
  const accountFacts: string[] = [];
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
        if (name === "lookup_customer" && d.linked === true && isString(d.account_facts)) accountFacts.push(d.account_facts);
      } else if (d.found === false) {
        facts.missedLookup = true;
      }
    } else if (name === "create_escalation" && isString(d.escalation_id)) {
      facts.escalationCreated = true;
    } else if (name === "check_callback_availability" || name === "book_callback") {
      // A real, tool-returned time must be readable back without looking invented. Neither form
      // was ever grounded before this: a successfully booked time was refused by the guard for
      // the same reason a made-up one would have been, because nothing told it the figure was
      // real. Both the digit and spoken forms are pushed, since the model may use either.
      if (isString(d.reads_as)) groundedTexts.push(d.reads_as);
      if (isString(d.reads_as_spoken)) groundedTexts.push(d.reads_as_spoken);
      if (Array.isArray(d.open_slots)) {
        for (const o of d.open_slots) {
          const slot = o as { reads_as?: unknown; reads_as_spoken?: unknown } | null;
          if (isString(slot?.reads_as)) groundedTexts.push(slot.reads_as);
          if (isString(slot?.reads_as_spoken)) groundedTexts.push(slot.reads_as_spoken);
        }
      }
      if (Array.isArray(d.alternatives)) {
        for (const alt of d.alternatives) {
          const a = alt as { reads_as?: unknown; reads_as_spoken?: unknown } | null;
          if (isString(a?.reads_as)) groundedTexts.push(a.reads_as);
          if (isString(a?.reads_as_spoken)) groundedTexts.push(a.reads_as_spoken);
        }
      }
    }
  }
  return { facts, groundedTexts, accountFacts };
}
