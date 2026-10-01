import { config } from "./config.js";

/**
 * Whether the tool server is reachable at all.
 *
 * This exists because of how the outage actually presents: when the MCP server is down the Agent
 * SDK registers no tools, so the model makes ZERO tool calls rather than failing ones. Counting
 * tool errors therefore detects nothing, and the agent answers from its own knowledge instead —
 * or offers a handoff it has no way to create. A connectivity check is the only honest signal.
 */
const CACHE_MS = 10_000;
// A failure is cached briefly and needs to repeat before it counts: one slow response or a garbage
// collection pause must not end every call in progress. Declaring an outage ends calls, so the bar
// for declaring one is two consecutive failures.
const FAILURE_CACHE_MS = 2_000;
const FAILURES_BEFORE_DOWN = 2;
let cached: { at: number; ok: boolean } | null = null;
let consecutiveFailures = 0;

function healthUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  url.pathname = "/health";
  url.search = "";
  return url.toString();
}

export async function mcpHealthy(mcpUrl: string = config.mcpUrl, timeoutMs = 2000): Promise<boolean> {
  const ttl = cached?.ok === false ? FAILURE_CACHE_MS : CACHE_MS;
  if (cached && Date.now() - cached.at < ttl) return cached.ok;

  let reachable = false;
  try {
    const res = await fetch(healthUrl(mcpUrl), { signal: AbortSignal.timeout(timeoutMs) });
    reachable = res.ok;
  } catch {
    // Unreachable, refused, DNS failure or timeout: all mean the same thing to a caller.
    reachable = false;
  }

  consecutiveFailures = reachable ? 0 : consecutiveFailures + 1;
  const ok = reachable || consecutiveFailures < FAILURES_BEFORE_DOWN;
  cached = { at: Date.now(), ok };
  return ok;
}

/** Forget the cached verdict so the next call probes again. The failure streak is about the
 *  service itself, not the cache, so it survives. */
export function expireMcpHealthCache(): void {
  cached = null;
}

/** Full reset, including the failure streak. */
export function resetMcpHealthCache(): void {
  cached = null;
  consecutiveFailures = 0;
}
