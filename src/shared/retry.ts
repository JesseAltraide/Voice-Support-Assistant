/**
 * A dropped connection is not a failed job. The design's rule is to distinguish "still running"
 * from "failed": a transient network blip against Supabase, the MCP server or the model API is
 * retried, while a real error (a constraint violation, a validation failure, a missing table) is
 * surfaced immediately so it is never hidden behind pointless retries.
 */

const TRANSIENT_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
  "EPIPE", "EHOSTUNREACH", "ENETUNREACH", "ENETDOWN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
]);

// Anything not matched here is treated as permanent: guessing wrong in that direction only
// delays a real error, while guessing wrong the other way hides it.
const TRANSIENT_TEXT =
  /\b(fetch failed|socket hang up|network|timeout|timed out|overloaded|temporarily unavailable|connection (reset|closed|refused))\b|\b(408|425|429|500|502|503|504)\b/i;

export function isTransient(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string") {
    if (TRANSIENT_CODES.has(code)) return true;
    // Postgres SQLSTATEs are five characters; those are decisions, not blips.
    if (/^\d{5}$/.test(code)) return false;
  }
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") return status === 408 || status === 429 || status >= 500;
  return TRANSIENT_TEXT.test(err.message) && !/unauthori[sz]ed|forbidden|not found in the schema/i.test(err.message);
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  /** Total wall-clock budget. A voice turn cannot wait forever, whatever the attempt count says. */
  deadlineMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 150;
  const deadline = Date.now() + (options.deadlineMs ?? 4000);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransient(err) || attempt === attempts) break;
      // Exponential backoff with jitter, so retries do not synchronise across concurrent calls.
      const delay = baseDelayMs * 2 ** (attempt - 1) * (0.5 + Math.random());
      if (Date.now() + delay >= deadline) break;
      await sleep(delay);
    }
  }
  throw lastError;
}
