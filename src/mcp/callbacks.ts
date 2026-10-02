import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  describeSlot, REFUSAL_REASON, slotRefusal, slotsOnSameDay,
  SLOT_CAPACITY, SLOT_MINUTES, SUPPORT_TIMEZONE,
} from "./callback-slots.js";
import type { ToolContext } from "./context.js";
import { runTool } from "./instrument.js";

/** How many alternatives to offer. More than three is a list nobody can hold in their head. */
const MAX_ALTERNATIVES = 3;

interface ConversationContext {
  id: string;
  caller_timezone: string | null;
}

async function conversationContext(db: SupabaseClient, conversationId: string): Promise<ConversationContext> {
  const { data, error } = await db
    .from("conversations")
    .select("id,caller_timezone")
    .eq("id", conversationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("conversation not found");
  return { id: data.id as string, caller_timezone: (data.caller_timezone as string | null) ?? null };
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
  const candidates = slotsOnSameDay(around, now);
  // Nearest to what they asked for first: someone who wanted Tuesday morning wants Tuesday
  // morning, not whatever happens to be earliest in the week.
  candidates.sort((a, b) => Math.abs(a.getTime() - around.getTime()) - Math.abs(b.getTime() - around.getTime()));

  const free: Array<{ slot_start: string; reads_as: string }> = [];
  for (const slot of candidates) {
    if (free.length >= MAX_ALTERNATIVES) break;
    if ((await bookedAt(db, slot)) < SLOT_CAPACITY) {
      free.push({ slot_start: slot.toISOString(), reads_as: describeSlot(slot, zone) });
    }
  }
  return free;
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
        "Check whether support can call the caller back at a time they asked for. Pass the time as a full ISO instant in UTC, worked out from what they said. Always check before agreeing to anything: a time that is not free must never be promised. Returns alternatives when the answer is no.",
      inputSchema: {
        requested_time: z
          .string()
          .max(40)
          .describe("The caller's requested time as a full ISO-8601 UTC instant, for example 2026-10-06T09:00:00Z."),
      },
    },
    async (args) =>
      runTool(db, ctx, "check_callback_availability", "see whether a callback time is free", "requested time supplied", async (conversationId) => {
        const conv = await conversationContext(db, conversationId);
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
        // One booking per conversation. A caller asking again is rearranging, so the existing
        // row moves rather than a second one appearing beside it.
        const existing = await db
          .from("callback_bookings")
          .select("id")
          .eq("conversation_id", conv.id)
          .eq("status", "booked")
          .maybeSingle();
        if (existing.error) throw new Error(existing.error.message);

        if (existing.data) {
          const { error } = await db
            .from("callback_bookings")
            .update({ slot_start: slot.toISOString(), slot_end: slotEnd, caller_timezone: conv.caller_timezone })
            .eq("id", existing.data.id as string);
          if (error) throw new Error(error.message);
        } else {
          const { error } = await db.from("callback_bookings").insert({
            conversation_id: conv.id,
            escalation_id: args.escalation_id && /^[0-9a-f-]{32,40}$/i.test(args.escalation_id) ? args.escalation_id : null,
            slot_start: slot.toISOString(),
            slot_end: slotEnd,
            caller_timezone: conv.caller_timezone,
            status: "booked",
          });
          if (error) throw new Error(error.message);
        }

        return {
          result: {
            booked: true,
            slot_start: slot.toISOString(),
            reads_as: describeSlot(slot, conv.caller_timezone),
            support_timezone: SUPPORT_TIMEZONE,
            next_step: "tell_them_the_callback_is_arranged_and_read_the_time_back",
          },
          summary: `booked=true moved=${existing.data ? "yes" : "no"}`,
        };
      }),
  );
}
