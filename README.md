# RelayPay voice support agent

A production-shaped voice agent that answers customer support calls for RelayPay, a
fictional B2B cross-border payments company. A caller phones in or opens the web page,
speaks to the assistant, and the assistant answers from approved knowledge, looks up their
records, and raises a ticket or an escalation when it cannot resolve the matter itself.

Built on the Claude Agent SDK, with every piece of account data and every write reached
through an MCP server rather than the model's own memory.

---

## The idea it is built around

Three decisions shape most of the code.

**The tool layer decides what is safe to say.** The model does not get raw records and
choose what to repeat. Tools return a narrow, already-vetted shape, so a figure the
assistant has no business saying is not in the context to be said.

**Claims are derived from records, not from the model's self-report.** Whether a ticket was
raised, whether a call was escalated, how a conversation ended — all of it is read back out
of the database. The model saying "I've logged that for you" proves nothing; a row does.

**Silence is never an outcome.** Every path that can fail has a line the caller hears. If
the knowledge base is unreachable, the agent says so honestly and raises a ticket rather
than inventing an answer or going quiet.

A speech guard sits in front of every reply as the last line of defence. It is not a
denylist of bad phrases — that was tried and failed badly. It enforces two structural rules
instead: a figure may only be spoken in the phrasing it was retrieved in, and a claim about
work done is only speakable if the record exists.

---

## Architecture

```
caller ──► Vapi ──► agent server ──► Claude Agent SDK
                         │                  │
                         │                  └──► MCP server ──► Supabase
                         └──► speech guard ──► reply
```

| Piece | Where | What it does |
|---|---|---|
| Agent server | `src/agent/` | Holds one long-lived session per call, runs the turn loop, applies the guard |
| MCP server | `src/mcp/` | Seven tools over Supabase; the only path to customer data |
| Speech guard | `src/agent/guard.ts` | Vets every reply before it is spoken |
| Voice page | `public/` | Browser caller UI, Vapi Web SDK |
| Eval harness | `src/eval/` | 14 scenarios judged on database facts, not transcripts |
| Schema | `db/schema.sql` | 12 tables, RLS on all of them with no policies — service role only |

**MCP tools**: `lookup_customer`, `lookup_transaction`, `lookup_payout`, `search_knowledge`,
`create_support_ticket`, `create_escalation`, `log_conversation_event`.

The agent server and the MCP server are separate processes that can be deployed separately.
`src/start.ts` runs both in one process, which is how it is deployed today — a single Render
web service, because private services there are a paid feature.

---

## Running it locally

Requires **Node 22+** and a Supabase project.

```bash
npm install
cp .env.example .env     # then fill it in
```

Create the schema by running `db/schema.sql` against your Supabase project, then everything
in `db/migrations/` in filename order.

Seed the data. `BRIEF_DIR` must point at the unpacked brief directory — the one containing
`assets/relaypay-knowledge-base.md`. Those files are deliberately not copied into this repo:

```bash
npm run seed
```

Run both servers in one process:

```bash
npm start
```

Or separately, which is closer to the deployed shape of a paid setup:

```bash
npm run start:mcp     # port 3001
npm run start:agent   # port 3002
```

Open <http://localhost:3002> for the voice page, or talk to it as text. The reply carries a
`conversation_id`; send it back as `conversation_id` to continue the same conversation, or
omit it to start a new one:

```bash
curl -s localhost:3002/chat -H "Authorization: Bearer $AGENT_AUTH_TOKEN" -H 'content-type: application/json' -d '{"message":"my payout has not arrived"}'
```

### Environment

Every variable is documented in `.env.example`. The ones that bite:

- `AGENT_AUTH_TOKEN` — bearer secret shared with Vapi. Set it on **both** the assistant's
  custom-LLM config and its server URL. Setting it on only one produces a 401 on every turn.
- `MCP_AUTH_TOKEN` — shared secret so only the agent server can reach the MCP server.
- `VAPI_PUBLIC_KEY` / `VAPI_ASSISTANT_ID` — served to the browser by `GET /config`. Public
  by design. `VAPI_PRIVATE_KEY` is account-scoped and never reaches the page.
- `BRIEF_DIR` — local seeding only.

### Vapi assistant settings

- Model → **Custom LLM** → `<agent-url>/vapi/chat/completions`, bearer `AGENT_AUTH_TOKEN`
- Server URL → `<agent-url>/vapi/server`, same bearer
- `endCallPhrases` → exactly `["goodbye for now"]`, which is how the server ends a call

---

## Testing

```bash
npm test          # unit and integration tests
npm run typecheck
npm run eval      # 14 scenarios end to end, judged on database rows
```

The eval harness asserts on facts in the database — was a ticket actually written, was the
conversation actually escalated — rather than on what the transcript says happened. It
refuses to score a run where every turn errored, so an outage cannot read as a pass.

Point it at a deployment with `EVAL_BASE_URL=https://... npm run eval`.

The call state machine in `public/call-state.js` is pure and separately tested
(`src/web/call-state.test.ts`). It was extracted after a review found two defects that no
test could have caught while the logic was inline in the page.

---

## Deploying

One Render web service, build `npm install`, start `npm start`. Set every variable from
`.env.example` except `BRIEF_DIR`, and set `MCP_SERVER_URL` to `http://127.0.0.1:3001/mcp`,
which is where the co-hosted MCP server binds.

Render provides `PORT`; the agent server takes it and binds `0.0.0.0`.

---

## Known limitations

- **Latency.** 3–10s per turn on Render's free tier. The page reports the wait as "Thinking"
  rather than hiding it, but it is real and audible on a call.
- **Transcription.** Deepgram Nova-3 mishears more than it should on accented speech; Soniox
  measures meaningfully better and is a dashboard change.
- **No per-caller rate limit.** `GET /config` is unauthenticated, so anyone with the URL can
  start calls against the assistant. Bound it in the Vapi dashboard with an origin allow-list
  and a call-duration cap.
- **An echo can end a call.** Speech-to-text sometimes returns the assistant's own voice. The
  closing detector treats a farewell as the caller signing off, so if the assistant says
  something like "have a good day" mid-call and that comes back as caller speech, the call
  ends. Known and unfixed: the detector does not yet compare an utterance against the line
  just spoken.
- **Handoff email needs SMTP configured.** Without `SMTP_USER`, `SMTP_APP_PASSWORD` and a valid
  `SUPPORT_INBOX_EMAIL`, briefs are written and queued but never delivered. The dispatcher
  fails closed and leaves them `pending`, so they go out once it is configured.
- **In-process locking only.** One agent instance is assumed; two would need shared locking.
- **No turn idempotency.** A retried turn is a new turn.

---

## Layout

```
src/agent/     turn orchestration, speech guard, Vapi protocol, session store
src/mcp/       MCP server and its seven tools
src/eval/      scenario definitions and runner
src/shared/    Supabase client, retry helpers
src/web/       tests for the browser state machine
public/        voice page and its state machine
db/            schema, migrations, seeding
```
