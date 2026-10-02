/**
 * The call transcript, shaped for a support agent to read.
 *
 * Kept apart from the route so it can be tested: `server.ts` binds a port on import and so cannot
 * be imported by a test, the same reason `draft.ts` exists as its own module.
 */

export interface TranscriptRow {
  user_transcript: string | null;
  assistant_response: string | null;
  created_at: string;
}

export interface TranscriptLine {
  speaker: "caller" | "agent";
  text: string;
  at: string;
}

/**
 * One row of stored turn data becomes up to two spoken lines, in the order they were actually
 * said. A turn the caller abandoned mid-flight, or one the model never got to answer, naturally
 * contributes only the side that happened rather than an empty line pretending otherwise.
 */
export function buildTranscript(rows: TranscriptRow[]): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const row of rows) {
    const caller = row.user_transcript?.trim();
    if (caller) lines.push({ speaker: "caller", text: caller, at: row.created_at });
    const agent = row.assistant_response?.trim();
    if (agent) lines.push({ speaker: "agent", text: agent, at: row.created_at });
  }
  return lines;
}
