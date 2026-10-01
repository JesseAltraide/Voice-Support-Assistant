import { describe, expect, it } from "vitest";
import { buildHandoffBrief } from "./brief.js";

describe("buildHandoffBrief", () => {
  const base = {
    reason: "Caller reports a restricted account.",
    unresolvedCount: 2,
    turns: [
      { user_transcript: "What fees do you charge?", answer_type: "answer_directly" },
      { user_transcript: "My account was restricted and nobody is helping me.", answer_type: "escalate" },
    ],
    toolCalls: [
      { tool_name: "lookup_transaction", status: "ok", result_summary: "found=true status=processing" },
      { tool_name: "search_knowledge", status: "ok", result_summary: "3 chunks" },
    ],
  };

  it("lists what was asked, in order, with how each was handled", () => {
    const brief = buildHandoffBrief(base);
    expect(brief).toMatch(/1\. .*fees.*answered from the knowledge base/i);
    expect(brief.indexOf("fees")).toBeLessThan(brief.indexOf("restricted"));
  });

  it("includes lookups with their safe result, the unresolved count and the agent's reason", () => {
    const brief = buildHandoffBrief(base);
    expect(brief).toContain("lookup_transaction: found=true status=processing");
    expect(brief).toContain("Unresolved questions: 2");
    expect(brief).toContain("Reason for escalating: Caller reports a restricted account.");
  });

  it("does not list knowledge searches as lookups", () => {
    expect(buildHandoffBrief(base)).not.toContain("search_knowledge");
  });

  it("stays short and safe with no turns at all (negative case)", () => {
    const brief = buildHandoffBrief({ ...base, turns: [], toolCalls: [] });
    expect(brief).toMatch(/nothing recorded/i);
    expect(brief.length).toBeLessThan(600);
  });

  it("truncates a very long caller turn", () => {
    const long = "x".repeat(2000);
    const brief = buildHandoffBrief({ ...base, turns: [{ user_transcript: long, answer_type: "decline" }] });
    expect(brief.length).toBeLessThan(1200);
  });
});
