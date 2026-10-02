import "dotenv/config";
import { requireEnv } from "../shared/db.js";

const MIN_TOKEN_LENGTH = 32;

// Starting values, to be tuned after measuring real calls (see week6-full-flow.md "Limits").
export const config = {
  model: process.env.AGENT_MODEL || "claude-haiku-4-5-20251001",
  mcpUrl: process.env.MCP_SERVER_URL || "http://127.0.0.1:3001/mcp",
  /** Hard ceiling for one turn. On expiry the server speaks its own apology. */
  turnTimeoutMs: 25_000,
  /** If the agent has not replied by then, the holding line is spoken so the caller hears something. */
  holdAfterMs: 4_000,
  /** Below this much of the turn budget left, a repair round trip is not worth the silence. */
  repairMinRemainingMs: 12_000,
  softWrapUpMs: 240_000,
  maxTurns: 20,
  maxToolCallsPerTurn: 6,
  sessionIdleMs: 300_000,
  unresolvedOfferAt: [3, 6] as const,
  forbiddenNamesTtlMs: 60_000,
  // Lets the handoff email link straight to a conversation's transcript. Optional: when unset
  // (local dev, where this is blank), the email still names the conversation, just without a
  // clickable link.
  publicUrl: (process.env.AGENT_SERVER_URL || "").replace(/\/$/, "") || null,
} as const;

export const MCP_TOOL_NAMES = [
  "lookup_customer",
  "lookup_transaction",
  "lookup_payout",
  "create_support_ticket",
  "create_escalation",
  "log_conversation_event",
  "search_knowledge",
  // Missing until now. The tools were registered on the MCP server and tested there, but this
  // list is what the agent is actually allowed to call — so every booking attempt failed and the
  // agent, having no tool for the job, told callers the system was broken.
  "check_callback_availability",
  "book_callback",
] as const;

export function mcpAuthToken(): string {
  return requireEnv("MCP_AUTH_TOKEN");
}

/** Bearer secret for callers of this server (Vapi, the test endpoint). Refuse to start without a strong one. */
export function agentAuthToken(): string {
  const token = requireEnv("AGENT_AUTH_TOKEN");
  if (token.length < MIN_TOKEN_LENGTH) throw new Error(`AGENT_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
  return token;
}
