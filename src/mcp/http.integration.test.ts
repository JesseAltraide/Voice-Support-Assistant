import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../shared/db.js";

// Attacks the real HTTP process. The token is generated for this run only and never stored.
const db = getDb();
const TOKEN = randomBytes(24).toString("hex"); // 48 chars
const TSX = "node_modules/tsx/dist/cli.mjs";
let child: ChildProcess;
let base = "";
let conversationId = "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

function start(env: Record<string, string>): { proc: ChildProcess; ready: Promise<void>; output: () => string } {
  const proc = spawn(process.execPath, [TSX, "src/mcp/server.ts"], {
    env: { ...process.env, HOST: "127.0.0.1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let buf = "";
  proc.stdout?.on("data", (d) => (buf += d));
  proc.stderr?.on("data", (d) => (buf += d));
  const ready = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`server did not start: ${buf}`)), 20_000);
    const poll = setInterval(() => {
      if (buf.includes("listening")) { clearInterval(poll); clearTimeout(t); resolve(); }
    }, 100);
  });
  return { proc, ready, output: () => buf };
}

function exitCode(s: { proc: ChildProcess }): Promise<number | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => { s.proc.kill(); resolve(null); }, 15_000);
    s.proc.on("exit", (c) => { clearTimeout(t); resolve(c); });
  });
}

const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const LIST_TOOLS = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

beforeAll(async () => {
  const { data, error } = await db.from("conversations").insert({ channel: "text", is_test: true, caller_identifier: "http-test" }).select("id").single();
  if (error || !data) throw new Error(error?.message);
  conversationId = data.id as string;
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const s = start({ PORT: String(port), MCP_AUTH_TOKEN: TOKEN });
  child = s.proc;
  await s.ready;
}, 40_000);

afterAll(async () => {
  child?.kill();
  await db.from("conversations").delete().eq("id", conversationId);
});

const post = (headers: Record<string, string>, body: string) =>
  fetch(`${base}/mcp`, { method: "POST", headers: { ...MCP_HEADERS, ...headers }, body });

function parseRpc(text: string): any {
  const dataLine = text.split("\n").find((l) => l.startsWith("data:"));
  return JSON.parse(dataLine ? dataLine.slice(5).trim() : text);
}

describe("auth", () => {
  it("health is open and says nothing sensitive", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it.each([
    ["no Authorization header", {}],
    ["wrong token of the right length", { authorization: `Bearer ${"x".repeat(TOKEN.length)}` }],
    ["a truncated token", { authorization: `Bearer ${TOKEN.slice(0, 10)}` }],
    ["the token without the Bearer scheme", { authorization: TOKEN }],
    ["an empty bearer", { authorization: "Bearer " }],
  ])("rejects %s with 401", async (_name, headers) => {
    const res = await post({ ...headers, "x-conversation-id": conversationId }, LIST_TOOLS);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorised" });
  });

  it("rejects GET and DELETE on /mcp without auth, and refuses them with auth", async () => {
    expect((await fetch(`${base}/mcp`)).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: "DELETE" })).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
  });
});

describe("request handling", () => {
  const authed = { authorization: `Bearer ${TOKEN}` };

  it("refuses a valid token with no conversation header", async () => {
    expect((await post(authed, LIST_TOOLS)).status).toBe(400);
  });

  it("refuses a conversation header that is not a UUID", async () => {
    expect((await post({ ...authed, "x-conversation-id": "1 OR 1=1" }, LIST_TOOLS)).status).toBe(400);
  });

  it("a malformed body returns a generic 400, never a stack trace or file path", async () => {
    const res = await post({ ...authed, "x-conversation-id": conversationId }, "{not json");
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "bad_request" }));
  });

  it("an oversized body is refused, and the server keeps serving afterwards", async () => {
    const res = await post({ ...authed, "x-conversation-id": conversationId }, JSON.stringify({ pad: "x".repeat(200_000) }));
    expect(res.status).toBe(400);
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("unauthenticated oversized bodies are rejected before being read", async () => {
    const res = await post({ "x-conversation-id": conversationId }, JSON.stringify({ pad: "x".repeat(200_000) }));
    expect(res.status).toBe(401);
  });

  it("positive control: a correct token and header lists the seven tools over real HTTP", async () => {
    const res = await post({ ...authed, "x-conversation-id": conversationId }, LIST_TOOLS);
    expect(res.status).toBe(200);
    const json = parseRpc(await res.text());
    expect(json.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
      "create_escalation", "create_support_ticket", "log_conversation_event",
      "lookup_customer", "lookup_payout", "lookup_transaction", "search_knowledge",
    ]);
  });

  it("a real tool call over HTTP is bound to the header's conversation and logged there", async () => {
    const call = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lookup_transaction", arguments: { transaction_id: "TXN-9001" } } });
    const res = await post({ ...authed, "x-conversation-id": conversationId }, call);
    expect(res.status).toBe(200);
    const raw = await res.text();
    const rpc = parseRpc(raw);
    expect(rpc.error, `JSON-RPC error: ${raw}`).toBeUndefined();
    expect(rpc.result?.isError, `tool error: ${raw}`).not.toBe(true);
    const { data } = await db.from("tool_calls").select("tool_name,status").eq("conversation_id", conversationId);
    expect(data?.map((r) => r.tool_name)).toContain("lookup_transaction");
  });
});

describe("startup guard", () => {
  it("refuses to start with a token shorter than 32 characters", async () => {
    const s = start({ PORT: String(await freePort()), MCP_AUTH_TOKEN: "short-token" });
    const code = await exitCode(s);
    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
    expect(s.output()).toMatch(/at least 32/);
  }, 30_000);

  it("refuses to start with no token at all", async () => {
    const s = start({ PORT: String(await freePort()), MCP_AUTH_TOKEN: "" });
    const code = await exitCode(s);
    expect(code).not.toBeNull();
    expect(code).not.toBe(0);
  }, 30_000);
});
