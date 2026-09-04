-- ================================================================
-- 007_erasure.sql — retention and erasure for visitor PII
--
-- 003 gave conversations and leads a select-only tenant policy and
-- left deletion out entirely. That was defensible while the only way
-- to remove a transcript was to remove the bot it belonged to and let
-- the cascade do it. It stops being defensible the moment a real
-- visitor asks for their data back, because GDPR Art. 15 and 17 are
-- requests about ONE PERSON and the only tool on the platform was
-- "delete the tenant's entire bot".
--
-- These are the two tables on this platform whose contents a visitor
-- typed about themselves — a name, an email, a phone number, and
-- every word of the conversation. retrieval_log already had a window
-- and a documented reason for it (005). These did not, and they hold
-- strictly more than it does.
--
-- THREE MECHANISMS, and they are separate because they answer to
-- different people:
--
--   prune_conversations()  time-based, on a cron. The platform's own
--                          retention promise, applied to every tenant.
--   erase_session()        one visitor, by session. What an erasure
--                          request actually asks for.
--   delete policies        a tenant deleting a lead from their own
--                          dashboard, under RLS, as themselves.
--
-- A single "delete stuff" RPC would have collapsed all three into one
-- blast radius held by whoever called it. They stay apart.
-- ================================================================


-- ----------------------------------------------------------------
-- prune_conversations — the retention mechanism
--
-- Same clamp-inside-the-function reasoning as prune_retrieval_log,
-- and for a stronger reason: this table holds the transcript itself,
-- not a logged query string. The Worker holds a service-role key, so
-- the floor is what stops a bug in the cron handler from truncating
-- every transcript on the platform. [7, 365], matching retrieval_log
-- — a transcript and the query that produced it are the same event
-- seen twice, and giving them different windows would mean one
-- outlives the other for no reason anyone could state.
--
-- Leads are deliberately NOT pruned here. A lead is a business record
-- the tenant is entitled to keep — it is the output of the product,
-- and a CSV export the tenant already downloaded is outside this
-- database anyway. Leads leave by erase_session() or by the tenant
-- deleting them. Time does not remove them.
-- ----------------------------------------------------------------
create or replace function public.prune_conversations(p_days integer default 180)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  -- coalesce first: an explicit null argument would otherwise sail
  -- through both bounds and take the whole table with it.
  v_days    integer := least(365, greatest(7, coalesce(p_days, 180)));
  v_deleted integer;
begin
  delete from public.conversations
   where created_at < now() - make_interval(days => v_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$fn$;

revoke all on function public.prune_conversations(integer) from public;
grant execute on function public.prune_conversations(integer) to service_role;


-- ----------------------------------------------------------------
-- erase_session — Art. 17, as one call
--
-- A session id is the only handle that spans both tables: the widget
-- issues one signed id per visitor (see src/session.ts), and both the
-- transcript rows and any lead captured mid-conversation carry it.
-- That makes it the correct unit of erasure — "everything this person
-- said and everything we extracted from it" is exactly one predicate
-- on each table.
--
-- SCOPED TO A BOT, not to a session alone. session_id is not unique
-- across tenants and nothing constrains it to be; without the bot_id
-- term, one tenant's erasure request could delete another tenant's
-- rows if the ids ever collided. The bot_id makes the collision
-- harmless instead of relying on it never happening.
--
-- Returns both counts rather than a single total, because "0 leads,
-- 12 messages" and "1 lead, 11 messages" are different answers to
-- give the person who asked, and a sum cannot tell them apart.
--
-- retrieval_log is NOT touched. It stores the query text but carries
-- no session_id to match on (005), and its own 90-day window already
-- removes it — sooner than the transcript window above. Erasure that
-- silently skipped a table would be a lie; this one skips nothing
-- that can be reached by the handle it was given, and the omission is
-- stated here and in docs/tenancy.md rather than left to be found.
-- ----------------------------------------------------------------
create or replace function public.erase_session(
  p_bot_id     uuid,
  p_session_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_messages integer;
  v_leads    integer;
begin
  -- Neither argument may be null or blank. A null p_session_id would
  -- make both predicates `= null`, which matches nothing and returns
  -- a cheerful "erased 0 rows" — the one failure mode that must not
  -- look like success to whoever is answering the request.
  if p_bot_id is null or coalesce(btrim(p_session_id), '') = '' then
    raise exception 'erase_session requires a bot id and a non-empty session id';
  end if;

  delete from public.conversations
   where bot_id = p_bot_id and session_id = p_session_id;
  get diagnostics v_messages = row_count;

  delete from public.leads
   where bot_id = p_bot_id and session_id = p_session_id;
  get diagnostics v_leads = row_count;

  return jsonb_build_object('messages', v_messages, 'leads', v_leads);
end;
$fn$;

revoke all on function public.erase_session(uuid, text) from public;
grant execute on function public.erase_session(uuid, text) to service_role;


-- ----------------------------------------------------------------
-- Tenant delete policies
--
-- 003 granted select and nothing else, so a tenant looking at a lead
-- in their own dashboard had no way to remove it. The same membership
-- predicate as the select policies — a tenant may delete exactly what
-- they may already read, and the RLS check is what enforces it rather
-- than a bot_id the route remembered to filter on.
--
-- No update policy. A tenant editing a visitor's stored words, or the
-- email address a visitor gave, is not a feature anyone asked for and
-- it would quietly destroy the record's value as evidence of what was
-- actually said.
-- ----------------------------------------------------------------
drop policy if exists conv_delete  on conversations;
drop policy if exists leads_delete on leads;

create policy conv_delete on conversations
  for delete to authenticated
  using (bot_id in (
    select id from bots where org_id in (select public.user_org_ids())
  ));

create policy leads_delete on leads
  for delete to authenticated
  using (bot_id in (
    select id from bots where org_id in (select public.user_org_ids())
  ));

grant delete on conversations to authenticated;
grant delete on leads         to authenticated;


comment on function public.prune_conversations(integer) is
  'Deletes conversation rows older than p_days, clamped to [7, 365]. Daily cron. Leads are not time-pruned; see the header of 007_erasure.sql.';
comment on function public.erase_session(uuid, text) is
  'GDPR Art. 17 erasure for one visitor: deletes that session transcript rows and captured lead for one bot. Returns {messages, leads}.';
