-- What the caller typed before the call started.
--
-- Speech-to-text mishears names and email addresses, and asking for them by voice spends the
-- opening of every escalation on spelling rather than on the problem. A web caller gives them
-- on a form instead, where they are simply correct, and the agent can use the turns it saves on
-- what is actually wrong.
--
-- All three are null for a phone caller, who has no form. The agent asks them by voice as
-- before, so neither path is broken by the other's absence.
alter table conversations add column if not exists caller_name     text;
alter table conversations add column if not exists caller_email    text;
alter table conversations add column if not exists caller_timezone text;

comment on column conversations.caller_name is
  'Name the caller typed before the call. Null on phone, where it is asked for by voice.';
comment on column conversations.caller_email is
  'Email the caller typed before the call. Null on phone.';
comment on column conversations.caller_timezone is
  'IANA zone the browser reported, e.g. Africa/Lagos. Used to read a preferred callback window back in the caller''s own time.';
