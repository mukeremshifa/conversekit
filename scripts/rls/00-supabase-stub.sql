-- Minimal stand-in for the Supabase-managed pieces the migrations
-- depend on, so 001-004 can be executed against a plain Postgres.
-- Mirrors how PostgREST actually behaves: it SET ROLEs to the role in
-- the JWT and puts the claims in request.jwt.claims.

create schema if not exists auth;

create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text unique
);

-- Supabase's auth.uid() reads the sub claim off the request GUC.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::json ->> 'sub', '')::uuid
$$;

-- Roles are CLUSTER-wide, not per-database. verify-rls.mjs drops and
-- recreates the database on every run, but these survive it — and if a
-- role of the same name already exists from anything else on the same
-- cluster, `if not exists` silently keeps whatever attributes it has.
--
-- That is not hypothetical: a service_role created elsewhere without
-- BYPASSRLS made this suite report "B's bot survived A's DELETE" as a
-- failure, because the assertion that reads the table back as
-- service_role could no longer see any row. An hour went into an RLS
-- hole that did not exist.
--
-- So: create if absent, but ALTER unconditionally. The attributes are
-- what the tests depend on, and asserting them is cheap.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role;
  end if;
end $$;

alter role anon           nologin noinherit nobypassrls;
alter role authenticated  nologin noinherit nobypassrls;
-- service_role is the chat path's identity and bypasses RLS by design;
-- the suite asserts that separation, so it must actually hold here.
alter role service_role   nologin noinherit bypassrls;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth   to anon, authenticated, service_role;
grant select on auth.users   to service_role;

-- Supabase's default: new public tables are readable by anon. This is
-- the footgun 003 is expected to close, so reproduce it faithfully.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
