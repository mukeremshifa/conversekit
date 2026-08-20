-- ================================================================
-- ConverseKit — bots.profile, the structured business facts tier
-- Run in the Supabase SQL Editor after 014_single_bot.sql
--
-- WHY. `bots` carried three generations of the same business facts:
-- 001/002 gave it hours/location/contact/services/faq, 002 Phase 1
-- added address/contact_email/contact_phone/business_description on top
-- of them, and 011 moved services and FAQ into the corpus behind a
-- flag. src/prompt.ts reconciled the survivors at render time
-- (`bot.address ?? bot.location`) and branched the whole Services/FAQ
-- block on a migration flag. Every new business field made that worse.
--
-- One jsonb column replaces the lot, with a shape the Worker validates
-- (src/config.ts, validateProfile) because Postgres cannot. That is the
-- same division of labour widget_config, behavior_config and
-- lead_config already use, and this column follows their rules exactly:
-- every field optional, an empty object stored as NULL, replaced
-- wholesale on write rather than merged.
--
-- WHAT THIS MIGRATION DOES NOT DO. It does not backfill, and it does
-- not drop a single legacy column.
--
--   * The BACKFILL IS A ROUTE, not SQL:
--     POST /v1/admin/bots/:id/profile/backfill, with ?dry_run=1.
--     "Mon-Fri 9-5, closed bank holidays" is not machine-parseable and
--     a half-right parse is worse than none, so the route is a lossless
--     pass-through into `notes` and scalar fields — and it reports its
--     plan before it acts, which SQL running inside a migration cannot.
--     Same reasoning, and the same shape, as /knowledge/migrate in 011.
--
--   * THE LEGACY COLUMNS STAY. hours, location, contact, address,
--     contact_email and contact_phone are read-through deprecated, the
--     treatment `allowed_origin` got in 006. NULL `profile` means they
--     are rendered into the prompt byte for byte as they were before
--     this migration, which is the whole safety property of the change
--     — every bot on the platform is on that path until someone
--     backfills it.
--
-- Additive and re-runnable, per the convention every migration since
-- 009 follows. Deploy this BEFORE the Worker: `selectBot` uses
-- `select=*`, and a Worker writing `profile` against a database without
-- the column fails outright, while this column under the OLD Worker
-- goes unread.
-- ================================================================

alter table bots add column if not exists profile jsonb;

comment on column bots.profile is
  'Structured business facts rendered into every system prompt. NULL means
   the legacy hours/location/contact/address columns are rendered instead,
   byte for byte as they were before 015.';
