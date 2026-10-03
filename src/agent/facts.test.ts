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

// Found on a real call: a successfully booked time was refused by the speech guard as an
// invented number, because the booking tools' results were never added to groundedTexts at all —
// not the digit form, not the spoken form, not the alternatives. Confirming the real gap closed.
describe("callback tool results ground the time they returned", () => {
  const ok = { isError: false } as const;

  it("book_callback's reads_as and reads_as_spoken are both grounded", () => {
    const { groundedTexts } = extractFacts([{
      ...ok, name: "mcp__relaypay__book_callback",
      data: { booked: true, reads_as: "Wednesday 7 October, 15:00", reads_as_spoken: "Wednesday 7 October at 3 in the afternoon" },
    }]);
    expect(groundedTexts).toContain("Wednesday 7 October, 15:00");
    expect(groundedTexts).toContain("Wednesday 7 October at 3 in the afternoon");
  });

  it("check_callback_availability's alternatives are each grounded, both forms", () => {
    const { groundedTexts } = extractFacts([{
      ...ok, name: "mcp__relaypay__check_callback_availability",
      data: {
        available: false,
        alternatives: [
          { slot_start: "x", reads_as: "Friday 9 October, 16:30", reads_as_spoken: "Friday 9 October at 4:30 in the afternoon" },
        ],
      },
    }]);
    expect(groundedTexts).toContain("Friday 9 October, 16:30");
    expect(groundedTexts).toContain("Friday 9 October at 4:30 in the afternoon");
  });

  it("a failed tool call grounds nothing", () => {
    const { groundedTexts } = extractFacts([{
      name: "mcp__relaypay__book_callback", isError: true,
      data: { booked: true, reads_as: "Monday 5 October, 10:00" },
    }]);
    expect(groundedTexts).toEqual([]);
  });
});

describe("account facts are only collected from a lookup that linked the caller", () => {
  const FACTS = "Their plan is Growth. Their account status is active. Their verification status is approved.";
  it("collects account_facts when found and linked", () => {
    const { accountFacts } = extractFacts([{
      name: "mcp__relaypay__lookup_customer", isError: false,
      data: { found: true, linked: true, support_summary: "The account is open and verification is complete.", account_facts: FACTS },
    }]);
    expect(accountFacts).toEqual([FACTS]);
  });

  it("collects nothing when the lookup did not link", () => {
    const { accountFacts } = extractFacts([{
      name: "mcp__relaypay__lookup_customer", isError: false,
      data: { found: false, linked: false, account_facts: FACTS },
    }]);
    expect(accountFacts).toEqual([]);
  });

  it("ignores account_facts on a failed call", () => {
    const { accountFacts } = extractFacts([{
      name: "mcp__relaypay__lookup_customer", isError: true,
      data: { found: true, linked: true, support_summary: "x", account_facts: FACTS },
    }]);
    expect(accountFacts).toEqual([]);
  });
});

describe("open callback slots are grounded in both spoken forms", () => {
  it("grounds every offered open slot", () => {
    const { groundedTexts } = extractFacts([{
      name: "mcp__relaypay__check_callback_availability", isError: false,
      data: { open_slots: [{ slot_start: "x", reads_as: "Monday 5 October, 09:00", reads_as_spoken: "Monday 5 October at 9 in the morning" }] },
    }]);
    expect(groundedTexts).toContain("Monday 5 October, 09:00");
    expect(groundedTexts).toContain("Monday 5 October at 9 in the morning");
  });
});
