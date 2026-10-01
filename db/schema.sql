-- RelayPay voice support agent: schema. Run once in the Supabase SQL editor.
-- Safe to re-run: every statement is idempotent.
-- Rules baked in (week6-full-flow.md "Supabase"): invariants live in the schema,
-- RLS is on for every table with NO policies (only the service role reads/writes),
-- rows are identified by id and ordered by created_at, never by a sequence number.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- seed tables
create table if not exists customers (
  customer_id     text primary key,
  company_name    text not null unique,
  contact_name    text not null,
  contact_email   text not null,
  plan            text not null,
  account_status  text not null,
  region          text not null,
  kyc_status      text not null,
  support_notes   text
);

create table if not exists transactions (
  transaction_id      text primary key,
  customer_id         text not null references customers(customer_id),
  transaction_type    text not null,
  amount              numeric not null,
  currency            text not null,
  destination_country text,
  status              text not null,
  created_at          date,
  estimated_arrival   date,            -- blank in the seed for two rows: NULL is normal
  support_summary     text
);

create table if not exists payouts (
  payout_id       text primary key,
  transaction_id  text references transactions(transaction_id),
  customer_id     text not null references customers(customer_id),
  recipient_name  text,
  amount          numeric not null,
  currency        text not null,
  status          text not null,
  scheduled_for   date,
  failure_reason  text                 -- blank in the seed for PAY-7001: NULL is normal
);

-- ------------------------------------------------------------ runtime tables
create table if not exists conversations (
  id                  uuid primary key default gen_random_uuid(),
  channel             text not null default 'voice' check (channel in ('voice','text')),
  caller_identifier   text,
  vapi_call_id        text unique,
  is_test             boolean not null default false,
  status              text not null default 'active' check (status in
                        ('active','collecting_details','resolved','escalated',
                         'ticket_created','declined','abandoned','error')),
  linked_customer_id  text references customers(customer_id),
  unresolved_count    integer not null default 0,
  handoff_offers_made integer not null default 0,
  failed_lookup_count integer not null default 0,
  clarify_streak      integer not null default 0,
  turn_count          integer not null default 0,
  summary             text,
  started_at          timestamptz not null default now(),
  last_activity_at    timestamptz not null default now(),
  ended_at            timestamptz
);
create index if not exists conversations_open_idx on conversations (last_activity_at)
  where ended_at is null;

create table if not exists conversation_turns (
  id                 uuid primary key default gen_random_uuid(),
  conversation_id    uuid not null references conversations(id) on delete cascade,
  user_transcript    text not null,
  assistant_response text,
  answer_type        text check (answer_type in
                       ('answer_directly','clarify','escalate','decline','conversational','off_topic','error','unintelligible')),
  uncertainty_note   text,
  speech_guard_tripped boolean not null default false,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz
);
create index if not exists turns_conv_idx on conversation_turns (conversation_id, created_at);

create table if not exists knowledge_chunks (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,          -- stable across re-ingests
  title       text not null,
  section     text not null,
  content     text not null,
  summary     text not null,
  tsv         tsvector generated always as
                (setweight(to_tsvector('english', title), 'A') ||
                 to_tsvector('english', content)) stored,
  created_at  timestamptz not null default now()
);
create index if not exists knowledge_chunks_tsv_idx on knowledge_chunks using gin (tsv);

create table if not exists retrieval_logs (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid references conversations(id) on delete cascade,
  turn_id          uuid references conversation_turns(id) on delete set null,
  query            text not null,
  chunk_slugs      text[] not null default '{}',
  source_titles    text[] not null default '{}',
  source_summaries text[] not null default '{}',
  scores           real[]  not null default '{}',
  result_count     integer not null default 0,   -- 0 is logged too: evidence behind a decline
  created_at       timestamptz not null default now()
);

create table if not exists tool_calls (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade,
  turn_id         uuid references conversation_turns(id) on delete set null,
  tool_name       text not null,
  purpose         text,
  input_summary   text,
  result_summary  text,
  status          text not null check (status in ('ok','error')),
  error_message   text,
  duration_ms     integer,
  created_at      timestamptz not null default now()
);
create index if not exists tool_calls_conv_idx on tool_calls (conversation_id, created_at);

create table if not exists support_tickets (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  customer_id     text references customers(customer_id),
  category        text not null check (category in
                    ('compliance','account','dispute','payment','invoice','other')),
  priority        text not null check (priority in ('low','medium','high','urgent')),
  summary         text not null,
  summary_hash    text not null,
  handoff_brief   text,
  status          text not null default 'open' check (status in ('open','in progress','closed')),
  created_at      timestamptz not null default now(),
  -- one ticket per conversation, category and summary hash
  unique (conversation_id, category, summary_hash)
);

create table if not exists escalations (
  id                       uuid primary key default gen_random_uuid(),
  conversation_id          uuid not null references conversations(id) on delete cascade,
  ticket_id                uuid references support_tickets(id),
  customer_id              text references customers(customer_id),
  user_name                text not null,
  user_email               text not null check (user_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  category                 text not null check (category in
                             ('compliance','account','dispute','payment','other')),
  reason                   text not null,
  call_booked              boolean not null default false,   -- never true: no scheduler exists
  preferred_time           text,                              -- caller's own words
  status                   text not null default 'open' check (status in ('open','in progress','closed')),
  handoff_summary          text,
  handoff_email_status     text not null default 'pending' check (handoff_email_status in
                             ('pending','sending','sent','failed','suppressed')),
  handoff_email_attempts   integer not null default 0,
  handoff_email_sent_at    timestamptz,
  handoff_email_error      text,
  handoff_email_claimed_at timestamptz,
  created_at               timestamptz not null default now()
);
-- exactly one open escalation per conversation
create unique index if not exists escalations_one_open_per_conversation
  on escalations (conversation_id) where status in ('open','in progress');
create index if not exists escalations_email_sweep_idx
  on escalations (handoff_email_status) where handoff_email_status in ('pending','failed','sending');

create table if not exists conversation_events (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  event_type      text not null check (event_type in
                    ('state_change','decision','handoff_offer','handoff_accepted','handoff_declined',
                     'email_queued','email_sent','email_failed','email_suppressed',
                     'speech_guard','failure','holding_line','fallback_apology','limit_hit','note')),
  summary         text not null,
  metadata        jsonb not null default '{}'::jsonb
                    check (pg_column_size(metadata) <= 4096),
  created_at      timestamptz not null default now()
);
create index if not exists events_conv_idx on conversation_events (conversation_id, created_at);

create table if not exists evaluations (
  id              uuid primary key default gen_random_uuid(),
  run_id          text not null,
  scenario        text not null,
  expected        text not null,
  actual          text not null,
  passed          boolean not null,
  notes           text,
  conversation_id uuid references conversations(id) on delete set null,
  created_at      timestamptz not null default now()
);

-- --------------------------------------------------------------- functions
-- Atomic counter bumps: derived from what happened, never read-modify-write in app code.
create or replace function bump_conversation_counter(p_id uuid, p_column text, p_by integer default 1)
returns integer language plpgsql set search_path = public as $$
declare v integer;
begin
  if p_column not in ('unresolved_count','handoff_offers_made','failed_lookup_count','clarify_streak','turn_count') then
    raise exception 'unsupported counter %', p_column;
  end if;
  execute format(
    'update conversations set %I = %I + $1, last_activity_at = now() where id = $2 returning %I',
    p_column, p_column, p_column) into v using p_by, p_id;
  return v;
end $$;

-- Full-text search. Caller passes an OR query, e.g. 'fee | charge | international'.
create or replace function search_knowledge_chunks(p_query text, p_limit integer default 3)
returns table (slug text, title text, section text, content text, summary text, score real)
language sql stable set search_path = public as $$
  select k.slug, k.title, k.section, k.content, k.summary,
         ts_rank(k.tsv, to_tsquery('english', p_query)) as score
  from knowledge_chunks k
  where k.tsv @@ to_tsquery('english', p_query)
  order by score desc, k.slug
  limit least(greatest(p_limit, 1), 3);
$$;

-- ------------------------------------------------------------------- RLS
-- On for every table, and deliberately NO policies: the anon/authenticated roles
-- get nothing. Only the server, with the service role key, can read or write.
alter table customers            enable row level security;
alter table transactions         enable row level security;
alter table payouts              enable row level security;
alter table conversations        enable row level security;
alter table conversation_turns   enable row level security;
alter table knowledge_chunks     enable row level security;
alter table retrieval_logs       enable row level security;
alter table tool_calls           enable row level security;
alter table support_tickets      enable row level security;
alter table escalations          enable row level security;
alter table conversation_events  enable row level security;
alter table evaluations          enable row level security;

-- Belt and braces: RLS already blocks these roles, but also remove their table privileges so
-- a future table that forgets to enable RLS is still closed to them.
revoke all on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;

revoke execute on function bump_conversation_counter(uuid, text, integer) from public, anon, authenticated;
revoke execute on function search_knowledge_chunks(text, integer) from public, anon, authenticated;
