import type { SupabaseClient } from "@supabase/supabase-js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "./context.js";
import { addEvent } from "./events.js";

export interface ToolOutcome {
  result: Record<string, unknown>;
  /** Safe one-liner for the tool_calls log. Must never hold customer-record fields. */
  summary: string;
}

const asText = (payload: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
});

const GENERIC_ERROR = { error: "tool_failed", message: "That action could not be completed." };

async function logCall(
  db: SupabaseClient,
  ctx: ToolContext,
  row: {
    toolName: string;
    purpose: string;
    inputSummary: string;
    resultSummary: string | null;
    status: "ok" | "error";
    errorMessage: string | null;
    durationMs: number;
  },
): Promise<void> {
  const { error } = await db.from("tool_calls").insert({
    conversation_id: ctx.conversationId,
    turn_id: ctx.turnId,
    tool_name: row.toolName,
    purpose: row.purpose,
    input_summary: row.inputSummary.slice(0, 500),
    result_summary: row.resultSummary?.slice(0, 500) ?? null,
    status: row.status,
    error_message: row.errorMessage,
    duration_ms: row.durationMs,
  });
  // A failed log write must not fail the caller's request, but it must be visible.
  if (error) console.error(`tool_calls insert failed for ${row.toolName}: ${error.message}`);
}

/**
 * Every tool goes through here, so logging is done by the wrapper and never left to the
 * agent's discretion. A request with no conversation header is refused outright: identity
 * comes from the header only, never from anything the model supplies. Failures are logged
 * with detail plus a conversation event; the caller only sees a generic message, so no
 * internal error text can leak into a spoken reply.
 */
export async function runTool(
  db: SupabaseClient,
  ctx: ToolContext,
  toolName: string,
  purpose: string,
  inputSummary: string,
  fn: (conversationId: string) => Promise<ToolOutcome>,
): Promise<CallToolResult> {
  const started = Date.now();
  const conversationId = ctx.conversationId;

  if (!conversationId) {
    await logCall(db, ctx, {
      toolName, purpose, inputSummary, resultSummary: null,
      status: "error", errorMessage: "missing conversation context", durationMs: 0,
    });
    return { ...asText(GENERIC_ERROR), isError: true };
  }

  try {
    const { result, summary } = await fn(conversationId);
    await logCall(db, ctx, {
      toolName, purpose, inputSummary, resultSummary: summary,
      status: "ok", errorMessage: null, durationMs: Date.now() - started,
    });
    return asText(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logCall(db, ctx, {
      toolName, purpose, inputSummary, resultSummary: null,
      status: "error", errorMessage: message.slice(0, 500), durationMs: Date.now() - started,
    });
    await addEvent(db, conversationId, "failure", `${toolName} failed`, { tool: toolName });
    return { ...asText(GENERIC_ERROR), isError: true };
  }
}

export type CounterColumn =
  | "unresolved_count"
  | "handoff_offers_made"
  | "failed_lookup_count"
  | "clarify_streak"
  | "turn_count";

/** Atomic increment inside Postgres. Returns the new value. */
export async function bump(db: SupabaseClient, conversationId: string, column: CounterColumn): Promise<number> {
  const { data, error } = await db.rpc("bump_conversation_counter", {
    p_id: conversationId,
    p_column: column,
    p_by: 1,
  });
  if (error) throw new Error(`bump ${column} failed: ${error.message}`);
  if (typeof data !== "number") throw new Error(`bump ${column} returned no value`);
  return data;
}
