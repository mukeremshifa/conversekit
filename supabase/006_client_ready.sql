-- ================================================================
-- ConverseKit — client-ready pass
-- Run in the Supabase SQL Editor after 005_rag.sql
--
-- Two things that blocked onboarding anyone who is not a dental clinic
-- on a single-hostname site:
--   * one allowed origin, exact match  → www vs apex vs staging
--   * hardcoded, dental-specific chips → wrong for every other vertical
--
-- Additive, backward compatible, and safe to re-run: the Worker keeps
-- reading the legacy `allowed_origin` column until this lands.
-- ================================================================

-- ----------------------------------------------------------------
-- allowed_origins — a list, not a string
--
-- `https://acme.com` and `https://www.acme.com` are different origins
-- to a browser, and almost every client also has a staging host.
-- ----------------------------------------------------------------
alter table bots add column if not exists allowed_origins text[];

update bots
   set allowed_origins = array[allowed_origin]
 where (allowed_origins is null or allowed_origins = '{}')
   and allowed_origin is not null;

alter table bots alter column allowed_origins set default '{}';
alter table bots alter column allowed_origins set not null;

-- The legacy column stays readable so an older Worker keeps working
-- during the deploy, but it is no longer required on insert.
alter table bots alter column allowed_origin drop not null;

comment on column bots.allowed_origin is
  'DEPRECATED — superseded by allowed_origins[]. Read only as a fallback.';

-- NOTE: there is deliberately no CHECK constraint rejecting trailing
-- slashes here. Postgres does not permit a subquery in a CHECK, so the
-- unnest() form is invalid — an earlier version of this file used it
-- and aborted the script partway through. Origin shape is validated in
-- src/origin.ts before anything is written, which also produces a far
-- better error message than a constraint violation would.

-- ----------------------------------------------------------------
-- suggestions — the starter chips shown in the widget
--
-- NULL means "use the widget's neutral defaults". The previous
-- hardcoded set asked every visitor on every bot, whatever the
-- business, whether it accepted dental insurance.
-- ----------------------------------------------------------------
alter table bots add column if not exists suggestions text[];

comment on column bots.suggestions is
  'Starter chips for the widget. NULL falls back to vertical-neutral defaults.';
