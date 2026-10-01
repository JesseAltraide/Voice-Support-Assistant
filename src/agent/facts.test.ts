import { describe, expect, it } from "vitest";
import { extractFacts, type ToolResult } from "./facts.js";

const ok = (name: string, data: Record<string, unknown>): ToolResult => ({ name, data, isError: false });

describe("extractFacts", () => {
  it("a grounded search counts and supplies its text as grounding", () => {
    const r = extractFacts([ok("search_knowledge", { grounded: true, results: [{ slug: "a", title: "Fees", content: "Fees vary by corridor." }] })]);
    expect(r.facts.groundedSearch).toBe(true);
    expect(r.facts.ungroundedSearch).toBe(false);
    expect(r.groundedTexts).toContain("Fees vary by corridor.");
  });

  it("an empty search is recorded as ungrounded", () => {
    const r = extractFacts([ok("search_knowledge", { grounded: false, results: [] })]);
    expect(r.facts.groundedSearch).toBe(false);
    expect(r.facts.ungroundedSearch).toBe(true);
  });

  it("a found lookup counts and its sentence is grounding; a miss counts as neither", () => {
    const hit = extractFacts([ok("lookup_transaction", { found: true, support_summary: "This transaction is still processing." })]);
    expect(hit.facts.foundLookup).toBe(true);
    expect(hit.groundedTexts).toContain("This transaction is still processing.");
    const miss = extractFacts([ok("lookup_payout", { found: false, support_summary: null })]);
    expect(miss.facts.foundLookup).toBe(false);
    expect(miss.groundedTexts).toEqual([]);
  });

  it("an escalation with an id counts, one that returned an error does not", () => {
    expect(extractFacts([ok("create_escalation", { escalation_id: "e-1", status: "open" })]).facts.escalationCreated).toBe(true);
    expect(extractFacts([ok("create_escalation", { escalation_id: null, error: "invalid_email" })]).facts.escalationCreated).toBe(false);
  });

  it("a repeat escalation still means one exists", () => {
    expect(extractFacts([ok("create_escalation", { escalation_id: "e-1", deduplicated: true })]).facts.escalationCreated).toBe(true);
  });

  it("ignores failed tool calls and unparseable results (negative)", () => {
    const r = extractFacts([
      { name: "search_knowledge", data: { grounded: true, results: [{ content: "x" }] }, isError: true },
      { name: "lookup_transaction", data: null, isError: false },
    ]);
    // Not an outage: one call failed and the other returned malformed data, so they are not all errors.
    expect(r.facts).toEqual({ escalationCreated: false, groundedSearch: false, ungroundedSearch: false, foundLookup: false, toolsFailed: false, missedLookup: false });
    expect(r.groundedTexts).toEqual([]);
  });

  it("does not trust a result whose fields have the wrong shape", () => {
    const r = extractFacts([ok("search_knowledge", { grounded: "yes", results: "nope" })]);
    expect(r.facts.groundedSearch).toBe(false);
  });

  it("flags a dependency outage when every tool call this turn failed", () => {
    const r = extractFacts([
      { name: "search_knowledge", data: null, isError: true },
      { name: "lookup_transaction", data: null, isError: true },
    ]);
    expect(r.facts.toolsFailed).toBe(true);
  });

  it("negative: a partial failure is not an outage, and neither is a turn with no tools", () => {
    expect(extractFacts([
      ok("search_knowledge", { grounded: true, results: [{ content: "c" }] }),
      { name: "lookup_transaction", data: null, isError: true },
    ]).facts.toolsFailed).toBe(false);
    expect(extractFacts([]).facts.toolsFailed).toBe(false);
  });

  it("negative: a tool that answered 'not found' is working, not failing", () => {
    expect(extractFacts([ok("lookup_transaction", { found: false })]).facts.toolsFailed).toBe(false);
  });

  it("strips the mcp__ prefix from tool names", () => {
    const r = extractFacts([ok("mcp__relaypay__search_knowledge", { grounded: true, results: [{ content: "c" }] })]);
    expect(r.facts.groundedSearch).toBe(true);
  });
});
