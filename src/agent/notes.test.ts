import { describe, expect, it } from "vitest";
import { buildNotes, type NoteInput } from "./notes.js";

const healthy: NoteInput = {
  unresolved: 0,
  offersMade: 0,
  failedLookups: 0,
  clarifyStreak: 0,
  turnCount: 1,
  elapsedMs: 10_000,
  escalationExists: false,
};
const notesFor = (over: Partial<NoteInput>) => buildNotes({ ...healthy, ...over });

describe("handoff offers (#43, #44)", () => {
  it("negative: ten answered turns in a row produce no offer", () => {
    const r = notesFor({ turnCount: 10, unresolved: 0 });
    expect(r.notes).toEqual([]);
    expect(r.offerMade).toBe(false);
  });

  it("the offer appears at the third unresolved, not before", () => {
    expect(notesFor({ unresolved: 1 }).offerMade).toBe(false);
    expect(notesFor({ unresolved: 2 }).offerMade).toBe(false);
    const third = notesFor({ unresolved: 3 });
    expect(third.offerMade).toBe(true);
    expect(third.notes.join(" ")).toMatch(/specialist/i);
  });

  it("does not repeat the offer between the first and the second threshold", () => {
    expect(notesFor({ unresolved: 4, offersMade: 1 }).offerMade).toBe(false);
    expect(notesFor({ unresolved: 5, offersMade: 1 }).offerMade).toBe(false);
  });

  it("offers a second time at six, once", () => {
    expect(notesFor({ unresolved: 6, offersMade: 1 }).offerMade).toBe(true);
    expect(notesFor({ unresolved: 7, offersMade: 2 }).offerMade).toBe(false);
  });

  it("after two offers it wraps up politely instead of offering again", () => {
    const r = notesFor({ unresolved: 7, offersMade: 2 });
    expect(r.offerMade).toBe(false);
    expect(r.notes.join(" ")).toMatch(/wrap up/i);
    expect(r.notes.join(" ")).toMatch(/dashboard/i);
  });

  it("no offer is made once an escalation already exists", () => {
    expect(notesFor({ unresolved: 3, escalationExists: true }).offerMade).toBe(false);
  });
});

describe("other server notes", () => {
  it("two clarifying questions in a row: no third, offer a specialist", () => {
    expect(notesFor({ clarifyStreak: 2 }).notes.join(" ")).toMatch(/do not ask another clarifying question/i);
    expect(notesFor({ clarifyStreak: 1 }).notes).toEqual([]);
  });

  it("an existing escalation stops troubleshooting that issue", () => {
    expect(notesFor({ escalationExists: true }).notes.join(" ")).toMatch(/already logged/i);
  });

  it("three failed lookups: no more lookups", () => {
    expect(notesFor({ failedLookups: 3 }).notes.join(" ")).toMatch(/no more lookups/i);
    expect(notesFor({ failedLookups: 2 }).notes).toEqual([]);
  });

  it("soft wrap-up near the time limit, not before", () => {
    expect(notesFor({ elapsedMs: 239_000 }).notes).toEqual([]);
    expect(notesFor({ elapsedMs: 241_000 }).notes.join(" ")).toMatch(/wrap up/i);
  });

  it("soft wrap-up at the turn cap", () => {
    expect(notesFor({ turnCount: 19 }).notes).toEqual([]);
    expect(notesFor({ turnCount: 20 }).notes.join(" ")).toMatch(/wrap up/i);
  });
});
