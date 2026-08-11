-- ================================================================
-- ConverseKit — per-tenant AI vendor selection
-- Run in the Supabase SQL Editor after 003_tenancy.sql
--
-- src/providers/ already reads these columns (see the Bot type in
-- src/types.ts). Until they exist, resolveChatProvider silently falls
-- back to the Worker's env defaults for every tenant.
--
-- Shape, all keys optional:
--   { "vendor": "groq", "model": "llama-3.3-70b-versatile",
--     "apiKey": "gsk_…", "baseUrl": "…",
--     "maxTokens": 1024, "temperature": 0.7 }
--
-- embedding_config additionally accepts "dimensions".
-- ================================================================

alter table bots
  add column if not exists provider_config  jsonb,
  add column if not exists embedding_config jsonb;

-- A tenant-supplied apiKey lives in these columns, so they must never
-- be exposed to the browser. The Worker's admin routes are the only
-- reader; the widget's public /health endpoint returns a fixed field
-- list and does not include them.
comment on column bots.provider_config is
  'Per-tenant chat vendor override. May contain a BYOK apiKey — never return to a browser.';
comment on column bots.embedding_config is
  'Per-tenant embedding vendor override. May contain a BYOK apiKey — never return to a browser.';
