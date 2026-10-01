import express, { type Response, type Router } from "express";
import { config } from "./config.js";
import { CALL_END_MARKER, ERROR_FALLBACK_UNLOGGED, HOLDING_LINE } from "./guard.js";
import { endConversation, handleTurn, warmSession } from "./respond.js";
import { createConversation } from "./store.js";
import { completionBody, extractCallId, extractUserText, sseChunk, sseDone, wantsStream } from "./vapi-protocol.js";

/**
 * Vapi speaks to this route as if it were an OpenAI chat-completions endpoint, and to /vapi/server
 * with call lifecycle events. Vapi's docs do not state whether the call id reaches the model route,
 * so the id is looked for in several places and the winning location is logged once, to be
 * confirmed from a real call rather than assumed.
 */
export function vapiRouter(): Router {
  const router = express.Router();
  let reportedSource: string | null = null;

  const conversationFor = (callId: string) =>
    createConversation({ channel: "voice", isTest: false, vapiCallId: callId, callerIdentifier: `vapi:${callId}` });

  router.post("/vapi/chat/completions", express.json({ limit: "1mb" }), async (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    const responseId = `chatcmpl-${Date.now().toString(36)}`;
    const streaming = wantsStream(body);

    const hit = extractCallId(req.headers as Record<string, unknown>, body);
    if (hit && hit.source !== reportedSource) {
      reportedSource = hit.source;
      console.log(`vapi: call id found at ${hit.source}`);
    }
    const text = extractUserText(body);

    // No caller turn yet (a Vapi probe, or its own first message): nothing to say.
    if (!text) {
      send(res, responseId, streaming, "");
      return;
    }
    if (!hit) {
      console.error("vapi: no call id in request; cannot bind the conversation");
      send(res, responseId, streaming, ERROR_FALLBACK_UNLOGGED);
      return;
    }

    try {
      const conversationId = await conversationFor(hit.id);
      if (!streaming) {
        const result = await handleTurn({ conversationId, text });
        send(res, responseId, false, result.reply);
        return;
      }

      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.flushHeaders();
      // Vapi cancels the request when the caller interrupts or keeps talking, then re-sends. The
      // turn is already in flight and cannot be recalled, but it must not be recorded as something
      // the caller heard, or it would distort the counters and look like a repeated question.
      let disconnected = false;
      res.on("close", () => {
        if (!answered) disconnected = true;
      });
      // The holding line is spoken only when the turn is genuinely slow, so the caller is never
      // left wondering whether the line dropped. It is written by the server, so it still works
      // when the agent is the thing that is failing.
      let answered = false;
      const holdTimer = setTimeout(() => {
        if (!answered) res.write(sseChunk(responseId, `${HOLDING_LINE} `));
      }, config.holdAfterMs);

      let reply: string;
      try {
        const result = await handleTurn({ conversationId, text, isDelivered: () => !disconnected });
        // Vapi hangs up on hearing this phrase, so a conversation the server has closed does not
        // leave a metered line open.
        reply = result.ended ? `${result.reply} ${CALL_END_MARKER}` : result.reply;
      } finally {
        answered = true;
        clearTimeout(holdTimer);
      }
      if (disconnected) return;
      res.write(sseChunk(responseId, reply));
      res.write(sseDone(responseId));
      res.end();
    } catch (err) {
      console.error("vapi turn failed:", err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        send(res, responseId, streaming, ERROR_FALLBACK_UNLOGGED);
        return;
      }
      res.write(sseChunk(responseId, ERROR_FALLBACK_UNLOGGED));
      res.write(sseDone(responseId));
      res.end();
    }
  });

  /**
   * Call lifecycle. The start event is what makes the first turn fast: the model session is warmed
   * while Vapi is still speaking its greeting. The end event closes the conversation, and the
   * sweep covers the case where that event is lost.
   */
  router.post("/vapi/server", express.json({ limit: "1mb" }), async (req, res) => {
    const message = (req.body as { message?: Record<string, unknown> } | undefined)?.message;
    const type = typeof message?.type === "string" ? message.type : null;
    const hit = extractCallId({}, message);
    if (!type || !hit) {
      res.json({ received: true });
      return;
    }

    try {
      if (type === "status-update" && message?.status === "in-progress") {
        warmSession(await conversationFor(hit.id));
      } else if (type === "end-of-call-report") {
        await endConversation(await conversationFor(hit.id));
      }
    } catch (err) {
      // Vapi must not retry because of our bookkeeping; the sweep closes anything left open.
      console.error(`vapi ${type} failed:`, err instanceof Error ? err.message : err);
    }
    res.json({ received: true });
  });

  return router;
}

function send(res: Response, id: string, streaming: boolean, content: string): void {
  if (!streaming) {
    res.json(completionBody(id, content));
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  if (content) res.write(sseChunk(id, content));
  res.write(sseDone(id));
  res.end();
}
