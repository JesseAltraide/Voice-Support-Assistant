import { describe, expect, it } from "vitest";
import { type DraftCallback, type DraftEscalation, draftPayload } from "./draft.js";

const escalation = (over: Partial<DraftEscalation> = {}): DraftEscalation => ({
  user_name: "Amara",
  user_email: "amara@lagosledger.test",
  reason: "Issue 1: invoice payment failed\nIssue 2: cannot retry it",
  case_reference: "TXN-9001",
  contact_confirmed_at: null,
  ...over,
});

const booking: DraftCallback = { slot_start: "2026-10-06T09:00:00.000Z", reads_as: "Tuesday 6 October, 10:00" };

describe("what the caller is shown after the call", () => {
  it("an escalation gives them their details to check and the case to read", () => {
    const d = draftPayload(escalation(), null);
    expect(d.has_escalation).toBe(true);
    expect(d.name).toBe("Amara");
    expect(d.reference).toBe("TXN-9001");
    // Each issue is its own line, so a call that raised two problems does not read as one
    // run-on sentence the caller cannot check.
    expect(d.reasons).toHaveLength(2);
    expect(d.callback).toBeNull();
  });

  it("a booking alone is still worth showing, with no form attached", () => {
    // The caller agreed a time out loud and nothing else happened. Showing nothing would leave
    // the only commitment of the call unwritten.
    const d = draftPayload(null, booking);
    expect(d.has_escalation).toBe(false);
    expect(d.callback).toEqual(booking);
    expect(d.reasons).toEqual([]);
    expect(d.name).toBeNull();
    expect(d.reference).toBeNull();
    expect(d.confirmed).toBe(false);
  });

  it("a call that did both shows both", () => {
    const d = draftPayload(escalation(), booking);
    expect(d.has_escalation).toBe(true);
    expect(d.callback?.reads_as).toBe("Tuesday 6 October, 10:00");
    expect(d.reasons).toHaveLength(2);
  });

  it("an escalation already confirmed says so, so the caller cannot send it twice", () => {
    expect(draftPayload(escalation({ contact_confirmed_at: "2026-10-02T10:00:00Z" }), null).confirmed).toBe(true);
    expect(draftPayload(escalation(), null).confirmed).toBe(false);
  });

  it("an escalation with no reason yet reads as no issues, not as one empty one", () => {
    expect(draftPayload(escalation({ reason: null }), null).reasons).toEqual([]);
  });
});
