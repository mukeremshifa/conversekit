-- ================================================================
-- ConverseKit — bots
--
-- One row per tenant's chatbot, and in practice one row per
-- organization: the unique index at the bottom says so. `bots` was
-- always the tenancy row rather than a feature — nothing in the Worker
-- fans out over several, and RLS, not application code, is what keeps
-- one org out of another's data.
--
-- Collapsing bot into org would rename a column referenced by eleven
-- foreign keys, two pgvector RPCs and every RLS policy, and would break
-- the `data-bot-id` embed contract already pasted into customer sites.
-- That is a rename, not a simplification.
--
-- WHY SO MANY JSONB COLUMNS. Five of them, and they are five because
-- they answer five different questions with five different lifetimes —
-- how the widget looks, when the bot gives up, whether to capture a
-- lead, which vendor to call, how to retrieve. Ten scalar columns each
-- would be fifty migrations as the product moves. The trade-off is that
-- Postgres cannot validate the shapes; src/config.ts does, and it could
-- always validate more of them than a CHECK could anyway — an origin
-- without a trailing slash, a colour that contrasts, a delay a human
-- will tolerate.
-- ================================================================

create table if not exists bots (
  id                  uuid        primary key default gen_random_uuid(),
  org_id              uuid        not null references organizations(id) on delete cascade,
  name                text        not null,
  business_name       text        not null,
  created_at          timestamptz not null default now(),

  -- ── Where the widget may run ──────────────────────────────────
  --
  -- A list, because `https://acme.com` and `https://www.acme.com` are
  -- different origins to a browser and almost every client also has a
  -- staging host. An EMPTY list refuses every origin (src/origin.ts),
  -- which is the safe direction to fail in for a widget that answers
  -- anonymous traffic — a freshly provisioned bot is inert until its
  -- owner names their domain.
  --
  -- There is deliberately no CHECK rejecting trailing slashes. Postgres
  -- does not permit a subquery in a CHECK, so the unnest() form is
  -- invalid; src/origin.ts validates shape before anything is written
  -- and produces a far better message than a constraint violation.
  allowed_origins     text[]      not null default '{}',
  -- DEPRECATED, and still written. src/supabase.ts createBot sets it
  -- from allowed_origins[0] on every insert, and allowedOriginsFor
  -- reads it as a fallback when the list is empty. Dropping it is a
  -- code change first, not a migration.
  allowed_origin      text,

  -- ── Appearance ────────────────────────────────────────────────
  primary_color       text        not null default '#2563eb',
  -- Starter chips. NULL falls back to the widget's vertical-neutral
  -- defaults; before this existed, every bot on the platform asked
  -- every visitor whether they took dental insurance.
  suggestions         text[],

  -- ── Business facts, THREE GENERATIONS OF THEM ─────────────────
  --
  -- `profile` supersedes the six scalar columns below it. They are
  -- READ-THROUGH DEPRECATED, not dead: NULL `profile` means src/
  -- profile.ts renders these instead, byte for byte, and that is the
  -- entire safety property of the change — it let the cutover happen
  -- one tenant at a time. The backfill is a route
  -- (POST /v1/admin/bots/:id/profile/backfill, with ?dry_run=1), never
  -- SQL: "Mon-Fri 9-5, closed bank holidays" is not machine-parseable
  -- and a half-right parse is worse than none.
  --
  -- Do not drop these until src/prompt.ts, src/profile.ts and
  -- scripts/test-profile-units.mjs stop reading them.
  profile             jsonb,
  /* deprecated: superseded by profile.hours    */ hours               text,
  /* deprecated: superseded by profile.location */ location            text,
  /* deprecated: superseded by profile.contact  */ contact             text,
  /* deprecated: superseded by profile.location */ address             text,
  /* deprecated: superseded by profile.contact  */ contact_email       text,
  /* deprecated: superseded by profile.contact  */ contact_phone       text,

  -- Prose about the business rather than a fact about it, which is why
  -- it survived the move to `profile` and the six above did not.
  --
  -- Both length caps are enforced here as well as in src/config.ts,
  -- which truncates on write and is the authority. These two are the
  -- only tenant-authored text still inlined into every system prompt,
  -- and both were once unbounded `text` — a tenant who pasted 40 KB
  -- shipped 40 KB on every single message, forever, crowding out the
  -- retrieved chunks and the conversation history alike.
  business_description text       check (business_description is null or length(business_description) <= 600),
  custom_instructions  text       check (custom_instructions  is null or length(custom_instructions)  <= 2000),

  -- Moved into the corpus by the knowledge cutover below, and still
  -- rendered into the prompt for any bot that has not been through it.
  services            text,
  faq                 text,

  -- ── Settings blobs ────────────────────────────────────────────
  --
  -- Every key optional; NULL means the behaviour that shipped before
  -- the setting existed. src/config.ts owns the shapes.
  --
  --   widget_config    position, theme, logo_key, greeting,
  --                    greeting_delay_ms, show_typing, show_citations
  --   behavior_config  max_messages, fallback_message,
  --                    escalate_after_misses  (0 = off)
  --   lead_config      enabled, trigger, fields, consent_text,
  --                    success_message, booking_url, tag,
  --                    webhook_url, webhook_format
  --   provider_config  vendor, model, apiKey, baseUrl, maxTokens,
  --                    temperature
  --   embedding_config the same, plus dimensions
  --   rag_config       enabled, top_k, min_similarity, chunk_size,
  --                    chunk_overlap, router, faq_shortcut_threshold
  --
  -- TWO OF THESE HOLD CREDENTIALS. provider_config and embedding_config
  -- may carry a tenant's BYOK apiKey, and lead_config.webhook_url is a
  -- bearer credential in its own right — anyone holding a Slack
  -- incoming-webhook URL can post into that channel. All three are
  -- stripped from every admin read (redactBotSecrets) and carried
  -- forward server-side on save (mergeConfigs). They must never reach a
  -- browser, and the public /health endpoint returns a fixed field list
  -- that cannot include them.
  widget_config       jsonb,
  behavior_config     jsonb,
  lead_config         jsonb,
  provider_config     jsonb,
  embedding_config    jsonb,
  rag_config          jsonb check (rag_config is null or jsonb_typeof(rag_config) = 'object'),

  -- ── Corpus state ──────────────────────────────────────────────
  --
  -- NULL = services and faq are still inlined into the system prompt.
  -- Stamped only after a successful ingest of both into the corpus;
  -- null it to revert, leaving the now-redundant chunks sitting
  -- harmlessly in the corpus. That reversibility is the point.
  knowledge_migrated_at   timestamptz,

  -- The model the corpus was last successfully built with. NULL means
  -- UNKNOWN, WHICH RETRIEVAL TREATS AS "ALLOW".
  --
  -- Why it matters: switch a bot from bge-base-en-v1.5 to
  -- gemini-embedding-001 and both are 768-dimensional, so the width
  -- assertion in embedPieces passes and Postgres raises nothing — but
  -- the stored vectors and the query vector are now from different
  -- embedding spaces, and cosine similarity between them is noise.
  -- Permanently, silently, with no error and no status change.
  embedding_model_indexed text,

  -- Indexed chunks for this bot. Maintained by trg_chunks_count_* in
  -- 004; never written by the application. It exists so the chat path
  -- can answer "does this bot have a corpus" from a row it already
  -- holds, instead of a PostgREST round trip on every single turn.
  chunk_count             integer  not null default 0
);

comment on column bots.allowed_origin is
  'DEPRECATED — superseded by allowed_origins[]. Still written by createBot and read as a fallback.';
comment on column bots.profile is
  'Structured business facts rendered into every system prompt. NULL means the legacy hours/location/contact/address columns are rendered instead, byte for byte.';
comment on column bots.provider_config is
  'Per-tenant chat vendor override. May contain a BYOK apiKey — never return to a browser.';
comment on column bots.embedding_config is
  'Per-tenant embedding vendor override. May contain a BYOK apiKey — never return to a browser.';
comment on column bots.lead_config is
  'Lead capture settings. webhook_url is write-only and never returned by the admin API.';
comment on column bots.knowledge_migrated_at is
  'NULL = services and faq are still inlined into the system prompt. Stamped only after a successful ingest of both into the corpus. Null it to revert.';
comment on column bots.embedding_model_indexed is
  'Embedding model the corpus was last successfully built with. NULL = unknown, which retrieval treats as "allow". Stamped by both ingest paths on success only.';
comment on column bots.chunk_count is
  'Indexed chunks for this bot. Maintained by trg_chunks_count_* — never written by the application.';

-- One bot per organization. `bots` is the tenancy row; an org holding
-- two of them is a data question — which corpus is the real one —
-- rather than a state the product has an answer for. src/index.ts
-- enforces the same rule on the create path.
create unique index if not exists idx_bots_org_unique on public.bots(org_id);


-- ----------------------------------------------------------------
-- set_org_from_bot_row — the tenancy derivation
--
-- Used by documents, chunks, faq_items, retrieval_log and usage_log.
-- org_id is derived from the owning bot rather than accepted from the
-- caller, so neither the application nor a future ingestion path can
-- insert a row into the wrong tenant.
-- ----------------------------------------------------------------
create or replace function public.set_org_from_bot_row()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.org_id is null then
    select b.org_id into new.org_id from public.bots b where b.id = new.bot_id;
  end if;
  return new;
end;
$$;

revoke all on function public.set_org_from_bot_row() from public;


-- ----------------------------------------------------------------
-- Signup provisions an org, a membership and a bot
--
-- In the database rather than in Worker code, and atomically: a new
-- user has no membership, so RLS forbids them from inserting their own
-- org — chicken and egg. Doing it here means no HTTP path can ever
-- observe a signed-in user without somewhere to put their knowledge
-- base.
--
-- `nullif` around split_part because split_part returns '' rather than
-- NULL for an address with no local part, so a bare coalesce would
-- never fire and such a user got an org named ''.
-- ----------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_org uuid;
  who     text;
begin
  who := coalesce(nullif(split_part(new.email, '@', 1), ''), 'workspace');

  insert into public.organizations (name, slug)
  values (who, 'org-' || replace(new.id::text, '-', ''))
  returning id into new_org;

  insert into public.memberships (org_id, user_id, role)
  values (new_org, new.id, 'owner');

  -- allowed_origins stays at its '{}' default: the bot is inert until
  -- its owner names their domain.
  insert into public.bots (org_id, name, business_name)
  values (new_org, who, who);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ----------------------------------------------------------------
-- RLS and grants
-- ----------------------------------------------------------------
alter table bots enable row level security;

drop policy if exists bots_select on bots;
drop policy if exists bots_insert on bots;
drop policy if exists bots_update on bots;
drop policy if exists bots_delete on bots;

create policy bots_select on bots
  for select to authenticated
  using (org_id in (select public.user_org_ids()));

create policy bots_insert on bots
  for insert to authenticated
  with check (public.user_can_write(org_id));

create policy bots_update on bots
  for update to authenticated
  using      (public.user_can_write(org_id))
  with check (public.user_can_write(org_id));

create policy bots_delete on bots
  for delete to authenticated
  using (public.user_can_write(org_id));

revoke all on bots from anon;
grant select, insert, update, delete on bots to authenticated;
grant all on bots to service_role;
