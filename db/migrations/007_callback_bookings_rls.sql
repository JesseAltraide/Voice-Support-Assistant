-- Migration 005 created callback_bookings without enabling row level security, which every
-- other table in this schema has. With RLS off, the table is reachable by the anon key that the
-- caller's own browser holds: a caller's conversation id and the time support agreed to ring
-- them would be readable, and writable, by anyone who opened the page.
--
-- RLS on with no policies is the convention here, and it means exactly one thing: only the
-- service role, which lives on the server, reaches this table at all.
alter table callback_bookings enable row level security;

comment on table callback_bookings is
  'Callback times genuinely reserved. The record that makes "a callback is scheduled" a fact the agent may state. Service-role only: RLS is on with no policies.';
