import { describe, expect, it } from "vitest";
import { deriveFinalStatus, type FinalStatusInput } from "./final-status.js";

const base: FinalStatusInput = { escalations: 0, tickets: 0, turns: 3, lastAnswerType: "answer_directly", currentStatus: "active" };
const status = (over: Partial<FinalStatusInput>) => deriveFinalStatus({ ...base, ...over });

describe("deriveFinalStatus: from the records that exist, not from what the agent said", () => {
  it("an escalation record wins over a ticket and over the last reply", () => {
    expect(status({ escalations: 1, tickets: 1 })).toBe("escalated");
    expect(status({ escalations: 1, lastAnswerType: "decline" })).toBe("escalated");
  });

  it("a ticket with no escalation is ticket_created", () => {
    expect(status({ tickets: 2 })).toBe("ticket_created");
  });

  it("answered and done is resolved", () => {
    expect(status({})).toBe("resolved");
  });

  it("a last decline with nothing logged is declined", () => {
    expect(status({ lastAnswerType: "decline" })).toBe("declined");
  });

  it("negative: a decline does not hide a ticket", () => {
    expect(status({ lastAnswerType: "decline", tickets: 1 })).toBe("ticket_created");
  });

  it("a call with no turns is abandoned", () => {
    expect(status({ turns: 0, lastAnswerType: null })).toBe("abandoned");
  });

  it("a call that ended while collecting details is abandoned (the sweep may add a ticket)", () => {
    expect(status({ currentStatus: "collecting_details" })).toBe("abandoned");
  });

  it("an error stays an error even though the failure path files a ticket", () => {
    expect(status({ currentStatus: "error", tickets: 1 })).toBe("error");
  });

  it("a turn recorded as an error is an error even if the status write never landed", () => {
    expect(status({ currentStatus: "active", lastAnswerType: "error" })).toBe("error");
  });

  it("an escalation that exists outranks a failed turn, so the handoff is never reported as error", () => {
    expect(status({ currentStatus: "error", escalations: 1, tickets: 1 })).toBe("escalated");
  });

  it("negative: claiming resolved is impossible while an escalation exists", () => {
    expect(status({ escalations: 1, currentStatus: "resolved" })).not.toBe("resolved");
  });
});
