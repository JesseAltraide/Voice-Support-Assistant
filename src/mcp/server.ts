import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { getDb, requireEnv } from "../shared/db.js";
import { buildServer } from "./build.js";
import { contextFromHeaders } from "./context.js";

const MIN_TOKEN_LENGTH = 32;
const token = requireEnv("MCP_AUTH_TOKEN");
if (token.length < MIN_TOKEN_LENGTH) {
  throw new Error(`MCP_AUTH_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters`);
}
const expected = Buffer.from(token);
// Validate the Supabase credentials at boot: they are read lazily, so a missing one would
// otherwise give a healthy /health and then fail on the first tool call.
getDb();

function authorised(req: Request): boolean {
  const header = req.headers.authorization ?? "";
  const supplied = Buffer.from(header.startsWith("Bearer ") ? header.slice(7) : "");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!authorised(req)) {
    res.status(401).json({ error: "unauthorised" });
    return;
  }
  next();
}

const app = express();
app.disable("x-powered-by");

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// Auth runs before the body is parsed, so an unauthenticated client never gets its body read.
// Stateless streamable HTTP: a fresh server and transport per request, so the service can
// restart or scale without losing anything, and a retried request cannot hit stale state.
app.post("/mcp", requireAuth, express.json({ limit: "100kb" }), async (req, res) => {
  const ctx = contextFromHeaders(req.headers);
  if (!ctx.conversationId) {
    res.status(400).json({ error: "x-conversation-id header is required" });
    return;
  }
  const server = buildServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("mcp request failed:", err instanceof Error ? err.message : err);
    if (!res.headersSent) res.status(500).json({ error: "internal_error" });
  }
});

const notAllowed = (_req: Request, res: Response) => {
  res.status(405).json({ error: "method_not_allowed" });
};
app.get("/mcp", requireAuth, notAllowed);
app.delete("/mcp", requireAuth, notAllowed);

// A malformed body must never return Express's default page, which can carry a stack trace.
app.use((_err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(400).json({ error: "bad_request" });
});

// Co-hosted with the agent server (src/start.ts): bind loopback on our own port, because the
// platform's PORT belongs to the public agent server and this one must not be reachable from
// outside the container. Deployed alone, behave normally and take PORT.
const colocated = process.env.MCP_COLOCATED === "1";
const port = Number(colocated ? (process.env.MCP_PORT ?? 3001) : (process.env.PORT ?? process.env.MCP_PORT ?? 3001));
const host = colocated ? "127.0.0.1" : (process.env.HOST ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1"));
app.listen(port, host, () => {
  console.log(`MCP server listening on http://${host}:${port}/mcp`);
});
