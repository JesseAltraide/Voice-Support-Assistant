import { describe, expect, it } from "vitest";
import { normalizeId, normalizeStatus, speakDate } from "./normalize.js";

describe("normalizeId", () => {
  it.each([
    ["TXN-9001", "TXN-9001"],
    ["txn 9001", "TXN-9001"],
    ["  Txn9001 ", "TXN-9001"],
    ["t x n dash 9001", null],
    ["txn nine zero zero one", "TXN-9001"],
    ["TXN nine oh oh one", "TXN-9001"],
  ])("normalises %s", (raw, expected) => {
    expect(normalizeId(raw, "TXN")).toBe(expected);
  });

  it("rejects an ID of the wrong kind (negative case)", () => {
    expect(normalizeId("PAY-7002", "TXN")).toBeNull();
  });

  it("rejects empty, junk and injection-shaped input (negative case)", () => {
    expect(normalizeId("", "TXN")).toBeNull();
    expect(normalizeId(undefined, "TXN")).toBeNull();
    expect(normalizeId("TXN-9001'; drop table customers;--", "TXN")).toBeNull();
    expect(normalizeId("TXN-90", "TXN")).toBeNull();
  });
});

describe("normalizeStatus", () => {
  it("collapses case, underscores, dashes and spaces", () => {
    expect(normalizeStatus(" Review_Required ")).toBe("review required");
    expect(normalizeStatus("review-required")).toBe("review required");
    expect(normalizeStatus("PROCESSING")).toBe("processing");
  });
  it("returns empty string for null", () => {
    expect(normalizeStatus(null)).toBe("");
  });
});

describe("speakDate", () => {
  const today = "2026-09-30";
  it("marks a past date as past (TXN-9001 case)", () => {
    expect(speakDate("2026-08-19", today)).toEqual({ phrase: "August 19", tense: "past" });
  });
  it("marks a future date as future", () => {
    expect(speakDate("2026-10-02", today)).toEqual({ phrase: "October 2", tense: "future" });
  });
  it("treats today as today, not past", () => {
    expect(speakDate("2026-09-30", today)?.tense).toBe("today");
  });
  it("returns null for an empty date (TXN-9003 case)", () => {
    expect(speakDate(null, today)).toBeNull();
    expect(speakDate("", today)).toBeNull();
  });
});
