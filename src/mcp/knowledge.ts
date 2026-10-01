import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { ToolContext } from "./context.js";
import { runTool } from "./instrument.js";
import { buildOrQuery, keepRelevant } from "./knowledge-query.js";

interface ChunkRow {
  slug: string;
  title: string;
  section: string;
  content: string;
  summary: string;
  score: number;
}

export function registerKnowledgeTool(server: McpServer, db: SupabaseClient, ctx: ToolContext): void {
  server.registerTool(
    "search_knowledge",
    {
      description:
        "Search the approved RelayPay knowledge base. Call this BEFORE answering any product or policy question. Rewrite the caller's words into plain knowledge-base terms (for example 'fees', 'payout timelines', 'account restricted'). If grounded is false, the knowledge base does not cover it: do not answer from memory.",
      inputSchema: { query: z.string().min(2).max(300) },
    },
    async (args) =>
      runTool(db, ctx, "search_knowledge", "ground an answer in approved knowledge", "search terms supplied", async (conversationId) => {
        const orQuery = buildOrQuery(args.query);
        let chunks: ChunkRow[] = [];

        if (orQuery) {
          const { data, error } = await db.rpc("search_knowledge_chunks", { p_query: orQuery, p_limit: 3 });
          if (error) throw new Error(error.message);
          chunks = keepRelevant((data ?? []) as ChunkRow[]);
        }

        // Every search is logged, including an empty one: that row is the evidence behind a decline.
        const { error: logError } = await db.from("retrieval_logs").insert({
          conversation_id: conversationId,
          turn_id: ctx.turnId,
          query: args.query.slice(0, 300),
          chunk_slugs: chunks.map((c) => c.slug),
          source_titles: chunks.map((c) => c.title),
          source_summaries: chunks.map((c) => c.summary),
          scores: chunks.map((c) => c.score),
          result_count: chunks.length,
        });
        if (logError) throw new Error(`retrieval log failed: ${logError.message}`);

        return {
          result: {
            grounded: chunks.length > 0,
            results: chunks.map((c) => ({ slug: c.slug, title: c.title, content: c.content })),
            next_step:
              chunks.length > 0
                ? "answer_only_from_these_results"
                : "say_you_cannot_confidently_answer_and_offer_specialist_followup",
          },
          summary: `chunks=${chunks.length}${chunks.length ? ` top=${chunks[0]?.slug}` : ""}`,
        };
      }),
  );
}
