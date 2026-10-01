-- The reference the caller gives so support can find the case: a transaction or payout
-- reference, an invoice number, whatever identifies what they were calling about.
--
-- It lives in its own column rather than inside `reason` because the support team acts on it.
-- A reference buried in free text has to be read out of a paragraph by a human; a column can be
-- searched, joined and shown in a queue.
--
-- Nullable on purpose. A caller who does not have a reference must still be able to escalate:
-- requiring one would turn a handoff into an interrogation, and the handoff brief already
-- carries the full transcript either way.
alter table escalations add column if not exists case_reference text;

comment on column escalations.case_reference is
  'Caller-supplied identifier for the case (transaction, payout or invoice reference). Null when the caller had none.';
