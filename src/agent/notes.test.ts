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
const isClock = (n: string) => n.startsWith("Right now it is");

// Every turn carries the clock note, which is standing context rather than an instruction. The
// assertions below are about what the server tells the agent to DO, so it is dropped here and
// tested on its own further down.
const notesFor = (over: Partial<NoteInput>) => {
  const r = buildNotes({ ...healthy, ...over });
  return { ...r, notes: r.notes.filter((n) => !isClock(n)) };
};

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

// A model has no clock. Without this note it would guess today's date, and a guessed date books
// a callback in the wrong week — which the caller only discovers when nobody rings.
describe("the clock note", () => {
  const clockFor = (over: Partial<NoteInput>) =>
    buildNotes({ ...healthy, ...over }).notes.filter(isClock).join(" ");

  const NOW = new Date("2026-10-05T06:00:00Z");

  it("is present on every turn, however the call is going", () => {
    expect(clockFor({ now: NOW })).toContain("2026-10-05T06:00:00.000Z");
    expect(clockFor({ now: NOW, unresolved: 7, offersMade: 2, escalationExists: true })).toContain("2026-10-05");
  });

  it("names the caller's own zone, because ten means ten where they are sitting", () => {
    const note = clockFor({ now: NOW, caller: { name: "Amara", email: "a@b.com", timezone: "Europe/London" } });
    expect(note).toContain("Europe/London");
  });

  it("says nothing about a zone when the caller never gave one", () => {
    // A phone call has no form, so there is no zone to name. Inventing one would be worse than
    // leaving the tool to fall back to support's own.
    const note = clockFor({ now: NOW, caller: { name: "Amara", email: "a@b.com", timezone: null } });
    expect(note).not.toMatch(/timezone is/);
    expect(note).toContain("2026-10-05");
  });

  it("asks for a full UTC instant, which is what the callback tools accept", () => {
    expect(clockFor({ now: NOW })).toMatch(/ISO-8601 UTC instant/);
  });
});

// The address typed on the form is checked against the customer list when the call connects, so
// the agent is told who it is talking to instead of asking again by voice.
describe("customer or guest", () => {
  const forCaller = (isCustomer: boolean) =>
    buildNotes({
      ...healthy,
      caller: { name: "Amara", email: "amara@lagosledger.example", timezone: "Africa/Lagos", isCustomer },
    }).notes.join(" ");

  it("a matched caller is told to look things up without asking again", () => {
    const n = forCaller(true);
    expect(n).toMatch(/verified/i);
    expect(n).toMatch(/do not ask/i);
  });

  it("an unmatched caller is a guest, with no account tools", () => {
    const n = forCaller(false);
    expect(n).toMatch(/guest/i);
    expect(n).toMatch(/lookup_transaction/);
    expect(n).toMatch(/cannot see account details/i);
  });

  it("the guest is still helped, not turned away", () => {
    // A guest asking about fees or timelines gets the same answer anyone does. Only the records
    // are closed to them, because there are none to open.
    expect(forCaller(false)).toMatch(/general questions/i);
  });

  it("says nothing either way when no form was filled in", () => {
    // A phone call has no form. Claiming guest status there would wrongly close the records of
    // a customer who can still be matched by voice.
    const n = buildNotes({ ...healthy }).notes.join(" ");
    expect(n).not.toMatch(/guest/i);
    expect(n).not.toMatch(/verified/i);
  });
});
