-- Run this once in the Supabase SQL editor on a database created before this change.
-- A fresh run of db/schema.sql already includes it.
--
-- Adds the `unintelligible` answer type. Speech-to-text on a phone line regularly produces
-- something that is not speech (noise, a cough, the assistant's own voice echoing back). Those
-- turns are answered by the server with a fixed line and never reach the model, and they need
-- their own type so the evidence in `conversation_turns` says what actually happened.

alter table conversation_turns drop constraint if exists conversation_turns_answer_type_check;

alter table conversation_turns add constraint conversation_turns_answer_type_check
  check (answer_type in
    ('answer_directly','clarify','escalate','decline','conversational','off_topic','error','unintelligible'));
