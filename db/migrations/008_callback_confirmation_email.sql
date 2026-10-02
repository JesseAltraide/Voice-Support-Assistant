-- A booked callback is a promise with a time on it, and until now the only record the caller
-- kept was whatever they remembered from the call. They are now sent a confirmation.
--
-- The outcome is stored rather than assumed. A send that failed has to be visible, because the
-- caller who never got the email is the one most likely to miss the call.
alter table callback_bookings add column if not exists confirmation_email_status text
  not null default 'pending'
  check (confirmation_email_status in ('pending', 'sent', 'failed', 'skipped'));
alter table callback_bookings add column if not exists confirmation_email_error text;
alter table callback_bookings add column if not exists confirmation_email_sent_at timestamptz;

comment on column callback_bookings.confirmation_email_status is
  'pending until a confirmation is attempted; skipped when there is no address to send to.';
