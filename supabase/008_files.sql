-- ================================================================
-- ConverseKit — Phase 2B: uploaded files as knowledge sources
-- Run in the Supabase SQL Editor after 007_org_recovery.sql
--
-- Additive and safe to re-run. Nothing here changes behaviour for the
-- three existing sources; it only makes a fourth one expressible.
--
-- The bytes themselves live in R2, not here. This table records where
-- (`r2_key`), what (`mime_type`) and how big (`size_bytes`) — enough
-- to re-extract a document without re-uploading it, and enough to
-- charge a tenant's storage against a cap.
-- ================================================================


-- ----------------------------------------------------------------
-- documents.source gains 'file'
--
-- The constraint was created inline in 005_rag.sql, so Postgres named
-- it `documents_source_check`. Dropped and recreated rather than
-- altered because Postgres has no ALTER CONSTRAINT for a CHECK.
-- ----------------------------------------------------------------
alter table documents drop constraint if exists documents_source_check;

alter table documents add constraint documents_source_check
  check (source in ('text', 'url', 'markdown', 'file'));


-- ----------------------------------------------------------------
-- Where the original bytes live.
--
-- r2_key is kept after extraction on purpose: it lets a document be
-- re-chunked with different settings, or re-extracted once the
-- converter improves, without asking the tenant to upload again.
--
-- No NOT NULL and no cross-column CHECK tying r2_key to source='file'.
-- The Worker is the only writer of these columns, and a constraint
-- that can only fire on a Worker bug would show up as an opaque
-- PostgREST error at the least helpful moment.
-- ----------------------------------------------------------------
alter table documents add column if not exists r2_key     text;
alter table documents add column if not exists mime_type  text;
alter table documents add column if not exists size_bytes integer
  check (size_bytes is null or size_bytes >= 0);

comment on column documents.r2_key is
  'Object key in the DOCS R2 bucket. Null for non-file sources.';

-- One document per object. Catches a double-submit that would
-- otherwise index the same upload twice and double its retrieval
-- weight; also stops a crafted insert from pointing a second
-- document row at another tenant's object.
create unique index if not exists idx_documents_r2_key
  on documents(r2_key) where r2_key is not null;


-- ----------------------------------------------------------------
-- Per-org storage cap
--
-- One tenant must not be able to fill the bucket. Enforced here rather
-- than in the Worker because the Worker's check is advisory — it races
-- against concurrent uploads and it is bypassed entirely by anything
-- talking to PostgREST directly.
--
-- The Worker still checks first, so the common case gets a readable
-- 413 instead of a constraint violation. This is the backstop.
-- ----------------------------------------------------------------
create or replace function public.org_storage_bytes(p_org_id uuid)
returns bigint
language sql
stable
set search_path = public
as $$
  select coalesce(sum(size_bytes), 0)::bigint
    from public.documents
   where org_id = p_org_id
     and size_bytes is not null;
$$;

grant execute on function public.org_storage_bytes(uuid) to authenticated, service_role;

-- 100 MB per organization. Ten times the Worker's 10 MB per-file
-- ceiling, so a tenant gets a useful corpus before hitting it.
create or replace function public.enforce_org_storage_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cap  bigint := 104857600;
  v_used bigint;
begin
  if new.size_bytes is null or new.size_bytes = 0 then
    return new;
  end if;

  select public.org_storage_bytes(new.org_id) into v_used;

  if v_used + new.size_bytes > v_cap then
    raise exception
      'Storage limit reached: this organization has used % of % bytes. Delete a source to free space.',
      v_used, v_cap
      using errcode = '53100';   -- disk_full
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_org_storage_cap() from public;

-- Fires AFTER trg_documents_org, which is load-bearing: that trigger
-- derives new.org_id from the bot, and this one reads it. Postgres
-- runs BEFORE triggers in name order, and 'trg_documents_org' sorts
-- before 'trg_documents_storage_cap'. Renaming either breaks the cap
-- silently — it would compare against a null org.
drop trigger if exists trg_documents_storage_cap on documents;
create trigger trg_documents_storage_cap
  before insert on documents
  for each row execute function public.enforce_org_storage_cap();
