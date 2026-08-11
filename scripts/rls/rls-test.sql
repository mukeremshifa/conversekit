-- Executable proof that 003's policies isolate tenants.
-- Simulates PostgREST exactly: SET ROLE to the JWT's role, and put the
-- claims in request.jwt.claims so auth.uid() resolves.

\set ON_ERROR_STOP on

create or replace function assert(cond boolean, msg text)
returns void language plpgsql as $$
begin
  if not cond then raise exception 'ASSERTION FAILED: %', msg; end if;
  raise notice '  ok   %', msg;
end $$;

-- ── Signup trigger ───────────────────────────────────────────────
insert into auth.users (id, email) values
  ('11111111-1111-1111-1111-111111111111', 'a@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'b@example.com');

\echo '=== signup trigger ==='
select assert((select count(*) from organizations where slug like 'org-%') = 2,
              'signup created one org per user');
select assert((select count(*) from memberships where role = 'owner') = 2,
              'each user got an owner membership');
select assert((select count(distinct org_id) from memberships) = 2,
              'the two orgs are distinct');

-- ── A creates a bot ──────────────────────────────────────────────
\echo '=== bots_insert policy ==='
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
  insert into bots (org_id, name, business_name, allowed_origin, allowed_origins)
  select org_id, 'Bot A', 'Biz A', 'https://a.example.com', array['https://a.example.com','https://www.a.example.com']
    from memberships limit 1;
  select assert((select count(*) from bots) = 1, 'A sees only its own bot (not the seeded demo)');
commit;

-- B creates a bot
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
  insert into bots (org_id, name, business_name, allowed_origin, allowed_origins)
  select org_id, 'Bot B', 'Biz B', 'https://b.example.com', array['https://b.example.com']
    from memberships limit 1;
commit;

-- Seed B's child rows as service_role (the chat path)
begin;
  set local role service_role;
  insert into leads (bot_id, session_id, name, email, inquiry)
  select id, 'sess-b', 'Secret Lead', 'secret@example.com', 'confidential'
    from bots where name = 'Bot B';
  insert into conversations (bot_id, session_id, role, content)
  select id, 'sess-b', 'user', 'confidential message' from bots where name = 'Bot B';
commit;

-- ── Cross-tenant reads ───────────────────────────────────────────
\echo '=== isolation: A must not see B ==='
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

  select assert((select count(*) from bots) = 1,                      'A sees exactly 1 bot');
  select assert((select count(*) from bots where name = 'Bot B') = 0, 'A cannot see B''s bot');
  select assert((select count(*) from leads) = 0,                     'A sees none of B''s leads');
  select assert((select count(*) from conversations) = 0,             'A sees none of B''s conversations');
  select assert((select count(*) from organizations) = 1,             'A sees only its own org');
  -- This is the query that recurses without the SECURITY DEFINER helper.
  select assert((select count(*) from memberships) = 1,               'A sees only its own membership (no 42P17 recursion)');
commit;

-- ── Cross-tenant writes ──────────────────────────────────────────
\echo '=== isolation: A must not write to B ==='
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

  update bots set name = 'pwned' where name = 'Bot B';
  select assert((select count(*) from bots where name = 'pwned') = 0, 'A''s UPDATE of B''s bot affected nothing');

  delete from bots where name = 'Bot B';
commit;

begin;
  set local role service_role;
  select assert((select count(*) from bots where name = 'Bot B') = 1, 'B''s bot survived A''s DELETE');
  select assert((select name from bots where business_name = 'Biz B') = 'Bot B', 'B''s bot name unchanged');
commit;

-- Privilege escalation: forge a membership into B's org
\echo '=== privilege escalation ==='
do $$
declare org_b uuid; ok boolean := false;
begin
  select m.org_id into org_b from memberships m
   where m.user_id = '22222222-2222-2222-2222-222222222222';
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
    insert into memberships (user_id, org_id, role)
    values ('11111111-1111-1111-1111-111111111111', org_b, 'owner');
  exception when insufficient_privilege or others then
    ok := true;
  end;
  reset role;
  if not ok then raise exception 'ASSERTION FAILED: A forged a membership into B''s org'; end if;
  raise notice '  ok   A cannot forge a membership into B''s org';
end $$;

-- Moving a bot into another org via UPDATE (the WITH CHECK test)
\echo '=== bot cannot be moved across orgs ==='
do $$
declare org_b uuid; moved int;
begin
  select m.org_id into org_b from memberships m
   where m.user_id = '22222222-2222-2222-2222-222222222222';
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
    update bots set org_id = org_b where name = 'Bot A';
    get diagnostics moved = row_count;
    if moved > 0 then
      reset role;
      raise exception 'ASSERTION FAILED: A moved its bot into B''s org';
    end if;
  exception when insufficient_privilege then
    moved := 0;
  end;
  reset role;
  raise notice '  ok   A cannot move its bot into B''s org (WITH CHECK held)';
end $$;

-- ── anon lockdown ────────────────────────────────────────────────
\echo '=== anon key lockdown ==='
do $$
declare blocked boolean := false;
begin
  begin
    set local role anon;
    perform count(*) from bots;
  exception when insufficient_privilege then
    blocked := true;
  end;
  reset role;
  if not blocked then raise exception 'ASSERTION FAILED: anon can still reach bots'; end if;
  raise notice '  ok   anon has no access to bots';
end $$;

do $$
declare blocked boolean := false;
begin
  begin
    set local role anon;
    perform count(*) from leads;
  exception when insufficient_privilege then
    blocked := true;
  end;
  reset role;
  if not blocked then raise exception 'ASSERTION FAILED: anon can still reach leads'; end if;
  raise notice '  ok   anon has no access to leads';
end $$;

-- Future tables must not be born anon-readable (the default-privileges fix)
\echo '=== future tables ==='
create table public.chunks_probe (id int);
do $$
declare blocked boolean := false;
begin
  begin
    set local role anon;
    perform count(*) from public.chunks_probe;
  exception when insufficient_privilege then
    blocked := true;
  end;
  reset role;
  if not blocked then raise exception 'ASSERTION FAILED: a NEW public table is anon-readable — Phase 2 would leak'; end if;
  raise notice '  ok   newly created tables are not anon-readable';
end $$;
drop table public.chunks_probe;

-- ── service_role still works (the chat path) ─────────────────────
\echo '=== service_role bypass ==='
begin;
  set local role service_role;
  select assert((select count(*) from bots) >= 2,  'service_role sees every bot');
  select assert((select count(*) from leads) = 1,  'service_role sees leads');
commit;

\echo ''
\echo 'RLS ISOLATION VERIFIED'

-- ── 006: multiple origins ────────────────────────────────────────
\echo '=== origins are a list ==='
-- The seeded demo bot predates 006, so it proves the backfill ran.
select assert(
  (select allowed_origins from bots where name = 'Demo Clinic Bot') = array['http://localhost:3000'],
  '006 backfilled pre-existing rows from allowed_origin');
select assert(
  (select array_length(allowed_origins, 1) from bots where name = 'Bot A') = 2,
  'a bot can hold several origins (apex + www)');
-- A row inserted with only the legacy column is still valid: the Worker
-- falls back to allowed_origin, which is what keeps an older deploy
-- working while 006 rolls out.
select assert(
  (select allowed_origin from bots where name = 'Bot B') is not null,
  'the legacy column remains readable as a fallback');

-- ── 007: a user with no org is not stranded ──────────────────────
-- This is the trap the project actually fell into: the signup trigger
-- only fires on INSERT, and RLS forbids creating an org without a
-- membership, so losing your only org used to be unrecoverable.
\echo '=== stranded user can recover ==='
do $$
declare org_count int; new_role text;
begin
  insert into auth.users (id, email) values ('44444444-4444-4444-4444-444444444444', 'solo@example.com');
  -- Simulate the org being deleted out from under them.
  delete from public.memberships where user_id = '44444444-4444-4444-4444-444444444444';

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated"}';

  select count(*) into org_count from public.organizations;
  if org_count <> 0 then reset role; raise exception 'ASSERTION FAILED: stranded user should see no orgs, saw %', org_count; end if;

  perform public.create_organization('Recovered');

  select count(*) into org_count from public.organizations;
  select role into new_role from public.memberships limit 1;
  reset role;

  if org_count <> 1 then raise exception 'ASSERTION FAILED: expected exactly one org, got %', org_count; end if;
  if new_role <> 'owner' then raise exception 'ASSERTION FAILED: expected owner, got %', new_role; end if;
  raise notice '  ok   a user with no org can create one and owns it';
end $$;

do $$
declare blocked boolean := false;
begin
  begin
    set local role anon;
    perform public.create_organization('Anon Org');
  exception when others then blocked := true;
  end;
  reset role;
  if not blocked then raise exception 'ASSERTION FAILED: anon created an organization'; end if;
  raise notice '  ok   anon cannot create an organization';
end $$;
