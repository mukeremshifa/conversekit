-- ================================================================
-- ConverseKit — organization self-service
-- Run in the Supabase SQL Editor after 006_client_ready.sql
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
-- ================================================================

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
