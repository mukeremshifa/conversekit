-- ================================================================
-- ConverseKit — one bot per organization
-- Run in the Supabase SQL Editor after 013_hybrid.sql
--
-- WHY. `bots` was always the tenancy row rather than a feature: nothing
-- in the Worker fans out over several, and RLS — not application code —
-- is what keeps one org out of another's rows. What multiple bots per
-- org actually bought was a switcher in the dashboard, a second corpus
-- to keep in sync, and a second embedding model to drift out of step
-- with it. The product is sold to businesses that have one website and
-- one front desk, so this migration makes the schema say that.
--
-- It does NOT remove `bot_id`. Every table still hangs off exactly one
-- scoping key and that key is still a bot; the only change is that an
-- org now has precisely one, provisioned for it rather than created by
-- hand. Collapsing bot into org would rename a column referenced by
-- eleven foreign keys, two pgvector RPCs and every RLS policy, and
-- would break the `data-bot-id` embed contract already pasted into
-- customer sites. That is a rename, not a simplification.
--
-- Additive and re-runnable. The one INSERT only ever fills a gap, and
-- the unique index is skipped rather than forced on a database that
-- already violates it.
-- ================================================================


-- ----------------------------------------------------------------
-- Signup now provisions the bot too
--
-- Same reasoning 003 gives for creating the org here rather than in
-- Worker code: a new user has no membership yet, so RLS forbids them
-- from inserting their own bot. Doing it in the trigger means org,
-- membership and bot are created in one transaction and no HTTP path
-- can ever observe a signed-in user without somewhere to put their
-- knowledge base.
--
-- `allowed_origins` is left at its '{}' default deliberately. An empty
-- list refuses every origin (src/origin.ts), so a freshly provisioned
-- bot is inert until its owner names their domain — which is the safe
-- direction to fail in for a widget that answers anonymous traffic.
--
-- The `nullif` around split_part is a fix carried along: split_part
-- returns '' rather than NULL for an address with no local part, so
-- the coalesce in the 003 version could never actually fire and such a
-- user got an org named ''.
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

  insert into public.bots (org_id, name, business_name)
  values (new_org, who, who);

  return new;
end;
$$;

-- The trigger itself is unchanged; recreated so this file stands alone
-- on a database where 003 was applied by hand.
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ----------------------------------------------------------------
-- Backfill — an org that predates the trigger change gets its bot
--
-- Without this, every existing tenant lands on a dashboard whose bot
-- switcher has just been removed and whose only remaining create path
-- is the empty state. Filling the gap here is what lets the UI treat
-- "you have a bot" as true rather than as a case to handle.
--
-- 'unclaimed' is excluded: it is 003's holding pen for bots that had no
-- owner, not a tenant, and giving it a bot would put a live row in an
-- org nobody can sign in to.
-- ----------------------------------------------------------------
insert into public.bots (org_id, name, business_name)
select o.id,
       coalesce(nullif(btrim(o.name), ''), 'My Bot'),
       coalesce(nullif(btrim(o.name), ''), 'My Business')
  from public.organizations o
 where o.slug <> 'unclaimed'
   and not exists (select 1 from public.bots b where b.org_id = o.id);


-- ----------------------------------------------------------------
-- One bot per org, enforced in the database
--
-- GUARDED, and the guard is the point. This project has no rollback
-- (see the header of scripts/migrate.mjs), so a migration that aborts
-- because some org happens to hold two bots would leave the trigger
-- change above applied and the runner's ledger saying the file failed.
-- A tenant with a second bot is a data question — which corpus is the
-- real one — and not something a schema change gets to answer at 3am.
--
-- So: create the index when the data permits, and say plainly what was
-- skipped when it does not. src/index.ts enforces the same rule on the
-- create path either way, which is why skipping here is survivable.
--
-- The non-unique idx_bots_org from 003 is dropped only in the branch
-- that replaces it — a unique index on the same column serves every
-- lookup it served.
-- ----------------------------------------------------------------
do $$
declare
  offenders integer;
begin
  select count(*) into offenders
    from (select org_id from public.bots group by org_id having count(*) > 1) d;

  if offenders > 0 then
    raise warning
      'single-bot: % organization(s) hold more than one bot — unique index NOT created. '
      'Pick the bot to keep per org, delete the others (this cascades their '
      'conversations, leads, documents and chunks), then re-run this file.',
      offenders;
  else
    create unique index if not exists idx_bots_org_unique on public.bots(org_id);
    drop index if exists idx_bots_org;
  end if;
end $$;
