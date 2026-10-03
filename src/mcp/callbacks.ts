import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  bookableSlots, describeSlot, describeSlotSpoken, REFUSAL_REASON, slotRefusal,
  SLOT_CAPACITY, SLOT_MINUTES, SUPPORT_TIMEZONE,
} from "./callback-slots.js";
import { sendCallerEmail } from "../agent/handoff-email.js";
import type { ToolContext } from "./context.js";
import { runTool } from "./instrument.js";

/** Days of open times to offer when the caller has not named one. */
const OPEN_DAYS = 3;

/** How many alternatives to offer. More than three is a list nobody can hold in their head. */
const MAX_ALTERNATIVES = 3;

interface ConversationContext {
  id: string;
  caller_timezone: string | null;
  caller_name: string | null;
  caller_email: string | null;
}

/**
 * Tell the caller in writing what was agreed out loud.
 *
 * The booking stands whether or not this arrives — the row is written and support can see it. So
 * a failure is recorded against the booking and never thrown: somebody who has just been given a
 * time should not be told something went wrong because a mail server was slow.
 */
async function confirmByEmail(db: SupabaseClient, bookingId: string, conv: ConversationContext, slot: Date): Promise<void> {
  if (!conv.caller_email) {
    await db.from("callback_bookings").update({ confirmation_email_status: "skipped" }).eq("id", bookingId);
    return;
  }
  const when = describeSlot(slot, conv.caller_timezone);
  try {
    await sendCallerEmail({
      to: conv.caller_email,
      subject: `Your RelayPay callback: ${when}`,
      text: [
        conv.caller_name ? `Hello ${conv.caller_name},` : "Hello,",
        "",
        `We have booked a callback for you on ${when}${conv.caller_timezone ? "" : ` (${SUPPORT_TIMEZONE} time)`}.`,
        "",
        "A member of the RelayPay support team will call you then. If that time no longer suits,",
        "reply to this email and we will rearrange it.",
        "",
        "RelayPay Support",
      ].join("\n"),
    });
    await db
      .from("callback_bookings")
      .update({ confirmation_email_status: "sent", confirmation_email_sent_at: new Date().toISOString() })
      .eq("id", bookingId);
  } catch (err) {
    await db
      .from("callback_bookings")
      .update({
        confirmation_email_status: "failed",
        confirmation_email_error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
      })
      .eq("id", bookingId);
  }
}

async function conversationContext(db: SupabaseClient, conversationId: string): Promise<ConversationContext> {
  const { data, error } = await db
    .from("conversations")
    .select("id,caller_timezone,caller_name,caller_email")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("conversation not found");
  return {
    id: data.id as string,
    caller_timezone: (data.caller_timezone as string | null) ?? null,
    caller_name: (data.caller_name as string | null) ?? null,
    caller_email: (data.caller_email as string | null) ?? null,
  };
}

/** How many callbacks are already taken at that instant. */
async function bookedAt(db: SupabaseClient, slotStart: Date): Promise<number> {
  const { count, error } = await db
    .from("callback_bookings")
    .select("*", { count: "exact", head: true })
    .eq("slot_start", slotStart.toISOString())
    .eq("status", "booked");
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * Times near the one the caller asked for that are actually free.
 *
 * Offered whenever a request is refused, because "no" on its own leaves the caller guessing at
 * a schedule they cannot see. Capacity is checked per slot, so a suggestion is one support can
 * really take rather than merely one the rules allow.
 */
async function alternatives(db: SupabaseClient, around: Date, now: Date, zone: string | null) {
  const candidates = bookableSlots(now);
  // Nearest to what they asked for first: someone who wanted Tuesday morning wants Tuesday
  // morning, not whatever happens to be earliest in the week.
  candidates.sort((a, b) => Math.abs(a.getTime() - around.getTime()) - Math.abs(b.getTime() - around.getTime()));

  const free: Array<{ slot_start: string; reads_as: string; reads_as_spoken: string }> = [];
  for (const slot of candidates) {
    if (free.length >= MAX_ALTERNATIVES) break;
    if ((await bookedAt(db, slot)) < SLOT_CAPACITY) {
      // Both forms are grounding: whichever one the agent happens to read an alternative back
      // in, the guard must recognise it as a real figure, not an invented one.
      free.push({ slot_start: slot.toISOString(), reads_as: describeSlot(slot, zone), reads_as_spoken: describeSlotSpoken(slot, zone) });
    }
  }
  return free;
}

/**
 * The first free slot on each of the next few days, so a caller who has not named a time can be
 * told what is actually open instead of guessing at a schedule they cannot see.
 */
async function openSlots(db: SupabaseClient, now: Date, zone: string | null) {
  const dayOf = (slot: Date): string => slot.toLocaleDateString("en-CA", { timeZone: zone ?? SUPPORT_TIMEZONE });
  const seenDays = new Set<string>();
  const open: Array<{ slot_start: string; reads_as: string; reads_as_spoken: string }> = [];
  for (const slot of bookableSlots(now)) {
    if (open.length >= OPEN_DAYS) break;
    if (seenDays.has(dayOf(slot))) continue;
    if ((await bookedAt(db, slot)) >= SLOT_CAPACITY) continue;
    seenDays.add(dayOf(slot));
    open.push({ slot_start: slot.toISOString(), reads_as: describeSlot(slot, zone), reads_as_spoken: describeSlotSpoken(slot, zone) });
  }
  return open;
}

const parseSlot = (raw: string): Date | null => {
  const slot = new Date(raw);
  return Number.isNaN(slot.getTime()) ? null : slot;
};

export function registerCallbackTools(server: McpServer, db: SupabaseClient, ctx: ToolContext): void {
  server.registerTool(
    "check_callback_availability",
    {
      description:
        "Check whether support can call the caller back at a time they asked for. Pass the time as a full ISO instant in UTC, worked out from what they said. Always check before agreeing to anything: a time that is not free must never be promised. Returns alternatives when the answer is no. Call it with NO requested_time to get open_slots: the next free time on each of the next few days, to offer before the caller has named one.",
      inputSchema: {
        requested_time: z
          .string()
          .max(40)
          .optional()
          .describe("The caller's requested time as a full ISO-8601 UTC instant, for example 2026-10-06T09:00:00Z. Leave out to list the open times."),
      },
    },
    async (args) =>
      runTool(db, ctx, "check_callback_availability", "see whether a callback time is free", "requested time supplied", async (conversationId) => {
        const conv = await conversationContext(db, conversationId);
        if (!args.requested_time) {
          const open_slots = await openSlots(db, new Date(), conv.caller_timezone);
          return {
            result: { open_slots, next_step: "offer_these_open_times_then_ask_which_suits_or_for_another_time_in_the_window" },
            summary: `open_slots=${open_slots.length}`,
          };
        }
        const slot = parseSlot(args.requested_time);
        if (!slot) {
          return {
            result: { available: false, error: "unreadable_time", next_step: "ask_the_caller_for_a_day_and_time" },
            summary: "available=false reason=unreadable_time",
          };
        }

        const now = new Date();
        const refusal = slotRefusal(slot, now, await bookedAt(db, slot));
        if (!refusal) {
          return {
            result: {
              available: true,
              slot_start: slot.toISOString(),
              reads_as: describeSlot(slot, conv.caller_timezone),
              reads_as_spoken: describeSlotSpoken(slot, conv.caller_timezone),
              next_step: "read_the_time_back_and_book_it_if_they_agree",
            },
            summary: "available=true",
          };
        }
        return {
          result: {
            available: false,
            reason: REFUSAL_REASON[refusal],
            alternatives: await alternatives(db, slot, now, conv.caller_timezone),
            next_step: "say_the_reason_then_offer_the_alternatives",
          },
          summary: `available=false reason=${refusal}`,
        };
      }),
  );

  server.registerTool(
    "book_callback",
    {
      description:
        "Reserve a callback at a time already confirmed free by check_callback_availability and agreed aloud by the caller. Only after this succeeds may you say a callback is arranged. One booking per conversation; booking again moves the existing one.",
      inputSchema: {
        slot_start: z.string().max(40).describe("The agreed time as a full ISO-8601 UTC instant."),
        escalation_id: z.string().max(64).optional(),
      },
    },
    async (args) =>
      runTool(db, ctx, "book_callback", "reserve a callback slot", "agreed time supplied", async (conversationId) => {
        const conv = await conversationContext(db, conversationId);
        const slot = parseSlot(args.slot_start);
        if (!slot) {
          return {
            result: { booked: false, error: "unreadable_time", next_step: "ask_the_caller_for_a_day_and_time" },
            summary: "booked=false reason=unreadable_time",
          };
        }

        const now = new Date();
        // Checked again here, not trusted from the earlier call: the caller spent time agreeing
        // to it, and the last place in that slot may have gone in the meantime.
        const refusal = slotRefusal(slot, now, await bookedAt(db, slot));
        if (refusal) {
          return {
            result: {
              booked: false,
              reason: REFUSAL_REASON[refusal],
              alternatives: await alternatives(db, slot, now, conv.caller_timezone),
              next_step: "say_the_reason_then_offer_the_alternatives",
            },
            summary: `booked=false reason=${refusal}`,
          };
        }

        const slotEnd = new Date(slot.getTime() + SLOT_MINUTES * 60_000).toISOString();
        const escalationId =
          args.escalation_id && /^[0-9a-f-]{32,40}$/i.test(args.escalation_id) ? args.escalation_id : null;

        // One round trip, inside a Postgres advisory lock keyed on the slot: the count and the
        // write happen atomically, so two callers claiming the last seat at the same instant
        // cannot both win it. The earlier version checked capacity, then wrote, as two separate
        // steps — the gap between them was the double-booking window.
        const { data: rows, error } = await db.rpc("book_callback_slot", {
          p_conversation_id: conv.id,
          p_escalation_id: escalationId,
          p_slot_start: slot.toISOString(),
          p_slot_end: slotEnd,
          p_caller_timezone: conv.caller_timezone,
          p_capacity: SLOT_CAPACITY,
        });
        if (error) throw new Error(error.message);
        const row = (rows as Array<{ booked: boolean; booking_id: string | null; moved: boolean }>)[0];
        if (!row?.booked) {
          return {
            result: {
              booked: false,
              reason: REFUSAL_REASON.full,
              alternatives: await alternatives(db, slot, now, conv.caller_timezone),
              next_step: "say_the_reason_then_offer_the_alternatives",
            },
            summary: "booked=false reason=full (lost the race for the last seat)",
          };
        }

        // Awaited, so the outcome is recorded before the agent speaks — but it can only mark the
        // row, never fail the booking.
        await confirmByEmail(db, row.booking_id as string, conv, slot);

        return {
          result: {
            booked: true,
            slot_start: slot.toISOString(),
            reads_as: describeSlot(slot, conv.caller_timezone),
            reads_as_spoken: describeSlotSpoken(slot, conv.caller_timezone),
            support_timezone: SUPPORT_TIMEZONE,
            next_step: "tell_them_the_callback_is_arranged_and_read_the_time_back",
          },
          summary: `booked=true moved=${row.moved ? "yes" : "no"}`,
        };
      }),
  );
}
