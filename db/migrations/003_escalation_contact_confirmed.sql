-- When the caller confirmed the name and email that will reach the support team.
--
-- Speech-to-text mishears names and email addresses constantly, and an escalation delivered to
-- a misheard address reaches nobody. The caller is shown what was captured at the end of the
-- call and can correct it; this records that they did.
--
-- Null means not yet confirmed, which holds delivery rather than cancelling it. A caller on a
-- phone never sees the form and a caller on the web can close the tab, so the dispatcher
-- releases an unconfirmed escalation once a grace period has passed and sends it with the
-- details captured by voice. Losing a handoff because nobody pressed a button would be worse
-- than sending one with a misspelt name.
alter table escalations add column if not exists contact_confirmed_at timestamptz;

comment on column escalations.contact_confirmed_at is
  'When the caller confirmed their name and email. Null holds delivery until the grace period expires.';
