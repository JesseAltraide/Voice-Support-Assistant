import { describe, expect, it } from "vitest";
import { extractCallId, extractUserText, sseChunk, sseDone, wantsStream } from "./vapi-protocol.js";

describe("extractUserText", () => {
  it("takes the last user message, ignoring earlier turns and the assistant", () => {
    const body = {
      messages: [
        { role: "system", content: "you are..." },
        { role: "user", content: "first thing" },
        { role: "assistant", content: "a reply" },
        { role: "user", content: "  what fees do you charge?  " },
      ],
    };
    expect(extractUserText(body)).toBe("what fees do you charge?");
  });

  it("handles content sent as an array of text parts", () => {
    const body = { messages: [{ role: "user", content: [{ type: "text", text: "check " }, { type: "text", text: "TXN-9001" }] }] };
    expect(extractUserText(body)).toBe("check TXN-9001");
  });

  it("negative: returns null when there is no user message, no messages, or junk", () => {
    expect(extractUserText({ messages: [{ role: "assistant", content: "hi" }] })).toBeNull();
    expect(extractUserText({ messages: [] })).toBeNull();
    expect(extractUserText({})).toBeNull();
    expect(extractUserText(null)).toBeNull();
    expect(extractUserText({ messages: "nope" })).toBeNull();
    expect(extractUserText({ messages: [{ role: "user", content: "   " }] })).toBeNull();
  });

  it("ignores a tool-result-shaped content array with no text parts", () => {
    expect(extractUserText({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] })).toBeNull();
  });
});

describe("extractCallId", () => {
  const ID = "3f9a1b2c-1111-2222-3333-444455556666";

  it.each([
    ["header x-vapi-call-id", { "x-vapi-call-id": ID }, {}],
    ["body.call.id", {}, { call: { id: ID } }],
    ["body.metadata.call.id", {}, { metadata: { call: { id: ID } } }],
    ["body.call_id", {}, { call_id: ID }],
    ["body.metadata.callId", {}, { metadata: { callId: ID } }],
  ])("finds the call id in %s", (_name, headers, body) => {
    expect(extractCallId(headers, body)?.id).toBe(ID);
  });

  it("reports where it was found, so the real Vapi shape can be confirmed from logs", () => {
    expect(extractCallId({}, { call: { id: ID } })?.source).toBe("body.call.id");
    expect(extractCallId({ "x-vapi-call-id": ID }, {})?.source).toBe("header");
  });

  it("prefers the header over the body when both are present", () => {
    const other = "aaaaaaaa-1111-2222-3333-444455556666";
    expect(extractCallId({ "x-vapi-call-id": ID }, { call: { id: other } })?.id).toBe(ID);
  });

  it("negative: returns null when absent, empty, or not a plausible id", () => {
    expect(extractCallId({}, {})).toBeNull();
    expect(extractCallId({}, null)).toBeNull();
    expect(extractCallId({ "x-vapi-call-id": "" }, {})).toBeNull();
    expect(extractCallId({ "x-vapi-call-id": "{{call.id}}" }, {})).toBeNull(); // unresolved template
    expect(extractCallId({}, { call: { id: 12345 } })).toBeNull();
    expect(extractCallId({}, { call: { id: "x".repeat(200) } })).toBeNull();
    expect(extractCallId({}, { call: { id: "has spaces" } })).toBeNull();
  });
});

describe("wantsStream", () => {
  it("streams unless the request explicitly says otherwise", () => {
    expect(wantsStream({ stream: true })).toBe(true);
    expect(wantsStream({})).toBe(true);
    expect(wantsStream({ stream: false })).toBe(false);
    expect(wantsStream(null)).toBe(true);
  });
});

describe("sse framing", () => {
  it("emits an OpenAI-shaped chunk that Vapi can parse", () => {
    const raw = sseChunk("chatcmpl-1", "Hello there.");
    expect(raw.startsWith("data: ")).toBe(true);
    expect(raw.endsWith("\n\n")).toBe(true);
    const parsed = JSON.parse(raw.slice(6).trim());
    expect(parsed.object).toBe("chat.completion.chunk");
    expect(parsed.id).toBe("chatcmpl-1");
    expect(parsed.choices[0].delta.content).toBe("Hello there.");
    expect(parsed.choices[0].finish_reason).toBeNull();
    expect(parsed.choices[0].index).toBe(0);
    expect(typeof parsed.created).toBe("number");
  });

  it("escapes newlines and quotes so one chunk can never break the stream framing", () => {
    const raw = sseChunk("chatcmpl-1", 'line one\nline "two"');
    expect(raw.split("\n\n")).toHaveLength(2);
    expect(JSON.parse(raw.slice(6).trim()).choices[0].delta.content).toBe('line one\nline "two"');
  });

  it("closes with a stop chunk and the [DONE] sentinel", () => {
    const raw = sseDone("chatcmpl-1");
    const [stop, done] = raw.trimEnd().split("\n\n");
    expect(JSON.parse(stop!.slice(6)).choices[0].finish_reason).toBe("stop");
    expect(JSON.parse(stop!.slice(6)).choices[0].delta).toEqual({});
    expect(done).toBe("data: [DONE]");
  });
});
