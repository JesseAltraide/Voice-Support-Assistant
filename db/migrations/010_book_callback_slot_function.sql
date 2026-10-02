-- Capacity was checked, then written, in two separate round trips: count the bookings at a
-- slot, then insert if under capacity. Two callers claiming the last seat at the same instant
-- could both pass the count before either write landed, and both succeed. This function makes
-- the whole decision one atomic step.
--
-- pg_advisory_xact_lock, keyed on the slot being claimed, serialises every caller targeting that
-- exact instant: the second one waits for the first to finish before its own count runs, so the
-- count can never be stale by the time it is acted on. Two callers targeting different slots use
-- different lock keys and never block each other. The lock releases automatically when the
-- transaction ends, win or lose.
create or replace function book_callback_slot(
  p_conversation_id uuid,
  p_escalation_id uuid,
  p_slot_start timestamptz,
  p_slot_end timestamptz,
  p_caller_timezone text,
  p_capacity int
) returns table (booked boolean, booking_id uuid, moved boolean)
language plpgsql
as $$
declare
  v_existing uuid;
  v_count int;
begin
  perform pg_advisory_xact_lock(hashtext(p_slot_start::text));

  select id into v_existing from callback_bookings
    where conversation_id = p_conversation_id and status = 'booked';

  -- Capacity at the slot being moved INTO, excluding the caller's own existing booking so
  -- rearranging a time never counts as taking two seats.
  select count(*) into v_count from callback_bookings
    where slot_start = p_slot_start and status = 'booked'
      and (v_existing is null or id <> v_existing);

  if v_count >= p_capacity then
    return query select false, null::uuid, (v_existing is not null);
    return;
  end if;

  if v_existing is not null then
    -- escalation_id is included here too: a caller can book a callback before any escalation
    -- exists, then log a case and reschedule, and the moved row must pick up that link rather
    -- than keep the null it started with.
    update callback_bookings
      set slot_start = p_slot_start, slot_end = p_slot_end, caller_timezone = p_caller_timezone,
          escalation_id = coalesce(p_escalation_id, escalation_id)
      where id = v_existing;
    return query select true, v_existing, true;
    return;
  end if;

  insert into callback_bookings (conversation_id, escalation_id, slot_start, slot_end, caller_timezone, status)
  values (p_conversation_id, p_escalation_id, p_slot_start, p_slot_end, p_caller_timezone, 'booked')
  returning id into v_existing;

  return query select true, v_existing, false;
end;
$$;

comment on function book_callback_slot is
  'Atomic check-and-write for a callback booking. The advisory lock is what removes the race the previous check-then-insert code had.';
