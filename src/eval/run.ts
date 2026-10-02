import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getDb, requireEnv } from "../shared/db.js";
import { SCENARIOS, type Facts, type Scenario } from "./scenarios.js";

/**
 * Runs every scenario through the plain-text endpoint, then judges it on what reached the database.
 * Voice cannot be scripted, so this is how the PRD's scenarios run headless and how the
 * `evaluations` table is filled. Scenario 9 (a real spoken call) is run by hand and recorded here
 * from the Vapi log; it is the one thing this harness cannot do for itself.
 *
 *   npm run eval                  against a locally running agent server
 *   EVAL_BASE_URL=https://...     against the deployed one
 */
const BASE = process.env.EVAL_BASE_URL ?? "http://127.0.0.1:3002";
const TOKEN = requireEnv("AGENT_AUTH_TOKEN");
const db = getDb();
const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;

interface TurnResponse {
  conversation_id: string;
  reply: string;
  answer_type: string;
  speech_guard_tripped: boolean;
}

async function say(message: string, conversationId?: string): Promise<TurnResponse> {
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ message, test: true, ...(conversationId ? { conversation_id: conversationId } : {}) }),
  });
  if (!res.ok) throw new Error(`/chat returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as TurnResponse;
}

/** Everything the checks are allowed to look at: records, not opinions. */
async function collectFacts(conversationId: string, replies: string[]): Promise<Facts> {
  const [turns, tools, retrievals, escalations, tickets] = await Promise.all([
    db.from("conversation_turns").select("answer_type,speech_guard_tripped").eq("conversation_id", conversationId),
    db.from("tool_calls").select("tool_name").eq("conversation_id", conversationId),
    db.from("retrieval_logs").select("result_count").eq("conversation_id", conversationId),
    db.from("escalations").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId),
    db.from("support_tickets").select("id", { count: "exact", head: true }).eq("conversation_id", conversationId),
  ]);
  const retrievalRows = retrievals.data ?? [];
  return {
    answerTypes: (turns.data ?? []).map((t) => t.answer_type as string).filter(Boolean),
    guardTrips: (turns.data ?? []).filter((t) => t.speech_guard_tripped === true).length,
    toolsUsed: (tools.data ?? []).map((t) => (t.tool_name as string).replace(/^mcp__[^_]+__/, "")),
    retrievals: retrievalRows.length,
    emptyRetrievals: retrievalRows.filter((r) => (r.result_count as number) === 0).length,
    escalations: escalations.count ?? 0,
    tickets: tickets.count ?? 0,
    replies,
  };
}

async function runScenario(s: Scenario): Promise<{ passed: boolean; notes: string; conversationId: string | null }> {
  let conversationId: string | null = null;
  const replies: string[] = [];
  try {
    for (const turn of s.turns) {
      const r = await say(turn, conversationId ?? undefined);
      conversationId = r.conversation_id;
      replies.push(r.reply);
    }
    const facts = await collectFacts(conversationId!, replies);
    // If the agent never actually answered, the scenario proved nothing. Saying "pass" here would be
    // the worst outcome: a run where the model was down would look like a clean sheet, and checks
    // that only look for the ABSENCE of bad behaviour would all pass vacuously.
    if (facts.answerTypes.length > 0 && facts.answerTypes.every((t) => t === "error")) {
      return { passed: false, notes: "inconclusive: the agent errored on every turn, so nothing was exercised", conversationId };
    }
    const failure = s.check(facts);
    const trail = `types=[${facts.answerTypes.join(",")}] tools=[${[...new Set(facts.toolsUsed)].join(",")}] retrievals=${facts.retrievals} tickets=${facts.tickets} escalations=${facts.escalations} guardTrips=${facts.guardTrips}`;
    return { passed: failure === null, notes: failure ? `${failure}. ${trail}` : trail, conversationId };
  } catch (err) {
    return { passed: false, notes: `harness error: ${err instanceof Error ? err.message : String(err)}`, conversationId };
  }
}

const results: Array<{ s: Scenario; passed: boolean; notes: string; conversationId: string | null; actual: string }> = [];

for (const s of SCENARIOS) {
  process.stdout.write(`${s.prdScenario} ... `);
  const r = await runScenario(s);
  // The spoken reply is kept as the "actual behaviour" the PRD asks for; the verdict comes from records.
  const actual = r.conversationId
    ? (await db.from("conversation_turns").select("assistant_response").eq("conversation_id", r.conversationId).order("created_at"))
        .data?.map((t) => t.assistant_response as string).filter(Boolean).join(" | ") ?? ""
    : "";
  results.push({ s, ...r, actual: actual.slice(0, 1500) });
  console.log(r.passed ? "PASS" : `FAIL - ${r.notes}`);
}

const rows = results.map((r) => ({
  run_id: runId,
  scenario: `${r.s.prdScenario} [${r.s.id}]`,
  expected: r.s.expected,
  actual: r.actual || "(no reply recorded)",
  passed: r.passed,
  notes: r.notes,
  conversation_id: r.conversationId,
}));
// Scenario 9 of the PRD is a live spoken call; it cannot run here, and recording it as passed
// without evidence would be exactly the self-report this harness exists to avoid.
rows.push({
  run_id: runId,
  scenario: "PRD 9. Voice flow [manual]",
  expected: "A spoken question reaches the agent through Vapi and is answered aloud, with the conversation and tool calls logged.",
  actual: "Run by hand on a real call; see the Vapi call log and the matching voice conversation in Supabase.",
  passed: false,
  notes: "Not run by this harness. Mark it from the manual call rather than letting the harness claim it.",
  conversation_id: null,
});

const { error } = await db.from("evaluations").insert(rows);
if (error) throw new Error(`could not write evaluations: ${error.message}`);

// The submitted evidence table, written from the same rows that went to the database, so the
// document and the records cannot disagree. Hand-transcribing this is how a table ends up
// claiming a pass the run never produced.
const cell = (s: string) => s.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const evidence = [
  "# Testing evidence",
  "",
  `Run \`${runId}\`, ${new Date().toISOString()}.`,
  "",
  `${results.filter((r) => r.passed).length} of ${results.length} automated scenarios passed.`,
  "Every verdict is read from saved records — the tools that ran, the rows that exist, the answer",
  "type the server derived — never from the agent's account of its own work.",
  "",
  "| Scenario | Expected behaviour | Actual behaviour | Result | Notes |",
  "| --- | --- | --- | --- | --- |",
  ...rows.map(
    (r) =>
      `| ${cell(r.scenario)} | ${cell(r.expected)} | ${clip(cell(r.actual), 300)} | ${r.passed ? "Pass" : "Fail"} | ${clip(cell(r.notes), 200)} |`,
  ),
  "",
  "## Conversations",
  "",
  "Each row above is backed by a conversation in Supabase; its turns, tool calls, retrievals,",
  "tickets and escalations can be read back by id.",
  "",
  ...rows.filter((r) => r.conversation_id).map((r) => `- ${cell(r.scenario)}: \`${r.conversation_id}\``),
  "",
].join("\n");

const evidencePath = fileURLToPath(new URL("../../evaluation-evidence.md", import.meta.url));
writeFileSync(evidencePath, evidence, "utf8");

const passed = results.filter((r) => r.passed).length;
console.log(`\nrun ${runId}`);
console.log(`${passed}/${results.length} automated scenarios passed; ${rows.length} evaluation rows written.`);
console.log(`evidence table: ${evidencePath}`);
if (passed !== results.length) process.exitCode = 1;
