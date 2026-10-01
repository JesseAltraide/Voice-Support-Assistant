import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { expireMcpHealthCache, mcpHealthy, resetMcpHealthCache } from "./mcp-health.js";

// When the tool server is unreachable the Agent SDK registers no tools at all, so the model makes
// zero tool calls rather than failing ones. Counting tool errors cannot detect that; only a
// connectivity check can.
let server: Server | null = null;

function listen(handler: () => void): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((_req, res) => {
      handler();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server!.address() as { port: number };
      resolve(`http://127.0.0.1:${port}/mcp`);
    });
  });
}

afterEach(async () => {
  resetMcpHealthCache();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

describe("mcpHealthy", () => {
  it("reports healthy when the tool server answers", async () => {
    const url = await listen(() => {});
    expect(await mcpHealthy(url)).toBe(true);
  });

  // Declaring an outage ends live calls, so one slow response must not do it: the check tolerates a
  // single failure and only reports down when it fails twice in a row.
  it("tolerates one failure, then reports unhealthy on the second", async () => {
    // Port 1 is privileged and never has a listener in this environment.
    expect(await mcpHealthy("http://127.0.0.1:1/mcp", 500)).toBe(true);
    expireMcpHealthCache();
    expect(await mcpHealthy("http://127.0.0.1:1/mcp", 500)).toBe(false);
  });

  it("negative: a hostname that cannot resolve is unhealthy once it has failed twice, not an exception", async () => {
    await mcpHealthy("http://no-such-host.invalid/mcp", 1000);
    expireMcpHealthCache();
    expect(await mcpHealthy("http://no-such-host.invalid/mcp", 1000)).toBe(false);
  });

  it("a success in between resets the count, so intermittent blips never declare an outage", async () => {
    const url = await listen(() => {});
    expect(await mcpHealthy("http://127.0.0.1:1/mcp", 500)).toBe(true);
    expireMcpHealthCache();
    expect(await mcpHealthy(url)).toBe(true);
    expireMcpHealthCache();
    expect(await mcpHealthy("http://127.0.0.1:1/mcp", 500)).toBe(true);
  });

  it("caches the answer so a health check is not paid on every turn", async () => {
    let hits = 0;
    const url = await listen(() => { hits += 1; });
    await mcpHealthy(url);
    await mcpHealthy(url);
    await mcpHealthy(url);
    expect(hits).toBe(1);
  });

  it("the cache can be cleared, so recovery is picked up", async () => {
    let hits = 0;
    const url = await listen(() => { hits += 1; });
    await mcpHealthy(url);
    resetMcpHealthCache();
    await mcpHealthy(url);
    expect(hits).toBe(2);
  });
});
