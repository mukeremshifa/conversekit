-- ================================================================
-- ConverseKit — usage metering
--
-- Every adapter maps its vendor's token counts onto `Usage`, and every
-- one of those numbers used to be thrown away: the SSE `done` frame
-- carried it to a widget that ignored it, the preview route returned it
-- to a dashboard that ignored it, and embeddings — the larger number by
-- far — never left embedPieces at all. This is the table they land in.
--
-- See docs/usage-metering.md for the decision behind every column.
-- ================================================================


-- ----------------------------------------------------------------
-- usage_log — one row per PROVIDER CALL
--
-- ONE TABLE, NOT A COLUMN ON conversations, for four reasons that get
-- progressively harder to work around:
--
--   1. Embeddings have no conversation row. An ingest is not a turn,
--      and it is where a tenant's tokens actually go — one document is
--      thousands of input tokens, one chat turn is hundreds.
--   2. A failed turn still spent tokens. The vendor charges for the
--      input it read before it failed, and persistTurn never runs on
--      that path — so a column on the assistant row loses exactly the
--      spend a tenant most wants explained.
--   3. Retention differs. Transcripts and retrieval_log hold what
--      visitors typed; these rows hold integers and no PII, so coupling
--      them would force the stricter window onto data that does not
--      need it and throw away the platform's own billing history every
--      90 days.
--   4. ROWS COUNT CALLS, NOT TURNS. The widget falls back from the
--      streaming endpoint to the buffered one on a transport failure,
--      so one visitor question can produce two provider calls and two
--      rows here. Correct for COST — both were spent — and wrong for
--      anyone reading the row count as conversation volume. Count turns
--      from `conversations`, the way buildStats does.
--
-- NO KEY MATERIAL EVER LANDS HERE. Vendor and model only.
-- provider_config may hold a BYOK key and must never reach a browser;
-- this table is read by browsers.
--
-- METERING THAT CAN ENFORCE, NOT JUST OBSERVE. `org_id` and its index
-- are what make a quota check possible off the same rows the report
-- reads — see src/entitlements.ts, which is where a budget cap would
-- ask.
-- ----------------------------------------------------------------
create table if not exists usage_log (
  id                  uuid        primary key default gen_random_uuid(),
  bot_id              uuid        not null references bots(id)          on delete cascade,
  org_id              uuid        not null references organizations(id) on delete cascade,
  -- Nullable, same as retrieval_log: ingest and preview have no session.
  session_id          text,
  -- 'chat' | 'embed' | 'preview'. Deliberately not a CHECK — same
  -- reasoning as retrieval_log.channel: a fourth kind (rerank is the
  -- obvious next one) should not need a migration to start recording
  -- itself.
  kind                text        not null,
  vendor              text        not null,
  model               text        not null,
  input_tokens        integer,
  output_tokens       integer,
  -- Reserved for prompt caching. Nullable and unused today: `Usage`
  -- carries two fields, while Anthropic's cache_creation_input_tokens /
  -- cache_read_input_tokens and Gemini's cachedContentTokenCount are a
  -- third and a fourth, priced differently. Landing that should be a
  -- type change and a mapper edit, not a migration against a populated
  -- table.
  cached_input_tokens integer,

  -- 'reported' | 'estimated'. THIS COLUMN IS THE FEATURE.
  --
  -- On the platform default — Gemini chat plus Workers AI embeddings —
  -- three of the four adapter paths report no usage at all, so a plain
  -- integer column would record NULL for every single ingest and the
  -- default deployment would display zeros. The estimator exists so a
  -- free-tier tenant sees a shape rather than a blank, and this column
  -- exists so nobody can mistake that shape for a bill: "you used 1.2M
  -- tokens" and "you used about 1.2M tokens, 60% of it estimated from
  -- text length" are materially different statements, and a schema that
  -- cannot tell them apart will present the second as the first.
  source              text        not null,

  -- 'ok' | 'error'. A provider failure still consumed the input it
  -- read. Without this the meter reads LOWEST exactly when a tenant is
  -- burning money retrying against a misconfigured vendor, which is the
  -- one moment it needs to read high.
  outcome             text        not null default 'ok',

  created_at          timestamptz not null default now()
);

comment on table usage_log is
  'One row per PROVIDER CALL, not per turn. A streaming failure that falls back to the buffered endpoint produces two rows: correct for cost, wrong for conversation volume — count turns from conversations. Pruned by prune_usage_log() on its own daily cron. See docs/usage-metering.md.';
comment on column usage_log.source is
  'reported = the vendor returned these counts. estimated = derived from text length because it returned none, which on the platform default embedder is every embedding row. Never bill from an estimated row.';
comment on column usage_log.cached_input_tokens is
  'Reserved for prompt caching. Unused today.';
comment on column usage_log.outcome is
  'ok | error. An error row records what the failed call still spent — the input tokens the vendor read before it failed.';

-- The tenant-facing report reads one bot's recent rows, newest first.
create index if not exists idx_usage_log_bot on usage_log(bot_id, created_at desc);
-- NOT redundant with the above: budget caps and any per-org rollup query
-- the org directly, and that is the next thing built on this table.
create index if not exists idx_usage_log_org on usage_log(org_id, created_at desc);

drop trigger if exists trg_usage_log_org on usage_log;
create trigger trg_usage_log_org
  before insert on usage_log
  for each row execute function public.set_org_from_bot_row();


-- ----------------------------------------------------------------
-- prune_usage_log — the retention mechanism
--
-- The same clamp-inside-the-function reasoning as prune_retrieval_log,
-- with wider bounds and for a stated reason: retrieval_log holds what
-- visitors typed and its window is a privacy commitment; this table
-- holds integers, no PII, and is billing history. "This March against
-- last March" is the ordinary question, and answering it needs more
-- than a year of rows. Floored at 30 rather than 7, because a week-long
-- window on a year-over-year table is not a number anyone would ask for
-- on purpose.
-- ----------------------------------------------------------------
create or replace function public.prune_usage_log(p_days integer default 400)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_days    integer := least(800, greatest(30, coalesce(p_days, 400)));
  v_deleted integer;
begin
  delete from public.usage_log
   where created_at < now() - make_interval(days => v_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$fn$;

revoke all on function public.prune_usage_log(integer) from public;
grant execute on function public.prune_usage_log(integer) to service_role;


-- ----------------------------------------------------------------
-- RLS and grants — mirrors retrieval_log, which mirrors chunks
--
-- Select for members of the owning org, and no tenant write policy at
-- all. Derived data: the Worker writes it with the service role, and a
-- tenant editing their own meter is not a state worth allowing.
-- ----------------------------------------------------------------
alter table usage_log enable row level security;

drop policy if exists usage_log_select on usage_log;

create policy usage_log_select on usage_log
  for select to authenticated
  using (org_id in (select public.user_org_ids()));

revoke all on usage_log from anon;
grant select on usage_log to authenticated;
grant all    on usage_log to service_role;


-- ----------------------------------------------------------------
-- PostgREST caches the schema and will not see any of the last six
-- files until it is told to look again. Cheap, idempotent, and the
-- difference between a working deploy and half an hour spent debugging
-- "relation does not exist" against a database that plainly has it.
-- ----------------------------------------------------------------
notify pgrst, 'reload schema';
