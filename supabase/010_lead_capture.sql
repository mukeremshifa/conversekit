-- ================================================================
-- ConverseKit — Lead Capture
-- Run in the Supabase SQL Editor after 009_bot_configuration.sql
--
-- Additive, backward compatible, and safe to re-run. Every column is
-- nullable and NULL means "the behaviour that shipped before this
-- migration" — a Worker that predates it keeps working unchanged, and
-- so does a bot whose tenant never opens the new settings section.
--
-- A THIRD JSONB COLUMN rather than folding these keys into
-- behavior_config, for the reason 009 gave for splitting widget_config
-- from behavior_config in the first place: behavior_config answers
-- "when should the bot stop trying and hand over", and lead capture is
-- a different question with its own ten settings. One of those settings
-- is also a credential (see webhook_url below), which behavior_config
-- has no handling for.
--
-- The scalar columns on `leads` are scalar and not jsonb for the
-- opposite reason: unlike a settings blob, these are read by the
-- dashboard table, the CSV export, and eventually a filter. A jsonb
-- `extra` column would make every one of those reach into a document
-- for a value that is always present and always a string.
-- ================================================================

-- ----------------------------------------------------------------
-- bots.lead_config — whether to capture, what to ask, who to tell
--
-- Shape, all keys optional:
--   { "enabled": true,
--     "trigger": "intent" | "always" | "after_messages",
--     "trigger_after_messages": 6,
--     "fields": { "phone": "optional", "company": "off",
--                 "inquiry": "optional" },
--     "consent_text":    "I'll just note down your details — okay?",
--     "success_message": "Thanks! I've passed these to the team.",
--     "booking_url":     "https://cal.com/acme",
--     "tag":             "Website chat",
--     "webhook_url":     "https://hooks.slack.com/services/…",
--     "webhook_format":  "json" | "slack" | "teams" }
--
-- name and email are deliberately NOT in `fields`. They are the pair
-- src/leads.ts requires before it will save anything, and that check is
-- the only thing standing between the model and a table of half-filled
-- rows. Making them configurable means making that guard configurable.
--
-- webhook_url is a WRITE-ONLY field. A Slack incoming-webhook URL is a
-- bearer credential — anyone holding it can post into that channel — so
-- it is stripped from every admin read the same way provider_config's
-- apiKey is, and carried forward server-side on save. See
-- redactBotSecrets and mergeConfigs.
-- ----------------------------------------------------------------
alter table bots add column if not exists lead_config jsonb;

comment on column bots.lead_config is
  'Lead capture settings. NULL = the hardcoded prompt block that shipped before 010. webhook_url is write-only and never returned by the admin API.';

-- ----------------------------------------------------------------
-- leads.tag — which capture this lead came from
--
-- Written by the Worker from lead_config.tag, never by the model: a
-- model-supplied tag is a free-text field the tenant cannot rely on for
-- filtering, which defeats the point of having one.
-- ----------------------------------------------------------------
alter table leads add column if not exists tag text;

comment on column leads.tag is
  'Server-applied label from bots.lead_config.tag at capture time. NULL = untagged.';

-- ----------------------------------------------------------------
-- leads.company — the one field beyond the original four
--
-- A real column rather than a jsonb bag, because it is exported to CSV
-- and shown in a table like every other lead field. Off by default:
-- absent from the marker schema unless a tenant turns it on.
-- ----------------------------------------------------------------
alter table leads add column if not exists company text;

-- ----------------------------------------------------------------
-- leads.consent_given — what this column does and does not mean
--
-- true records that THE BOT WAS CONFIGURED TO ASK FOR CONSENT at the
-- moment this lead was captured. It is not evidence that a visitor
-- ticked a box, because there is no box: widget.js is a streaming chat
-- surface with no structured-input primitive, and the consent is spoken
-- into the conversation instead.
--
-- Written only when lead_config.consent_text is set. NULL otherwise, so
-- "this bot never asked" stays distinguishable from a false that would
-- imply someone was asked and declined.
--
-- Spelled out here rather than in a commit message because in two years
-- somebody will find this column while answering a compliance question,
-- and the honest answer needs to be attached to the column itself.
-- ----------------------------------------------------------------
alter table leads add column if not exists consent_given boolean;

comment on column leads.consent_given is
  'true = the bot was instructed to ask for consent at capture time. NOT proof a visitor accepted — there is no checkbox. NULL = not asked.';

-- No new index. The dashboard reads one bot''s leads newest-first, which
-- idx_leads_bot_id (bot_id, created_at DESC) from 002 already serves,
-- and tag is filtered client-side over at most 100 rows. An index on a
-- column with a handful of distinct values would cost every insert and
-- save nothing.

-- No RLS change either. The leads_select policy and the table-level
-- `grant select on leads to authenticated` from 003 cover columns as
-- they are added — a grant on a table is not a grant on a column list.
