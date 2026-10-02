import { describe, expect, test } from "vitest";
import {
  describeSlot, REFUSAL_REASON, slotRefusal, slotRuleRefusal, slotsOnSameDay,
  SLOT_CAPACITY, SUPPORT_TIMEZONE,
} from "./callback-slots.js";

// Lagos is UTC+1 with no daylight saving, so 10:00 there is 09:00Z. Every fixture below is the
// instant, with the Lagos reading noted, because that is what the rules judge.
const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-05T06:00:00Z"); // Monday 07:00 Lagos

describe("when support can be reached", () => {
  test("a weekday inside hours is allowed", () => {
    expect(slotRuleRefusal(at("2026-10-05T09:00:00Z"), NOW)).toBeNull(); // Monday 10:00
  });

  test("the weekend is refused", () => {
    expect(slotRuleRefusal(at("2026-10-10T09:00:00Z"), NOW)).toBe("weekend"); // Saturday
    expect(slotRuleRefusal(at("2026-10-11T09:00:00Z"), NOW)).toBe("weekend"); // Sunday
  });

  test("before opening and after closing are refused", () => {
    expect(slotRuleRefusal(at("2026-10-05T06:30:00Z"), NOW)).toBe("outside_hours"); // 07:30
    expect(slotRuleRefusal(at("2026-10-05T16:00:00Z"), NOW)).toBe("outside_hours"); // 17:00
  });

  test("a slot is judged by when it ends, not only when it starts", () => {
    // 16:30 Lagos finishes exactly at closing, which is allowed.
    expect(slotRuleRefusal(at("2026-10-05T15:30:00Z"), NOW)).toBeNull();
    // 17:00 Lagos would finish at 17:30, after everyone has gone.
    expect(slotRuleRefusal(at("2026-10-05T16:00:00Z"), NOW)).toBe("outside_hours");
  });

  test("times that are not on the half hour are refused", () => {
    expect(slotRuleRefusal(at("2026-10-05T09:10:00Z"), NOW)).toBe("not_on_the_half_hour");
  });

  test("a time too close to now is refused, because support cannot see it coming", () => {
    expect(slotRuleRefusal(at("2026-10-05T08:00:00Z"), at("2026-10-05T07:30:00Z"))).toBe("too_soon");
  });

  test("a time beyond the horizon is refused", () => {
    expect(slotRuleRefusal(at("2026-11-05T09:00:00Z"), NOW)).toBe("too_far_ahead");
  });
});

describe("capacity", () => {
  const free = at("2026-10-05T09:00:00Z");

  test("an allowed slot with room is free", () => {
    expect(slotRefusal(free, NOW, 0)).toBeNull();
    expect(slotRefusal(free, NOW, SLOT_CAPACITY - 1)).toBeNull();
  });

  test("a full slot is refused even though the rules allow it", () => {
    expect(slotRefusal(free, NOW, SLOT_CAPACITY)).toBe("full");
  });

  test("the rules are checked before capacity, so a weekend says weekend", () => {
    // Being told "that time is full" about a Saturday would send the caller hunting for
    // another Saturday slot that can never exist.
    expect(slotRefusal(at("2026-10-10T09:00:00Z"), NOW, 99)).toBe("weekend");
  });
});

describe("offering alternatives", () => {
  test("a weekday offers slots, and every one of them is bookable", () => {
    const slots = slotsOnSameDay(at("2026-10-05T09:00:00Z"), NOW);
    expect(slots.length).toBeGreaterThan(0);
    for (const s of slots) expect(slotRuleRefusal(s, NOW)).toBeNull();
  });

  test("nothing offered is ever a time support does not work", () => {
    // Asking about a Saturday must not produce Saturday suggestions.
    for (const s of slotsOnSameDay(at("2026-10-10T12:00:00Z"), NOW)) {
      expect(slotRuleRefusal(s, NOW)).toBeNull();
    }
  });
});

describe("reading the time back to the caller", () => {
  const slot = at("2026-10-05T09:00:00Z"); // 10:00 Lagos (UTC+1), 12:00 Nairobi (UTC+3)

  test("the caller hears their own time, not support's", () => {
    expect(describeSlot(slot, "Africa/Nairobi")).toContain("12:00");
    expect(describeSlot(slot, SUPPORT_TIMEZONE)).toContain("10:00");
  });

  test("no zone falls back to support's own", () => {
    expect(describeSlot(slot, null)).toContain("10:00");
  });

  test("an unknown zone does not cost the caller their booking", () => {
    expect(() => describeSlot(slot, "Not/AZone")).not.toThrow();
    expect(describeSlot(slot, "Not/AZone")).toContain("10:00");
  });

  test("the description names the day, so a caller can tell Monday from Tuesday", () => {
    expect(describeSlot(slot, SUPPORT_TIMEZONE)).toMatch(/Monday/);
  });
});

describe("the reasons the agent is given", () => {
  test("every refusal has wording, so it never has to invent one", () => {
    const refusals = ["weekend", "outside_hours", "too_soon", "too_far_ahead", "not_on_the_half_hour", "full"] as const;
    for (const r of refusals) {
      expect(REFUSAL_REASON[r]).toBeTruthy();
      expect(REFUSAL_REASON[r].length).toBeGreaterThan(10);
    }
  });
});
