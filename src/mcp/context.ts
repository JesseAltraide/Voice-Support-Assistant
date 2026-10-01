import type { IncomingHttpHeaders } from "node:http";

/**
 * Which conversation and turn a tool call belongs to. The agent server sets these as
 * request headers per conversation, so tools need no memory between calls.
 */
export interface ToolContext {
  conversationId: string | null;
  turnId: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && UUID.test(value) ? value : null;
}

export function contextFromHeaders(headers: IncomingHttpHeaders): ToolContext {
  return {
    conversationId: uuidHeader(headers, "x-conversation-id"),
    turnId: uuidHeader(headers, "x-turn-id"),
  };
}

export function isUuid(value: string | null | undefined): value is string {
  return !!value && UUID.test(value);
}
