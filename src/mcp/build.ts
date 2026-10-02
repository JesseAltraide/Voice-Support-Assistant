import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getDb } from "../shared/db.js";
import { registerActionTools } from "./actions.js";
import { registerCallbackTools } from "./callbacks.js";
import type { ToolContext } from "./context.js";
import { registerKnowledgeTool } from "./knowledge.js";
import { registerLookupTools } from "./lookups.js";

/** One server instance per request, bound to that request's conversation. No state is kept in memory. */
export function buildServer(ctx: ToolContext, db: SupabaseClient = getDb()): McpServer {
  const server = new McpServer({ name: "relaypay-support-tools", version: "1.0.0" });
  registerLookupTools(server, db, ctx);
  registerActionTools(server, db, ctx);
  registerKnowledgeTool(server, db, ctx);
  registerCallbackTools(server, db, ctx);
  return server;
}
