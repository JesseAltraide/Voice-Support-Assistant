import { query } from "@anthropic-ai/claude-agent-sdk";

const MODEL = process.env.SPIKE_MODEL || "claude-haiku-4-5-20251001";
const SYSTEM = "You are a phone support agent. Reply with exactly one short sentence: 'Thanks for calling RelayPay, how can I help?'";
const N = 4;

const base = {
  model: MODEL,
  systemPrompt: SYSTEM,
  tools: [],
  settingSources: [],
  persistSession: false,
};

const ms = (t) => Math.round(performance.now() - t);

// Mode A: a brand-new query() (new runtime process) every turn.
async function perTurn(i) {
  const t0 = performance.now();
  let first = null;
  let text = "";
  for await (const m of query({ prompt: `Hello, turn ${i}`, options: { ...base, maxTurns: 1 } })) {
    if (m.type === "assistant" && first === null) first = ms(t0);
    if (m.type === "result") text = m.result;
  }
  return { first, total: ms(t0), text };
}

// Mode B: one long-lived session fed by an async input stream.
async function longLived() {
  const queue = [];
  let wake = null;
  const push = (s) => { queue.push(s); wake?.(); };
  async function* input() {
    while (true) {
      while (!queue.length) await new Promise((r) => (wake = r));
      yield { type: "user", message: { role: "user", content: queue.shift() }, parent_tool_use_id: null };
    }
  }
  const q = query({ prompt: input(), options: base });
  const it = q[Symbol.asyncIterator]();
  const results = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    let first = null;
    push(`Hello, turn ${i}`);
    for (;;) {
      const { value: m, done } = await it.next();
      if (done) break;
      if (m.type === "assistant" && first === null) first = ms(t0);
      if (m.type === "result") { results.push({ first, total: ms(t0), text: m.result }); break; }
    }
  }
  return results;
}

console.log(`model=${MODEL}`);
console.log("--- new query() per turn ---");
for (let i = 0; i < N; i++) console.log(i, await perTurn(i));
console.log("--- one long-lived session ---");
(await longLived()).forEach((r, i) => console.log(i, r));
process.exit(0);
