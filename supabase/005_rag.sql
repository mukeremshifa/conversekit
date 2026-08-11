-- ================================================================
-- ConverseKit — Phase 2: retrieval-augmented generation
-- Run in the Supabase SQL Editor after 004_provider_config.sql
--
-- Additive. Nothing here changes existing behaviour until a bot
-- actually has documents: retrieval over an empty corpus returns
-- nothing and the prompt is built exactly as before.
-- ================================================================

create extension if not exists vector;


-- ----------------------------------------------------------------
-- Embedding width is fixed platform-wide at 768.
--
-- A pgvector column has a fixed dimension, so this is a one-way door
-- per deployment: changing it means re-embedding every chunk. 768 is
-- chosen because every vendor in the catalog can produce it —
-- Gemini and OpenAI by truncation (outputDimensionality / dimensions),
-- and bge-base, nomic-embed and mistral-embed natively. Picking 1536
-- would have locked out every local model.
--
-- embedding_model is recorded per document so a future migration can
-- at least identify what needs re-embedding.
-- ----------------------------------------------------------------


-- ----------------------------------------------------------------
-- documents — one row per ingested source
-- ----------------------------------------------------------------
create table if not exists documents (
  id            uuid        primary key default gen_random_uuid(),
  bot_id        uuid        not null references bots(id)          on delete cascade,
  org_id        uuid        not null references organizations(id) on delete cascade,
  source        text        not null check (source in ('text', 'url', 'markdown')),
  title         text        not null check (length(btrim(title)) between 1 and 300),
  url           text,
  -- Extracted plain text. Kept so a document can be re-chunked with
  -- different settings without re-fetching the original.
  content       text,
  status        text        not null default 'pending'
                            check (status in ('pending', 'processing', 'ready', 'failed')),
  error         text,
  chunk_count   integer     not null default 0,
  embedding_model      text,
  embedding_dimensions integer,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_documents_bot on documents(bot_id, created_at desc);
create index if not exists idx_documents_org on documents(org_id);


-- ----------------------------------------------------------------
-- chunks — the retrieval unit
--
-- bot_id and org_id are denormalised deliberately. bot_id is the
-- retrieval filter and must be indexable alongside the vector; org_id
-- carries the RLS predicate so the policy is the same one-liner used
-- everywhere else rather than a join through documents → bots.
-- Both are set by trigger, never by the application.
-- ----------------------------------------------------------------
create table if not exists chunks (
  id          uuid        primary key default gen_random_uuid(),
  document_id uuid        not null references documents(id) on delete cascade,
  bot_id      uuid        not null references bots(id)      on delete cascade,
  org_id      uuid        not null references organizations(id) on delete cascade,
  ordinal     integer     not null,
  content     text        not null,
  embedding   vector(768),
  created_at  timestamptz not null default now(),
  unique (document_id, ordinal)
);

create index if not exists idx_chunks_bot on chunks(bot_id);

-- HNSW over cosine distance. Built after the table so an empty index
-- is cheap; pgvector fills it incrementally on insert.
create index if not exists idx_chunks_embedding
  on chunks using hnsw (embedding vector_cosine_ops);


-- ----------------------------------------------------------------
-- Derive org_id from the owning bot, so neither the application nor a
-- future ingestion path can insert a row into the wrong tenant.
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

drop trigger if exists trg_documents_org on documents;
create trigger trg_documents_org
  before insert on documents
  for each row execute function public.set_org_from_bot_row();

drop trigger if exists trg_chunks_org on chunks;
create trigger trg_chunks_org
  before insert on chunks
  for each row execute function public.set_org_from_bot_row();


-- ----------------------------------------------------------------
-- Per-tenant retrieval settings
--   { "top_k": 5, "min_similarity": 0.3,
--     "chunk_size": 800, "chunk_overlap": 120, "enabled": true }
-- ----------------------------------------------------------------
alter table bots add column if not exists rag_config jsonb;

do $$
begin
  alter table bots add constraint bots_rag_config_object
    check (rag_config is null or jsonb_typeof(rag_config) = 'object');
exception when duplicate_object then null;
end $$;


-- ----------------------------------------------------------------
-- match_chunks — vector search
--
-- Deliberately NOT security definer. The chat path calls this as
-- service_role (which bypasses RLS anyway) and the tenant filter is
-- the mandatory p_bot_id argument; the dashboard calls it as the end
-- user, where RLS narrows it further. Making it definer would strip
-- that second layer for no benefit.
--
-- p_bot_id has no default on purpose — a caller cannot forget it.
-- ----------------------------------------------------------------
create or replace function public.match_chunks(
  p_bot_id         uuid,
  p_query          vector(768),
  p_match_count    integer default 5,
  p_min_similarity double precision default 0.0
)
returns table (
  id          uuid,
  document_id uuid,
  ordinal     integer,
  content     text,
  similarity  double precision
)
language sql
stable
set search_path = public
as $$
  select c.id,
         c.document_id,
         c.ordinal,
         c.content,
         1 - (c.embedding <=> p_query) as similarity
    from public.chunks c
   where c.bot_id = p_bot_id
     and c.embedding is not null
     and 1 - (c.embedding <=> p_query) >= p_min_similarity
   order by c.embedding <=> p_query
   limit greatest(p_match_count, 0);
$$;

grant execute on function public.match_chunks(uuid, vector, integer, double precision)
  to authenticated, service_role;


-- ----------------------------------------------------------------
-- RLS
-- ----------------------------------------------------------------
alter table documents enable row level security;
alter table chunks    enable row level security;

drop policy if exists documents_select on documents;
drop policy if exists documents_write  on documents;
drop policy if exists chunks_select    on chunks;

create policy documents_select on documents
  for select to authenticated
  using (org_id in (select public.user_org_ids()));

-- Tenants create and delete their own sources; the ingestion pipeline
-- runs as service_role and is unaffected by these.
create policy documents_write on documents
  for all to authenticated
  using      (public.user_can_write(org_id))
  with check (public.user_can_write(org_id));

-- Chunks are derived data: readable for the dashboard's chunk
-- inspector, never written by a tenant.
create policy chunks_select on chunks
  for select to authenticated
  using (org_id in (select public.user_org_ids()));


-- ----------------------------------------------------------------
-- Grants
-- ----------------------------------------------------------------
revoke all on documents, chunks from anon;

grant select, insert, update, delete on documents to authenticated;
grant select                        on chunks    to authenticated;
grant all on documents, chunks to service_role;
