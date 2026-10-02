-- Verification used to be binary: the typed email either matched a customer or it didn't. The
-- owner asked for a third state: exactly one of email/name/company agreeing with an account,
-- company never given, is worth asking the caller to confirm rather than writing off as a guest
-- outright. 'unconfirmed' records that state; the agent asks for the company and the ordinary
-- two-identifier lookup_customer tool takes it from there.
alter table conversations add column if not exists caller_verify_state text
  check (caller_verify_state in ('verified', 'unconfirmed', 'guest'));

comment on column conversations.caller_verify_state is
  'Set once, from the pre-call form, by matching email/name/company against the customer list in code. Null on a phone call with no form.';
