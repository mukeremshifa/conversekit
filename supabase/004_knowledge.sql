-- ================================================================
-- ConverseKit — the knowledge corpus
--
-- documents → chunks is the ingestion pipeline; faq_items is a nicer
-- editor over a source WITHIN that pipeline rather than a second one.
-- That is the load-bearing decision in this file: FAQ items hang off a
-- synthetic `documents` row, so they inherit status, error, chunk_count,
-- the reindex endpoint, the chunk inspector, citations and ON DELETE
-- CASCADE unchanged. Building a second ingestion state machine for FAQs
-- is the mistake that avoids.
--
-- EMBEDDING WIDTH IS FIXED PLATFORM-WIDE AT 768, and a pgvector column
-- has a fixed dimension, so this is a one-way door per deployment:
-- changing it means re-embedding every chunk. 768 because every vendor
-- in the catalog can produce it — Gemini and OpenAI by truncation, and
-- bge-base, nomic-embed and mistral-embed natively. 1536 would have
-- locked out every local model.
-- ================================================================


-- ----------------------------------------------------------------
-- documents — one row per ingested source
-- ----------------------------------------------------------------
create table if not exists documents (
  id            uuid        primary key default gen_random_uuid(),
  bot_id        uuid        not null references bots(id)          on delete cascade,
  org_id        uuid        not null references organizations(id) on delete cascade,
  source        text        not null check (source in ('text', 'url', 'markdown', 'file', 'faq')),
  title         text        not null check (length(btrim(title)) between 1 and 300),
  url           text,
  -- Extracted plain text, kept so a document can be re-chunked with
  -- different settings — or re-extracted once the converter improves —
  -- without re-fetching the original.
  content       text,
  status        text        not null default 'pending'
                            check (status in ('pending', 'processing', 'ready', 'failed')),
  error         text,
  chunk_count   integer     not null default 0,
  embedding_model      text,
  embedding_dimensions integer,

  -- ── Uploaded files ────────────────────────────────────────────
  --
  -- The bytes live in R2, not here. These three record where, what and
  -- how big — enough to re-extract without re-uploading, and enough to
  -- charge a tenant's storage against a cap.
  --
  -- No NOT NULL and no cross-column CHECK tying r2_key to
  -- source = 'file'. The Worker is the only writer, and a constraint
  -- that can only fire on a Worker bug would surface as an opaque
  -- PostgREST error at the least helpful moment.
  r2_key        text,
  mime_type     text,
  size_bytes    integer     check (size_bytes is null or size_bytes >= 0),

  -- ── The re-index claim ────────────────────────────────────────
  --
  -- Not another `status` value, because it answers a different
  -- question. `status` is what the tenant sees; this is whether a run
  -- currently owns the document. Two reindex clicks used to interleave
  -- delete-then-insert, and the loser marked the document `failed`
  -- while the winner's chunks sat there indexed and working — a red row
  -- on a document that is fine, whose natural response is to click
  -- reindex again.
  --
  -- The compare-and-set is a single conditional UPDATE from the Worker
  -- (claimDocument), so it is atomic in Postgres. A claim older than
  -- the Worker's stale window is treated as abandoned, because a Worker
  -- can die mid-waitUntil with no chance to release.
  ingest_started_at timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on column documents.r2_key is
  'Object key in the DOCS R2 bucket. Null for non-file sources.';
comment on column documents.ingest_started_at is
  'Non-null while an ingest run holds this document. Claimed by conditional UPDATE, released on success and on failure. A stale claim is reclaimable — see src/rag/ingest.ts.';

create index if not exists idx_documents_bot on documents(bot_id, created_at desc);
create index if not exists idx_documents_org on documents(org_id);

-- One document per stored object. Catches a double-submit that would
-- otherwise index the same upload twice and double its retrieval
-- weight; also stops a crafted insert from pointing a second document
-- row at another tenant's object.
create unique index if not exists idx_documents_r2_key
  on documents(r2_key) where r2_key is not null;

-- At most one FAQ document per bot, for the same reason: a
-- double-submitted cutover would otherwise leave two, both indexed,
-- both retrievable, doubling the weight of every FAQ answer.
create unique index if not exists idx_documents_faq_one
  on documents(bot_id) where source = 'faq';


-- ----------------------------------------------------------------
-- chunks — the retrieval unit
--
-- bot_id and org_id are denormalised deliberately. bot_id is the
-- retrieval filter and must be indexable alongside the vector; org_id
-- carries the RLS predicate so the policy is the same one-liner used
-- everywhere else rather than a join through documents → bots. Both are
-- set by trigger, never by the application.
-- ----------------------------------------------------------------
create table if not exists chunks (
  id          uuid        primary key default gen_random_uuid(),
  document_id uuid        not null references documents(id)     on delete cascade,
  bot_id      uuid        not null references bots(id)          on delete cascade,
  org_id      uuid        not null references organizations(id) on delete cascade,
  ordinal     integer     not null,
  content     text        not null,
  embedding   vector(768),

  -- Content shape. Set by ingestion, never by a tenant — chunks are
  -- derived data and the RLS policy below keeps them so.
  kind        text        not null default 'prose' check (kind in ('prose', 'faq')),

  -- 0 normal, 1 boosted, 2 pinned. FAQ chunks ingest at 1.
  --
  -- Boost applies to ORDERING only (see match_chunks in 005): the
  -- similarity floor still tests the raw score, so a boosted chunk wins
  -- ties and near-ties but can never smuggle an irrelevant chunk into
  -- the prompt. 2 is reserved — nothing writes it, and a pin is a
  -- different feature with a different failure mode.
  priority    smallint    not null default 0 check (priority between 0 and 2),

  -- Carries faq_item_id today; page numbers, section headings and
  -- source anchors are the obvious next tenants.
  metadata    jsonb       check (metadata is null or jsonb_typeof(metadata) = 'object'),

  -- ── The lexical channel ───────────────────────────────────────
  --
  -- 'simple', NOT 'english'. This platform is explicitly multilingual —
  -- the system prompt tells the model to reply in the visitor's own
  -- language — and an English stemmer applied to Turkish or Amharic is
  -- worse than no stemmer at all: it mangles tokens it does not
  -- understand and produces confident nonsense. 'simple' lowercases and
  -- splits, nothing more, and works the same everywhere.
  --
  -- The two-argument to_tsvector is required rather than merely
  -- preferred: the one-argument form reads default_text_search_config
  -- and is therefore only STABLE, which a generated column will not
  -- accept.
  search      tsvector    generated always as (to_tsvector('simple', content)) stored,

  created_at  timestamptz not null default now(),
  unique (document_id, ordinal)
);

comment on column chunks.kind is
  'Content shape: prose | faq. Lets retrieval weight and explain by source type.';
comment on column chunks.priority is
  'Retrieval boost level: 0 normal, 1 boosted (FAQ), 2 pinned (reserved). Ordering only — never bypasses the similarity floor.';

create index if not exists idx_chunks_bot on chunks(bot_id);

-- HNSW over cosine distance. Built with the table so an empty index is
-- cheap; pgvector fills it incrementally on insert.
create index if not exists idx_chunks_embedding
  on chunks using hnsw (embedding vector_cosine_ops);

-- Over the whole table, not just the boosted rows the fallback channel
-- reads, so hybrid search is a scoring change rather than a migration.
create index if not exists idx_chunks_search on chunks using gin (search);


-- ----------------------------------------------------------------
-- faq_items — one question, one answer, one row
--
-- Rows rather than a parsed text blob. The cheaper schema would be a
-- single document holding `Q: … / A: …` text with a Q&A-aware chunker
-- reading it, but per-item edit, reorder and disable are exactly what a
-- tenant does with an FAQ, and every one of those becomes string
-- surgery — plus the first tenant who writes "Q:" inside an answer
-- corrupts their own FAQ.
--
-- No per-bot item cap here, unlike the storage cap below. That one
-- guards a shared bucket one tenant could fill; this would guard
-- nothing but the tenant's own embedding spend, and RLS already means
-- only their own members can write it. src/config.ts caps it at 200 for
-- the sake of the error message.
-- ----------------------------------------------------------------
create table if not exists faq_items (
  id          uuid        primary key default gen_random_uuid(),
  bot_id      uuid        not null references bots(id)          on delete cascade,
  org_id      uuid        not null references organizations(id) on delete cascade,
  -- NOT NULL on purpose: this is what makes an FAQ a source within the
  -- one pipeline rather than a second pipeline.
  document_id uuid        not null references documents(id)     on delete cascade,
  question    text        not null check (length(btrim(question)) between 1 and 300),
  answer      text        not null check (length(btrim(answer))  between 1 and 2000),
  -- Sparse and rewritten wholesale on reorder. Not unique: a reorder
  -- that had to stay unique at every intermediate step would need a
  -- temporary offset pass, which is a transaction to buy nothing.
  position    integer     not null default 0,
  -- Disabled items stay editable and stop being embedded. A tenant
  -- taking an answer down usually wants it back next week.
  enabled     boolean     not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_faq_items_bot on faq_items(bot_id, position);
create index if not exists idx_faq_items_doc on faq_items(document_id);
create index if not exists idx_faq_items_org on faq_items(org_id);

-- gin_trgm_ops is what makes the `%` operator indexable, which is what
-- lets match_faq_items in 005 threshold on a normalised 0-1 score.
create index if not exists idx_faq_items_question_trgm
  on faq_items using gin (question gin_trgm_ops);


-- ----------------------------------------------------------------
-- Tenancy derivation
--
-- Same trigger on all three: org_id comes from the bot, never from the
-- caller. See public.set_org_from_bot_row in 002_bots.sql.
-- ----------------------------------------------------------------
drop trigger if exists trg_documents_org on documents;
create trigger trg_documents_org
  before insert on documents
  for each row execute function public.set_org_from_bot_row();

drop trigger if exists trg_chunks_org on chunks;
create trigger trg_chunks_org
  before insert on chunks
  for each row execute function public.set_org_from_bot_row();

drop trigger if exists trg_faq_items_org on faq_items;
create trigger trg_faq_items_org
  before insert on faq_items
  for each row execute function public.set_org_from_bot_row();


-- ----------------------------------------------------------------
-- Per-org storage cap
--
-- One tenant must not be able to fill the bucket. Enforced here rather
-- than only in the Worker because the Worker's check is advisory — it
-- races against concurrent uploads and is bypassed entirely by anything
-- talking to PostgREST directly. The Worker still checks first, so the
-- common case gets a readable 413 instead of a constraint violation;
-- this is the backstop.
--
-- MIRRORED BY src/entitlements.ts, which reads the same number as an
-- entitlement. When plans start to differ here, v_cap has to learn to
-- read organizations.plan too.
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

create or replace function public.enforce_org_storage_cap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  -- 100 MB per organization. Ten times the Worker's 10 MB per-file
  -- ceiling, so a tenant gets a useful corpus before hitting it.
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
-- derives new.org_id from the bot, and this one reads it. Postgres runs
-- BEFORE triggers in NAME ORDER, and 'trg_documents_org' sorts before
-- 'trg_documents_storage_cap'. Renaming either breaks the cap silently
-- — it would compare against a null org.
drop trigger if exists trg_documents_storage_cap on documents;
create trigger trg_documents_storage_cap
  before insert on documents
  for each row execute function public.enforce_org_storage_cap();


-- ----------------------------------------------------------------
-- bots.chunk_count — the corpus probe that costs nothing
--
-- THE OBVIOUS FOLD IS THE WRONG ONE, and it is worth recording where
-- someone will find it. Deriving "has a corpus" from whether
-- match_chunks returned rows collapses two states that have to stay
-- distinct. src/index.ts computes
--
--     missedRetrieval = hasCorpus and not staleIndex and rendered = 0
--
-- so making hasCorpus mean `rows > 0` turns that into
-- `(rows > 0) and (rendered = 0)` — true only when the context budget
-- dropped everything. fallback_message, escalate_after_misses and
-- lexical_fallback all go dead. It would also cost an embedding call
-- per turn for bots with NO corpus, which is the one case the probe
-- exists to make free.
--
-- STATEMENT-LEVEL, NOT ROW-LEVEL. replaceChunks is delete-then-insert
-- of up to 400 rows per document; a per-row trigger would fire 800
-- times per ingest to compute a number that only has to be right at the
-- end. This fires twice, and recomputes only the bots the statement
-- actually touched.
-- ----------------------------------------------------------------
create or replace function public.recount_bot_chunks()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- RECOMPUTED rather than incremented by a delta: a delta is a second
  -- source of truth that drifts the first time a statement does
  -- something unexpected, and this runs a handful of times per ingest.
  update public.bots b
     set chunk_count = coalesce(
           (select count(*) from public.chunks c where c.bot_id = b.id), 0)
   where b.id in (select distinct bot_id from touched);
  return null;
end;
$fn$;

drop trigger if exists trg_chunks_count_ins on chunks;
create trigger trg_chunks_count_ins
  after insert on chunks
  referencing new table as touched
  for each statement execute function public.recount_bot_chunks();

drop trigger if exists trg_chunks_count_del on chunks;
create trigger trg_chunks_count_del
  after delete on chunks
  referencing old table as touched
  for each statement execute function public.recount_bot_chunks();

-- An UPDATE cannot move a chunk between bots today — chunks are
-- replaced, never reassigned — but a future migration that did would
-- leave both counts wrong with nothing to say so. Two triggers, because
-- one statement-level trigger may reference only one transition table
-- and both the old and the new bot need recounting.
drop trigger if exists trg_chunks_count_upd_new on chunks;
create trigger trg_chunks_count_upd_new
  after update on chunks
  referencing new table as touched
  for each statement execute function public.recount_bot_chunks();

drop trigger if exists trg_chunks_count_upd_old on chunks;
create trigger trg_chunks_count_upd_old
  after update on chunks
  referencing old table as touched
  for each statement execute function public.recount_bot_chunks();


-- ----------------------------------------------------------------
-- RLS and grants
--
-- documents and faq_items are TENANT-WRITTEN: the Sources screen and
-- the FAQ editor are the whole point of them, so both get the
-- select + write pair. chunks are DERIVED: readable for the dashboard's
-- chunk inspector, never written by a tenant. The ingestion pipeline
-- runs as service_role and is unaffected by any of these.
-- ----------------------------------------------------------------
alter table documents enable row level security;
alter table chunks    enable row level security;
alter table faq_items enable row level security;

drop policy if exists documents_select on documents;
drop policy if exists documents_write  on documents;
drop policy if exists chunks_select    on chunks;
drop policy if exists faq_items_select on faq_items;
drop policy if exists faq_items_write  on faq_items;

create policy documents_select on documents
  for select to authenticated
  using (org_id in (select public.user_org_ids()));

create policy documents_write on documents
  for all to authenticated
  using      (public.user_can_write(org_id))
  with check (public.user_can_write(org_id));

create policy chunks_select on chunks
  for select to authenticated
  using (org_id in (select public.user_org_ids()));

create policy faq_items_select on faq_items
  for select to authenticated
  using (org_id in (select public.user_org_ids()));

create policy faq_items_write on faq_items
  for all to authenticated
  using      (public.user_can_write(org_id))
  with check (public.user_can_write(org_id));

revoke all on documents, chunks, faq_items from anon;

grant select, insert, update, delete on documents to authenticated;
grant select, insert, update, delete on faq_items to authenticated;
grant select                        on chunks    to authenticated;
grant all on documents, chunks, faq_items to service_role;
