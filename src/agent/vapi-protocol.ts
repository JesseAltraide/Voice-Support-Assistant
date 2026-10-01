/**
 * Vapi's custom-LLM transport is OpenAI-shaped: it POSTs a chat-completions body and expects
 * server-sent chat.completion.chunk events back. Vapi's own docs do not pin down whether the
 * call id reaches this endpoint, so the id is looked for in several documented and plausible
 * places and the winning location is reported, to be confirmed from a real call's logs.
 */

export interface CallIdHit {
  id: string;
  source: string;
}

/** Permissive but safe: a Vapi call id is a UUID, and this also rejects unresolved templates. */
const PLAUSIBLE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/;

type Json = Record<string, unknown> | null | undefined;

const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

function plausibleId(value: unknown): string | null {
  return typeof value === "string" && PLAUSIBLE_ID.test(value) ? value : null;
}

export function extractCallId(headers: Record<string, unknown>, body: Json): CallIdHit | null {
  // `x-call-id` is what Vapi actually sends, confirmed from a real call log; the others are kept
  // as fallbacks in case the header name differs by transport or changes.
  for (const name of ["x-call-id", "x-vapi-call-id"]) {
    const raw = headers[name];
    const id = plausibleId(Array.isArray(raw) ? raw[0] : raw);
    if (id) return { id, source: `header ${name}` };
  }

  const b = asObject(body);
  if (!b) return null;
  const metadata = asObject(b.metadata);
  const candidates: Array<[string, unknown]> = [
    ["body.call.id", asObject(b.call)?.id],
    ["body.metadata.call.id", asObject(metadata?.call)?.id],
    ["body.call_id", b.call_id],
    ["body.metadata.callId", metadata?.callId],
  ];
  for (const [source, value] of candidates) {
    const id = plausibleId(value);
    if (id) return { id, source };
  }
  return null;
}

/**
 * The caller's latest words. Our session already holds the conversation, so only the last user
 * message is needed; the rest of Vapi's history is ignored.
 */
export function extractUserText(body: Json): string | null {
  const messages = asObject(body)?.messages;
  if (!Array.isArray(messages)) return null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = asObject(messages[i]);
    if (m?.role !== "user") continue;
    const content = m.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((part) => {
          const p = asObject(part);
          return p?.type === "text" && typeof p.text === "string" ? p.text : "";
        })
        .join("");
    }
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

export function wantsStream(body: Json): boolean {
  return asObject(body)?.stream !== false;
}

const MODEL_LABEL = "relaypay-support-agent";

function frame(id: string, choice: Record<string, unknown>): string {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_LABEL,
    choices: [{ index: 0, ...choice }],
  })}\n\n`;
}

export function sseChunk(id: string, content: string): string {
  return frame(id, { delta: { content }, finish_reason: null });
}

export function sseDone(id: string): string {
  return `${frame(id, { delta: {}, finish_reason: "stop" })}data: [DONE]\n\n`;
}

/** Non-streaming fallback, for a Vapi config or a probe that sets stream:false. */
export function completionBody(id: string, content: string): Record<string, unknown> {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_LABEL,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}
