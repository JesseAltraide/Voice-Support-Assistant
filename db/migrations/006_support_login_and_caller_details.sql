-- Two unrelated things the same release needed: more of what the caller tells us up front, and
-- a way for support to sign in rather than paste a shared token.

-- Optional on purpose. A caller who skips them still gets the same call; these only save the
-- agent asking for something the caller already knows, and give support context when they ring
-- back. Nothing in the flow may ever require them.
alter table conversations add column if not exists caller_company text;
alter table conversations add column if not exists caller_city text;

comment on column conversations.caller_company is 'Optional, typed before the call. Never required, never asked for aloud.';
comment on column conversations.caller_city is 'Optional, typed before the call. Context for whoever rings back.';

-- The support dashboard was gated by the same shared bearer token the Vapi webhook uses. One
-- secret doing two jobs cannot be rotated for a person leaving without taking the phone line
-- down with it, and it says nothing about who looked at a caller's case.
create table if not exists support_users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  -- scrypt, salted per user, written by db/seed-support-user.mjs. Never a plaintext password.
  password_hash text not null,
  display_name  text,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

-- A session is a random token the server issued, stored only as a hash: a leaked copy of this
-- table must not let anyone resume a session, for the same reason passwords are not stored
-- either.
create table if not exists support_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references support_users(id) on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists support_sessions_expiry_idx on support_sessions (expires_at);

alter table support_users enable row level security;
alter table support_sessions enable row level security;

comment on table support_users is
  'People who may read the support dashboard. Service-role only: RLS is on with no policies, so the anon key reaches nothing here.';
