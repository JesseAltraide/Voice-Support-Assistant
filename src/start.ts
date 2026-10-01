/**
 * Single-process entry point: runs the MCP tool server and the agent server together.
 *
 * Render's free plan has no private services, so a separately deployed MCP server would have to be
 * public — and it holds the Supabase service-role key, which bypasses row-level security. Co-hosting
 * keeps it bound to loopback, unreachable from outside the container rather than merely behind a
 * password, and leaves one cold start instead of two.
 *
 * The two servers stay genuinely separate: own Express app, own bearer auth, own tests. Only the
 * hosting is shared, so `npm run start:mcp` and `npm run start:agent` still work for local runs.
 */
process.env.MCP_COLOCATED = "1";

// The tool server listens first, so it is already accepting connections when the first call lands.
await import("./mcp/server.js");
await import("./agent/server.js");
