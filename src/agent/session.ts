import { tmpdir } from "node:os";
import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { config, MCP_TOOL_NAMES, mcpAuthToken } from "./config.js";
import type { ToolResult } from "./facts.js";
import { SYSTEM_PROMPT } from "./prompt.js";

export interface RawTurn {
  text: string;
  toolResults: ToolResult[];
  toolCallCount: number;
}

export class TurnTimeoutError extends Error {
  constructor() {
    super("turn timed out");
  }
}

type Block = { type?: string; id?: string; name?: string; tool_use_id?: string; content?: unknown; is_error?: boolean; text?: string };

function blocksOf(message: unknown): Block[] {
  const content = (message as { content?: unknown } | undefined)?.content;
  return Array.isArray(content) ? (content as Block[]) : [];
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (b as Block).text ?? "").join("");
  return "";
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * One long-lived Agent SDK session per call. Starting a fresh runtime per turn cost 4 to 6 seconds in
 * the latency spike; one session that stays open costs about 1.5 to 2.6 seconds after warm-up (#60).
 * The conversation's identity rides in a header, so the tools need no memory between calls.
 */
export class AgentSession {
  private readonly queue: string[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private readonly q: Query;
  private readonly iterator: AsyncIterator<unknown>;
  lastUsed = Date.now();
  dead = false;

  constructor(conversationId: string) {
    const self = this;
    async function* input(): AsyncGenerator<SDKUserMessage> {
      while (!self.closed) {
        while (self.queue.length === 0 && !self.closed) await new Promise<void>((resolve) => (self.wake = resolve));
        const next = self.queue.shift();
        if (next === undefined) return;
        yield { type: "user", message: { role: "user", content: next }, parent_tool_use_id: null };
      }
    }

    this.q = query({
      prompt: input(),
      options: {
        model: config.model,
        systemPrompt: SYSTEM_PROMPT,
        tools: [],
        allowedTools: MCP_TOOL_NAMES.map((n) => `mcp__relaypay__${n}`),
        mcpServers: {
          relaypay: {
            type: "http",
            url: config.mcpUrl,
            headers: { authorization: `Bearer ${mcpAuthToken()}`, "x-conversation-id": conversationId },
          },
        },
        strictMcpConfig: true,
        settingSources: [],
        persistSession: false,
        thinking: { type: "disabled" },
        cwd: process.env.AGENT_CWD || tmpdir(),
      },
    });
    this.iterator = this.q[Symbol.asyncIterator]();
  }

  /** One caller turn. Rejects on timeout, on too many tool calls, or if the session ends. */
  async ask(userText: string, timeoutMs: number): Promise<RawTurn> {
    if (this.dead) throw new Error("session is closed");
    this.lastUsed = Date.now();
    this.queue.push(userText);
    this.wake?.();

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TurnTimeoutError()), timeoutMs);
    });
    try {
      return await Promise.race([this.readTurn(), timeout]);
    } catch (err) {
      // After any failure the session's state is unknown, so it is discarded and rebuilt from stored turns.
      await this.close();
      throw err;
    } finally {
      clearTimeout(timer);
      this.lastUsed = Date.now();
    }
  }

  private async readTurn(): Promise<RawTurn> {
    const names = new Map<string, string>();
    const toolResults: ToolResult[] = [];
    let toolCallCount = 0;

    for (;;) {
      const { value, done } = await this.iterator.next();
      if (done) throw new Error("agent session ended");
      const m = value as {
        type: string; subtype?: string; result?: string; message?: unknown;
        is_error?: boolean; api_error_status?: number | null;
      };

      if (m.type === "assistant") {
        for (const b of blocksOf(m.message)) {
          if (b.type !== "tool_use" || !b.id || !b.name) continue;
          names.set(b.id, b.name);
          toolCallCount += 1;
          if (toolCallCount > config.maxToolCallsPerTurn) throw new Error("too many tool calls in one turn");
        }
      } else if (m.type === "user") {
        for (const b of blocksOf(m.message)) {
          if (b.type !== "tool_result" || !b.tool_use_id) continue;
          toolResults.push({
            name: names.get(b.tool_use_id) ?? "unknown",
            data: parseJson(textOf(b.content)),
            isError: b.is_error === true,
          });
        }
      } else if (m.type === "result") {
        if (m.subtype !== "success") throw new Error(`agent stopped: ${m.subtype ?? "unknown"}`);
        // An upstream API failure (429, 529, overloaded) can arrive as a "success" result carrying
        // is_error and the provider's message. Without this check that message is spoken aloud.
        if (m.is_error === true) {
          const status = typeof m.api_error_status === "number" ? ` ${m.api_error_status}` : "";
          throw new Error(`model API error${status}: ${String(m.result ?? "").slice(0, 120)}`);
        }
        return { text: m.result ?? "", toolResults, toolCallCount };
      }
    }
  }

  async close(): Promise<void> {
    if (this.dead) return;
    this.dead = true;
    this.closed = true;
    this.wake?.();
    try {
      await this.q.interrupt();
    } catch {
      // The process may already be gone.
    }
    try {
      this.q.close();
    } catch {
      // Same.
    }
  }
}
