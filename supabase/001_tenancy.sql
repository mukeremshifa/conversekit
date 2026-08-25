-- ================================================================
-- ConverseKit — tenancy
--
-- The tenant boundary and the machinery that enforces it. Everything
-- else in this directory hangs off `organizations`, and every RLS
-- policy in the schema is one of the two helper calls below.
--
-- ── ABOUT THIS DIRECTORY ────────────────────────────────────────
--
-- These six files replace the seventeen that built this schema one
-- feature at a time between 001_init and 017_usage. That history is in
-- git; what it left behind was a schema you could only understand by
-- replaying it — a column added in one file, superseded in another and
-- read-through-deprecated in a third, a retrieval function dropped and
-- recreated four times, and three backfills that had already run.
--
-- WHAT WAS DROPPED: seed rows, one-time backfills, the 'unclaimed'
-- holding org, the guarded index dance in the single-bot migration, and
-- every superseded version of a function. WHAT WAS NOT: a single column
-- the Worker reads. The deprecated business-facts columns are still
-- here, still deprecated, and still exactly as load-bearing as they
-- were — see the note on them in 002_bots.sql.
--
-- The rules the old files established still hold, and each is recorded
-- where it applies rather than only here:
--
--   * Every file is re-runnable. `if not exists`, `create or replace`,
--     `drop policy ... if exists` before create.
--   * Deploy schema BEFORE the Worker, always. A Worker calling an RPC
--     that does not exist fails outright; a schema ahead of the Worker
--     is unread.
--   * scripts/migrate.mjs is the only thing that should apply these.
--     Every migration this project shipped before that script existed
--     was pasted into the SQL editor by hand, which is how a Worker
--     once went out ahead of its schema and broke bot creation.
-- ================================================================


-- ----------------------------------------------------------------
-- Extensions
--
-- Both are needed by 004/005 and are created here so the whole schema
-- has one place that says what it depends on.
--
--   vector   768-dimension embeddings on chunks, and the HNSW index.
--   pg_trgm  the FAQ shortcut's `%` operator and similarity().
--
-- SEARCH PATH IS NOT DECORATION. Supabase pre-creates some extensions
-- in an `extensions` schema rather than in `public`, so
-- `create extension if not exists` can be a silent no-op that leaves
-- `similarity()`, `%` and `gin_trgm_ops` somewhere `public` alone
-- cannot see. Naming both schemas makes the opclasses resolve either
-- way; match_faq_items carries the same pair for the same reason.
-- ----------------------------------------------------------------
set search_path = public, extensions;

create extension if not exists vector;
create extension if not exists pg_trgm;


-- ----------------------------------------------------------------
-- organizations — the tenant boundary
-- ----------------------------------------------------------------
create table if not exists organizations (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null,
  slug       text        not null unique,
  -- Free text, read by src/entitlements.ts, which normalises anything
  -- it does not recognise down to 'free'. Deliberately not a CHECK: a
  -- new tier should be a row's worth of change, not a migration.
  plan       text        not null default 'free',
  created_at timestamptz not null default now()
);

comment on column organizations.plan is
  'Entitlement tier. Resolved by src/entitlements.ts, which treats anything unrecognised as free. Tiers are data, not deploy targets — see docs/deployment-rebuild.md.';


-- ----------------------------------------------------------------
-- memberships — which users belong to which org, and as what
--
-- Roles are carried even though only 'owner' is ever created today.
-- Retrofitting a role column onto live policies is far more painful
-- than having an unused one.
-- ----------------------------------------------------------------
create table if not exists memberships (
  id         uuid        primary key default gen_random_uuid(),
  org_id     uuid        not null references organizations(id) on delete cascade,
  user_id    uuid        not null references auth.users(id)    on delete cascade,
  role       text        not null default 'owner'
                         check (role in ('owner', 'admin', 'viewer')),
  created_at timestamptz not null default now(),
  unique (org_id, user_id)
);

create index if not exists idx_memberships_user on memberships(user_id);


-- ----------------------------------------------------------------
-- Policy helpers
--
-- Both are SECURITY DEFINER so they bypass RLS. That is what breaks
-- the recursion: a policy on `bots` needs to read `memberships`, but
-- `memberships` is itself RLS-protected, and its policy would in turn
-- need to be evaluated — infinite descent. A definer function reads
-- the table directly and ends the cycle.
--
-- `set search_path` is mandatory, not stylistic: without it a caller
-- can shadow `public` with their own schema and have this function
-- execute their objects with the definer's privileges.
--
-- These work because Postgres exempts a table's OWNER from RLS. So:
-- never run `alter table public.memberships force row level security`
-- — that would re-enable policy evaluation for the owner too, and the
-- recursion this exists to break would come straight back.
-- ----------------------------------------------------------------
create or replace function public.user_org_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select org_id from public.memberships where user_id = auth.uid()
$$;

revoke all on function public.user_org_ids() from public;
grant execute on function public.user_org_ids() to authenticated;


create or replace function public.user_can_write(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.memberships
    where user_id = auth.uid()
      and org_id  = target_org
      and role in ('owner', 'admin')
  )
$$;

revoke all on function public.user_can_write(uuid) from public;
grant execute on function public.user_can_write(uuid) to authenticated;


-- ----------------------------------------------------------------
-- create_organization — the recovery path
--
-- Closes a trap this project actually fell into: a user whose only
-- organization is deleted is stranded forever. The signup trigger
-- fires on INSERT to auth.users, so it never runs again for an
-- existing account — and RLS forbids inserting an organization when
-- you have no membership to authorise it. No org, no way to make one.
--
-- SECURITY DEFINER because the caller legitimately cannot satisfy the
-- policies yet. It is safe by construction: user_id comes from
-- auth.uid(), never from the caller, so this can only ever create a
-- brand-new empty org owned by whoever called it. It can never grant
-- access to anyone else's data.
-- ----------------------------------------------------------------
create or replace function public.create_organization(p_name text)
returns public.organizations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_org  public.organizations;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if length(v_name) = 0 or length(v_name) > 120 then
    raise exception 'name must be 1-120 characters' using errcode = '22023';
  end if;

  insert into public.organizations (name, slug)
  values (v_name, 'org-' || replace(gen_random_uuid()::text, '-', ''))
  returning * into v_org;

  insert into public.memberships (org_id, user_id, role)
  values (v_org.id, v_uid, 'owner');

  return v_org;
end;
$$;

revoke all on function public.create_organization(text) from public;
grant execute on function public.create_organization(text) to authenticated;


-- ----------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------
alter table organizations enable row level security;
alter table memberships   enable row level security;

drop policy if exists org_select on organizations;
drop policy if exists mem_select on memberships;

create policy org_select on organizations
  for select to authenticated
  using (id in (select public.user_org_ids()));

create policy mem_select on memberships
  for select to authenticated
  using (org_id in (select public.user_org_ids()));


-- ----------------------------------------------------------------
-- Grants
--
-- PostgREST reaches these tables as anon, authenticated or
-- service_role, so all three need USAGE on the schema — but only the
-- latter two get anything on a table.
--
-- THE ANON REVOKE IS THE POINT. SUPABASE_ANON_KEY ships in the
-- dashboard bundle and in every browser that loads it; it is a
-- publishable key precisely because the role behind it can reach
-- /auth/v1/* and nothing else. The default privileges line is what
-- keeps that true for tables added later — without it, a new table in
-- this schema is born readable by anyone holding that key.
-- ----------------------------------------------------------------
grant usage on schema public to anon, authenticated, service_role;

alter default privileges in schema public revoke all on tables from anon;

revoke all on organizations, memberships from anon;

grant select on organizations to authenticated;
grant select on memberships   to authenticated;
grant all    on organizations, memberships to service_role;
