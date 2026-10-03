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
export const SLOT_CAPACITY = 1;
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

// Built once. Constructing a formatter is expensive, and the forward search below asks about
// hundreds of candidate slots in a single tool call.
const SUPPORT_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: SUPPORT_TIMEZONE,
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The parts of an instant as they read in support's zone, which is what the rules are about. */
function partsIn(instant: Date): { weekday: number; hour: number; minute: number } {
  const parts = Object.fromEntries(SUPPORT_PARTS.formatToParts(instant).map((p) => [p.type, p.value]));
  const weekday = DAYS.indexOf(String(parts.weekday));
  // Fail closed. An unrecognised weekday name would otherwise be -1, which passes the weekend
  // check and quietly makes Saturdays bookable.
  if (weekday === -1) throw new Error(`unrecognised weekday from Intl: ${String(parts.weekday)}`);
  return { weekday, hour: Number(parts.hour), minute: Number(parts.minute) };
}

/**
 * Whether a slot is one support could work, ignoring how busy it already is.
 *
 * Working hours are judged in SUPPORT_TIMEZONE, never the caller's: a caller in London asking
 * for "nine in the morning" means nine their time, and whether anyone is at a desk then is a
 * question about Lagos.
 */
export function slotRuleRefusal(slotStart: Date, now: Date): SlotRefusal | null {
  // Seconds and milliseconds must be zero, not merely ignored. Capacity is counted by matching
  // slot_start exactly, so 09:00:01 would be a slot of its own with nothing booked in it — and a
  // caller steering the model to that string could book past a full slot for ever.
  if (slotStart.getUTCSeconds() !== 0 || slotStart.getUTCMilliseconds() !== 0) return "not_on_the_half_hour";

  const { weekday, hour, minute } = partsIn(slotStart);
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

/**
 * Bookable slots to offer when the caller's own choice cannot be met.
 *
 * It searches the whole open window rather than the requested day. Searching only that day left
 * the commonest refusals with nothing to offer: a caller asking for a Saturday was told the team
 * works weekdays and then offered no weekday, because the only candidates considered were on the
 * Saturday itself. The same dead end followed a request beyond the two-week horizon.
 *
 * Results are returned in time order. The caller of this function decides what "nearest" means,
 * because nearest to the time somebody asked for is not the same as soonest.
 */
export function bookableSlots(now: Date): Date[] {
  const slots: Date[] = [];
  // Start at the first half hour on or after the lead time, and walk the horizon.
  const first = new Date(now.getTime() + LEAD_TIME_MINUTES * 60_000);
  first.setUTCSeconds(0, 0);
  first.setUTCMinutes(Math.ceil(first.getUTCMinutes() / SLOT_MINUTES) * SLOT_MINUTES);

  const end = now.getTime() + HORIZON_DAYS * 24 * 60 * 60_000;
  for (let t = first.getTime(); t <= end; t += SLOT_MINUTES * 60_000) {
    const slot = new Date(t);
    if (slotRuleRefusal(slot, now) === null) slots.push(slot);
  }
  return slots;
}

/** The instant that reads as a given hour, on a given day, in support's own zone. */
function atSupportHour(day: Date, hour: number): Date {
  const probe = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 12, 0, 0, 0));
  const here = partsIn(probe);
  return new Date(probe.getTime() + (hour * 60 - (here.hour * 60 + here.minute)) * 60_000);
}

/**
 * The booking window as the caller would hear it, in their own time.
 *
 * Support works Lagos hours, but a caller in London asked to pick a time should not have to do
 * the arithmetic — or, worse, guess, propose something outside the window and be refused. The
 * agent states this up front, and it is derived from the same constants the rules use, so the
 * two can never drift apart.
 */
export function describeWindow(callerTimeZone: string | null, now: Date = new Date()): string {
  // A weekday a few days out, so the offset quoted is one that will actually apply.
  const day = new Date(now.getTime() + 3 * 24 * 60 * 60_000);
  const time = (d: Date) => {
    const fmt = (zone: string) =>
      new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
    try {
      return fmt(callerTimeZone ?? SUPPORT_TIMEZONE);
    } catch {
      return fmt(SUPPORT_TIMEZONE);
    }
  };
  // Both forms, because the agent speaks and nobody says "zero eight hundred" on the phone. The
  // guard checks a stated number against what it was given, so if the note held only "08:00" the
  // natural "between 8 and 5" would be refused as invented.
  const open = atSupportHour(day, OPENS_HOUR);
  const close = atSupportHour(day, CLOSES_HOUR);
  return `Monday to Friday, ${time(open)} to ${time(close)}, that is between ${spokenClock(open, callerTimeZone)} and ${spokenClock(close, callerTimeZone)}`;
}

/** "3 in the afternoon", "10:30 in the morning" — how a clock time is actually said aloud. */
function spokenClock(d: Date, callerTimeZone: string | null): string {
  const fmt = (zone: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
  const raw = (() => {
    try {
      return fmt(callerTimeZone ?? SUPPORT_TIMEZONE);
    } catch {
      return fmt(SUPPORT_TIMEZONE);
    }
  })();
  const [h, m] = raw.split(":").map(Number);
  const hour = h! % 12 === 0 ? 12 : h! % 12;
  const partOfDay = h! < 12 ? "in the morning" : h! < 18 ? "in the afternoon" : "in the evening";
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""} ${partOfDay}`;
}

/**
 * How a specific booked or offered slot is actually said aloud: "Wednesday 7 October at 3 in the
 * afternoon". describeSlot's own digit form ("15:00") is exact but is not how the agent speaks,
 * and the guard only accepts a number in the phrasing it was actually given — a real, successfully
 * booked time was being refused as invented for exactly this reason, because the tool only ever
 * returned the digit form and nothing passed either form to the guard as grounding at all.
 */
export function describeSlotSpoken(slotStart: Date, callerTimeZone: string | null): string {
  const weekdayDate = (zone: string) =>
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "long", day: "numeric", month: "long" }).format(slotStart);
  try {
    const zone = callerTimeZone ?? SUPPORT_TIMEZONE;
    return `${weekdayDate(zone)} at ${spokenClock(slotStart, zone)}`;
  } catch {
    return `${weekdayDate(SUPPORT_TIMEZONE)} at ${spokenClock(slotStart, SUPPORT_TIMEZONE)}`;
  }
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
  full: "that time has already been booked",
};

/** Whether the runtime knows this IANA zone. A well-shaped but unknown zone throws in Intl, so it is checked, not pattern-matched. */
export function isRealTimeZone(zone: string): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
