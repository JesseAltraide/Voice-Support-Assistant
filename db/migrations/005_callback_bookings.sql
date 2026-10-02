-- Callback slots the caller actually booked, agreed aloud during the call.
--
-- Until now nothing in this system could reserve a human being's time, which is why
-- `escalations.call_booked` was documented as never true and the speech guard refused to let the
-- agent say a callback was scheduled: it would have been a promise with nothing behind it.
--
-- This table is what makes the claim true. A booking exists or it does not, and the agent may
-- only say a time is arranged when the row is there — the same rule that already governs
-- tickets and escalations.
create table if not exists callback_bookings (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  escalation_id   uuid references escalations(id) on delete cascade,
  -- The instant itself, stored in UTC. The caller's own zone is kept alongside it so the time
  -- can be read back in the words they used rather than in support's working hours.
  slot_start      timestamptz not null,
  slot_end        timestamptz not null,
  caller_timezone text,
  status          text not null default 'booked' check (status in ('booked','cancelled','completed')),
  created_at      timestamptz not null default now(),
  check (slot_end > slot_start)
);

-- One conversation books one callback. A caller who asks again is rearranging, not queueing.
create unique index if not exists callback_one_per_conversation
  on callback_bookings (conversation_id) where status = 'booked';

-- Capacity is counted per slot, so this is the index that decides whether a time is free.
create index if not exists callback_slot_idx
  on callback_bookings (slot_start) where status = 'booked';

comment on table callback_bookings is
  'Callback times genuinely reserved. The record that makes "a callback is scheduled" a fact the agent may state.';
