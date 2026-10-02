/**
 * When a callback can be offered, and what a caller's words mean in their own time.
 *
 * Kept free of the database so the rules can be read and tested on their own: deciding whether
 * Tuesday at ten is inside working hours should not require a Supabase round trip, and a
 * timezone mistake here would quietly book people for the middle of their night.
 */

/** Support's own working hours. Callers may be anywhere; the people answering are not. */
export const SUPPORT_TIMEZONE = "Africa/Lagos";
export const OPENS_HOUR = 8;
export const CLOSES_HOUR = 17;
/** Callbacks are offered on the half hour, which is short enough to be honest about. */
export const SLOT_MINUTES = 30;
/** How many callbacks support can take in one slot. Capacity, not a named roster. */
export const SLOT_CAPACITY = 2;
/** Nothing is offered sooner than this: a booking the team cannot see coming is not a booking. */
export const LEAD_TIME_MINUTES = 60;
/** How far ahead a caller may book. Beyond this, support's own plans are not knowable. */
export const HORIZON_DAYS = 14;

export type SlotRefusal =
  | "weekend"
  | "outside_hours"
  | "too_soon"
  | "too_far_ahead"
  | "not_on_the_half_hour"
  | "full";

/** The parts of an instant as they read in a given zone, which is what the rules are about. */
function partsIn(instant: Date, timeZone: string): { weekday: number; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(fmt.formatToParts(instant).map((p) => [p.type, p.value]));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    weekday: days.indexOf(String(parts.weekday)),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

/**
 * Whether a slot is one support could work, ignoring how busy it already is.
 *
 * Working hours are judged in SUPPORT_TIMEZONE, never the caller's: a caller in London asking
 * for "nine in the morning" means nine their time, and whether anyone is at a desk then is a
 * question about Lagos.
 */
export function slotRuleRefusal(slotStart: Date, now: Date): SlotRefusal | null {
  const { weekday, hour, minute } = partsIn(slotStart, SUPPORT_TIMEZONE);
  if (minute % SLOT_MINUTES !== 0) return "not_on_the_half_hour";
  if (weekday === 0 || weekday === 6) return "weekend";
  // The slot must both start on or after opening and finish by closing.
  const endMinutes = hour * 60 + minute + SLOT_MINUTES;
  if (hour < OPENS_HOUR || endMinutes > CLOSES_HOUR * 60) return "outside_hours";

  const minutesAway = (slotStart.getTime() - now.getTime()) / 60_000;
  if (minutesAway < LEAD_TIME_MINUTES) return "too_soon";
  if (minutesAway > HORIZON_DAYS * 24 * 60) return "too_far_ahead";
  return null;
}

/** A slot is free when the rules allow it and support is not already full at that time. */
export function slotRefusal(slotStart: Date, now: Date, alreadyBooked: number): SlotRefusal | null {
  return slotRuleRefusal(slotStart, now) ?? (alreadyBooked >= SLOT_CAPACITY ? "full" : null);
}

/** Every slot support could work on the day a caller asked about, soonest first. */
export function slotsOnSameDay(around: Date, now: Date): Date[] {
  const slots: Date[] = [];
  const dayStart = new Date(around);
  dayStart.setUTCHours(0, 0, 0, 0);
  for (let m = 0; m < 24 * 60 + 24 * 60; m += SLOT_MINUTES) {
    const slot = new Date(dayStart.getTime() + m * 60_000);
    if (slotRuleRefusal(slot, now) === null) slots.push(slot);
  }
  return slots;
}

/** How the time reads to the caller, in their own zone, so it can be said back to them. */
export function describeSlot(slotStart: Date, callerTimeZone: string | null): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(slotStart);
  try {
    return format(callerTimeZone ?? SUPPORT_TIMEZONE);
  } catch {
    // An unknown zone must not cost the caller their booking; fall back to support's own.
    return format(SUPPORT_TIMEZONE);
  }
}

/** Why a time was refused, in words the agent can say without inventing a reason. */
export const REFUSAL_REASON: Record<SlotRefusal, string> = {
  weekend: "the team only works weekdays",
  outside_hours: "the team works between 8 in the morning and 5 in the afternoon",
  too_soon: "the earliest callback is about an hour from now",
  too_far_ahead: "callbacks can only be arranged up to two weeks ahead",
  not_on_the_half_hour: "callbacks start on the hour or the half hour",
  full: "that time is already full",
};
