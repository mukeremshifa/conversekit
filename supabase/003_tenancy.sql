-- ================================================================
-- ConverseKit — Phase 1: tenancy and Row Level Security
-- Run in the Supabase SQL Editor after 002_phase1.sql
--
-- READ THIS BEFORE RUNNING.
--
-- The final section REVOKEs all table privileges from the `anon`
-- role. The Worker currently talks to PostgREST with the anon key,
-- so applying this migration before deploying a Worker that uses
-- SUPABASE_SERVICE_ROLE_KEY on the chat path WILL take the live
-- widget down. See the sequencing section in PLAN.md.
-- ================================================================


-- ----------------------------------------------------------------
-- organizations — the tenant boundary
-- ----------------------------------------------------------------
create table if not exists organizations (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null,
  slug       text        not null unique,
  plan       text        not null default 'free',
  created_at timestamptz not null default now()
);


-- ----------------------------------------------------------------
-- memberships — which users belong to which org, and as what
--
-- Roles are carried from day one even though Phase 1 only ever
-- creates 'owner'. Retrofitting a role column onto live policies is
-- far more painful than having an unused one.
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
-- bots gain an owner
-- ----------------------------------------------------------------
alter table bots
  add column if not exists org_id uuid references organizations(id) on delete cascade;

-- Park any pre-existing bots in a holding org. They are moved to a
-- real org by the one-time claim snippet at the bottom of this file,
-- run after the first user signs up.
insert into organizations (name, slug)
values ('Unclaimed', 'unclaimed')
on conflict (slug) do nothing;

update bots
set org_id = (select id from organizations where slug = 'unclaimed')
where org_id is null;

alter table bots alter column org_id set not null;

create index if not exists idx_bots_org on bots(org_id);

-- The dashboard orders conversations by exactly this and had no
-- index behind it (see src/supabase.ts getConversations).
create index if not exists idx_conversations_bot_created
  on conversations(bot_id, created_at desc);


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
-- Signup creates an organization
--
-- A new user has no membership, so RLS forbids them from inserting
-- their own org — chicken and egg. Resolve it in the database rather
-- than in Worker code, so the org and the membership are created
-- atomically and no HTTP path can ever observe a user without one.
-- ----------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_org uuid;
begin
  insert into public.organizations (name, slug)
  values (
    coalesce(split_part(new.email, '@', 1), 'workspace'),
    'org-' || replace(new.id::text, '-', '')
  )
  returning id into new_org;

  insert into public.memberships (org_id, user_id, role)
  values (new_org, new.id, 'owner');

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ----------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------
alter table organizations enable row level security;
alter table memberships   enable row level security;
alter table bots          enable row level security;
alter table conversations enable row level security;
alter table leads         enable row level security;

-- Re-runnable: drop before create.
drop policy if exists org_select    on organizations;
drop policy if exists mem_select    on memberships;
drop policy if exists bots_select   on bots;
drop policy if exists bots_insert   on bots;
drop policy if exists bots_update   on bots;
drop policy if exists bots_delete   on bots;
drop policy if exists conv_select   on conversations;
drop policy if exists leads_select  on leads;

create policy org_select on organizations
  for select to authenticated
  using (id in (select public.user_org_ids()));

create policy mem_select on memberships
  for select to authenticated
  using (org_id in (select public.user_org_ids()));

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

-- Conversations and leads are written only by the Worker on the
-- public chat path, which uses service_role and bypasses RLS
-- entirely. Authenticated users therefore get read-only access.
-- Referencing `bots` here is not recursive: the bots policies never
-- mention conversations or leads.
create policy conv_select on conversations
  for select to authenticated
  using (bot_id in (
    select id from bots where org_id in (select public.user_org_ids())
  ));

create policy leads_select on leads
  for select to authenticated
  using (bot_id in (
    select id from bots where org_id in (select public.user_org_ids())
  ));


-- ----------------------------------------------------------------
-- Grants
--
-- DESTRUCTIVE — this is the point of no return for the anon key.
-- Everything the widget needs now goes through service_role.
-- ----------------------------------------------------------------
revoke all on bots, conversations, leads from anon;
revoke all on organizations, memberships from anon;

-- Supabase grants ALL on new public tables to `anon` by default. Without
-- this, Phase 2's documents and chunks tables would be born readable by
-- anyone holding the anon key — which is a key designed to be public.
alter default privileges in schema public revoke all on tables from anon;

grant select, insert, update, delete on bots          to authenticated;
grant select                        on conversations  to authenticated;
grant select                        on leads          to authenticated;
grant select                        on organizations  to authenticated;
grant select                        on memberships    to authenticated;


-- ================================================================
-- ONE-TIME CLAIM — run manually, after signing up for the first time
--
-- Moves any pre-existing bots out of the 'unclaimed' holding org and
-- into your real one. Replace the email, then run:
--
--   update bots
--   set org_id = (
--     select m.org_id from memberships m
--     join auth.users u on u.id = m.user_id
--     where u.email = 'you@example.com'
--     limit 1
--   )
--   where org_id = (select id from organizations where slug = 'unclaimed');
--
-- Then confirm nothing is stranded:
--
--   select count(*) from bots
--   where org_id = (select id from organizations where slug = 'unclaimed');
--   -- expect 0
-- ================================================================



