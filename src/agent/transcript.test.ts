import { describe, expect, it } from "vitest";
import { buildTranscript, type TranscriptRow } from "./transcript.js";

const row = (over: Partial<TranscriptRow> = {}): TranscriptRow => ({
  user_transcript: "Hi",
  assistant_response: "Hello there",
  created_at: "2026-10-02T10:00:00Z",
  ...over,
});

describe("shaping a call for support to read", () => {
  it("each turn becomes caller then agent, in order", () => {
    const lines = buildTranscript([row()]);
    expect(lines).toEqual([
      { speaker: "caller", text: "Hi", at: "2026-10-02T10:00:00Z" },
      { speaker: "agent", text: "Hello there", at: "2026-10-02T10:00:00Z" },
    ]);
  });

  it("a turn the agent never answered contributes only the caller's line", () => {
    const lines = buildTranscript([row({ assistant_response: null })]);
    expect(lines).toEqual([{ speaker: "caller", text: "Hi", at: "2026-10-02T10:00:00Z" }]);
  });

  it("a turn with no caller speech contributes only the agent's line", () => {
    const lines = buildTranscript([row({ user_transcript: null })]);
    expect(lines).toEqual([{ speaker: "agent", text: "Hello there", at: "2026-10-02T10:00:00Z" }]);
  });

  it("whitespace-only text is treated as absent, not as an empty line", () => {
    const lines = buildTranscript([row({ user_transcript: "   ", assistant_response: "  " })]);
    expect(lines).toEqual([]);
  });

  it("multiple turns stay in order", () => {
    const lines = buildTranscript([
      row({ user_transcript: "first", assistant_response: "ok", created_at: "t1" }),
      row({ user_transcript: "second", assistant_response: "ok2", created_at: "t2" }),
    ]);
    expect(lines.map((l) => l.text)).toEqual(["first", "ok", "second", "ok2"]);
  });

  it("an empty call produces an empty transcript", () => {
    expect(buildTranscript([])).toEqual([]);
  });
});
