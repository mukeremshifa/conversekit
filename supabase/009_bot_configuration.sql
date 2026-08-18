-- ================================================================
-- ConverseKit — Bot Configuration
-- Run in the Supabase SQL Editor after 008_files.sql
--
-- Additive, backward compatible, and safe to re-run. Every field in
-- both columns is optional, and NULL means "the behaviour that shipped
-- before this migration" — so a Worker or a widget that predates it
-- keeps working unchanged.
--
-- TWO JSONB COLUMNS RATHER THAN TEN SCALAR ONES, and the reason is the
-- same one behind provider_config / embedding_config / rag_config: the
-- set of settings is still moving. Ten columns now means one migration
-- per setting later, and the notifications work already has another
-- half-dozen fields queued behind it.
--
-- The trade-off is that Postgres cannot validate the shape. That is
-- accepted because it never could have validated the interesting parts
-- anyway — an origin without a trailing slash, a colour that contrasts,
-- a delay a human will tolerate — and src/config.ts is where those
-- checks already live for the columns added in 006.
-- ================================================================

-- ----------------------------------------------------------------
-- widget_config — how the widget looks and greets
--
-- Shape, all keys optional:
--   { "position": "bottom-right" | "bottom-left",
--     "theme": "light" | "dark" | "auto",
--     "logo_key": "logos/{org}/{bot}/{hash}.png",
--     "greeting": "Hi! How can I help?",
--     "greeting_delay_ms": 0,
--     "show_typing": true,
--     "show_citations": false }
--
-- logo_key is written by the upload route, never by the settings form:
-- it points at an R2 object, and a tenant who could set it by hand
-- could point it at another tenant's object.
-- ----------------------------------------------------------------
alter table bots add column if not exists widget_config jsonb;

comment on column bots.widget_config is
  'Widget appearance and greeting. NULL = the defaults hardcoded in widget.js.';

-- ----------------------------------------------------------------
-- behavior_config — when the bot should stop trying and hand over
--
-- Shape, all keys optional:
--   { "max_messages": 0,
--     "fallback_message": "I could not find that. Call us on …",
--     "escalate_after_misses": 0 }
--
-- 0 means "off" for both counters, which is what an absent column
-- decays to — so this migration changes no bot's behaviour on its own.
-- ----------------------------------------------------------------
alter table bots add column if not exists behavior_config jsonb;

comment on column bots.behavior_config is
  'Escalation and fallback thresholds. NULL or 0 = disabled, the pre-009 behaviour.';

-- ----------------------------------------------------------------
-- conversations.retrieval_miss — did this reply have anything to go on?
--
-- The escalation rule needs to know how many questions in a row the bot
-- could not answer, and "could not answer" has to be a fact rather than
-- a guess. There is no confidence score from the model, and matching
-- phrases like "I don't know" is worse than useless here: the system
-- prompt tells the bot to reply in the visitor's language, so an
-- English regex scores zero on every Turkish conversation.
--
-- What IS deterministic is retrieval. The bot has documents indexed and
-- nothing cleared the similarity threshold — that is language-
-- independent, already computed on every turn, and was previously
-- thrown away. This column keeps it.
--
-- NULL, not false, for every row written before this and for every bot
-- with escalation switched off: "not recorded" and "had context" are
-- different facts, and only true is ever counted.
-- ----------------------------------------------------------------
alter table conversations add column if not exists retrieval_miss boolean;

comment on column conversations.retrieval_miss is
  'Assistant rows only: true when the bot had a corpus and retrieval retrieved nothing. NULL = not recorded.';

-- No index here on purpose. Counting misses reads the tail of ONE
-- session's rows, and idx_conversations_bot_session from 001 —
-- (bot_id, session_id, created_at) — already serves exactly that. A
-- partial index on retrieval_miss would add write cost to every chat
-- turn to speed up a query that is already an index scan over a few
-- dozen rows.
