-- ================================================================
-- ConverseKit — Knowledge pipeline unification
-- Run in the Supabase SQL Editor after 010_lead_capture.sql
--
-- Additive and safe to re-run. Nothing here changes behaviour on its
-- own: every column is nullable or defaulted, and the cutover that
-- actually moves a bot's FAQ out of the system prompt is gated on
-- bots.knowledge_migrated_at, which this migration only ever leaves
-- NULL. See docs/knowledge-pipeline.md.
--
-- WHAT THIS IS FOR. Until now a bot had two knowledge systems that did
-- not know about each other: four uncapped text columns inlined into
-- every system prompt, and a documents → chunks → match_chunks
-- pipeline that never saw them. A tenant who uploaded their FAQ as a
-- PDF *and* filled in the FAQ box shipped it twice, once always and
-- once by similarity, with nothing reconciling the two.
--
-- Folding the FAQ into retrieval is only safe if retrieval has a floor
-- of guarantee, because today the FAQ is always in the prompt and
-- afterwards it would be a dice roll. That floor is the two mechanisms
-- at the bottom of this file — a priority boost inside match_chunks,
-- and a lexical channel that runs when the vector search finds nothing.
--
-- ORDER MATTERS. Deploy this BEFORE the Worker. match_chunks changes
-- signature below, and scripts/migrate.mjs's own header records what
-- happened the last time a Worker went out ahead of its schema.
-- ================================================================


-- ----------------------------------------------------------------
-- chunks gains the columns every future retrieval change needs
--
-- This is the load-bearing part of the migration. The `metadata jsonb`
-- the roadmap specified in Phase 2 never landed, and neither did
-- anything else that would let retrieval weight, filter or explain by
-- what a chunk actually is. Adding them while the table is small is an
-- ALTER; adding them once a deployment has a real corpus is a re-embed.
-- ----------------------------------------------------------------

-- 'prose' | 'faq', extensible. Set by ingestion, never by a tenant —
-- chunks are derived data and the RLS policy below keeps them so.
alter table chunks add column if not exists kind text not null default 'prose';

do $$
begin
  alter table chunks add constraint chunks_kind_check
    check (kind in ('prose', 'faq'));
exception when duplicate_object then null;
end $$;

-- 0 normal, 1 boosted, 2 pinned. FAQ chunks ingest at 1.
--
-- Boost applies to ORDERING only (see match_chunks): the similarity
-- floor still tests the raw score, so a boosted chunk wins ties and
-- near-ties but can never smuggle an irrelevant chunk into the prompt.
-- 2 is reserved — nothing writes it yet, and a pin is a different
-- feature with a different failure mode.
alter table chunks add column if not exists priority smallint not null default 0;

do $$
begin
  alter table chunks add constraint chunks_priority_check
    check (priority between 0 and 2);
exception when duplicate_object then null;
end $$;

-- Carries faq_item_id today; page numbers, section headings and source
-- anchors are the obvious next tenants.
alter table chunks add column if not exists metadata jsonb;

do $$
begin
  alter table chunks add constraint chunks_metadata_object
    check (metadata is null or jsonb_typeof(metadata) = 'object');
exception when duplicate_object then null;
end $$;

-- ----------------------------------------------------------------
-- The lexical channel
--
-- 'simple', NOT 'english'. This platform is explicitly multilingual —
-- the system prompt tells the model to reply in the visitor's own
-- language — and an English stemmer applied to Turkish or Amharic is
-- worse than no stemmer at all: it mangles tokens it does not
-- understand and produces confident nonsense. 'simple' lowercases and
-- splits, nothing more, and works the same everywhere.
--
-- The two-argument to_tsvector is required here rather than merely
-- preferred: the one-argument form reads default_text_search_config
-- and is therefore only STABLE, which a generated column will not
-- accept.
--
-- The index is over the whole table, not just the boosted rows the
-- fallback currently reads. It is deliberately sized for what comes
-- next: with this in place, full hybrid search with reciprocal-rank
-- fusion is a scoring change rather than another migration.
-- ----------------------------------------------------------------
alter table chunks add column if not exists search tsvector
  generated always as (to_tsvector('simple', content)) stored;

create index if not exists idx_chunks_search on chunks using gin (search);

comment on column chunks.kind is
  'Content shape: prose | faq. Lets retrieval weight and explain by source type.';
comment on column chunks.priority is
  'Retrieval boost level: 0 normal, 1 boosted (FAQ), 2 pinned (reserved). Ordering only — never bypasses the similarity floor.';


-- ----------------------------------------------------------------
-- documents.source gains 'faq'
--
-- The constraint was created inline in 005_rag.sql, so Postgres named
-- it documents_source_check. Dropped and recreated rather than altered
-- because Postgres has no ALTER CONSTRAINT for a CHECK — the same
-- dance 008_files.sql did to add 'file'.
-- ----------------------------------------------------------------
alter table documents drop constraint if exists documents_source_check;

alter table documents add constraint documents_source_check
  check (source in ('text', 'url', 'markdown', 'file', 'faq'));

-- At most one FAQ document per bot. Without this a double-submitted
-- cutover leaves two, both indexed, both retrievable, doubling the
-- weight of every FAQ answer — the same failure idx_documents_r2_key
-- exists to prevent for uploads.
create unique index if not exists idx_documents_faq_one
  on documents(bot_id) where source = 'faq';


-- ----------------------------------------------------------------
-- faq_items — one question, one answer, one row
--
-- Rows rather than a parsed text blob. The cheaper schema would be a
-- single document holding `Q: … / A: …` text with a Q&A-aware chunker
-- reading it, but per-item edit, reorder and disable are exactly what
-- a tenant does with an FAQ, and every one of those becomes string
-- surgery — plus the first tenant who writes "Q:" inside an answer
-- corrupts their own FAQ.
--
-- document_id is NOT NULL on purpose. Items hang off a synthetic
-- documents row so they inherit status, error, chunk_count, the
-- reindex endpoint, the chunk inspector, citations and ON DELETE
-- CASCADE unchanged. Building a second ingestion state machine for
-- FAQs is the mistake this avoids: the pipeline stays one pipeline,
-- and the FAQ is a source within it that happens to have a nicer
-- editor.
--
-- No per-bot item cap enforced here, unlike the storage cap in 008.
-- That one guards a shared bucket one tenant could fill; this one
-- guards nothing but the tenant's own embedding spend, and RLS already
-- means only their own members can write it. The Worker caps it at 200
-- (src/config.ts) for the error message.
-- ----------------------------------------------------------------
create table if not exists faq_items (
  id          uuid        primary key default gen_random_uuid(),
  bot_id      uuid        not null references bots(id)          on delete cascade,
  org_id      uuid        not null references organizations(id) on delete cascade,
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

-- Same derivation as documents and chunks: org_id comes from the bot,
-- never from the caller. See 005_rag.sql.
drop trigger if exists trg_faq_items_org on faq_items;
create trigger trg_faq_items_org
  before insert on faq_items
  for each row execute function public.set_org_from_bot_row();


-- ----------------------------------------------------------------
-- bots.knowledge_migrated_at — the per-bot cutover flag
--
-- The largest risk in this whole change is a bot ending up with
-- neither a prompt FAQ nor an indexed one, and this column is the
-- entire mitigation.
--
-- While it is NULL, buildSystemPrompt emits ## Services and
-- ## Frequently Asked Questions exactly as it does today, byte for
-- byte — scripts/test-knowledge-units.mjs asserts that as a string
-- comparison, the same way scripts/test-lead-capture.mjs pins the lead
-- block.
--
-- This migration cannot fill it, and does not try. SQL cannot call an
-- embedding vendor, so the backfill is a Worker endpoint that creates
-- the documents and items, ingests them, and stamps this column ONLY
-- on success. A failure leaves it NULL and the old prompt intact.
--
-- Setting it back to NULL reverts, with the now-redundant chunks
-- sitting harmlessly in the corpus. That is the point.
-- ----------------------------------------------------------------
alter table bots add column if not exists knowledge_migrated_at timestamptz;

comment on column bots.knowledge_migrated_at is
  'NULL = services and faq are still inlined into the system prompt. Stamped only after a successful ingest of both into the corpus. Null it to revert.';


-- ----------------------------------------------------------------
-- Caps on what is left in the prompt
--
-- These two columns are the only tenant-authored text still inlined on
-- every turn, and both were plain unbounded `text`. A tenant who
-- pasted 40 KB shipped 40 KB on every message, forever, crowding out
-- the retrieved chunks and the conversation history alike.
--
-- NOT VALID deliberately: it guards every new write while leaving a
-- legacy over-length row alone, rather than failing the migration on
-- content someone already saved. src/config.ts truncates on write and
-- is the authority; this is the backstop for anything reaching
-- PostgREST directly.
-- ----------------------------------------------------------------
do $$
begin
  alter table bots add constraint bots_business_description_len
    check (business_description is null or length(business_description) <= 600) not valid;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table bots add constraint bots_custom_instructions_len
    check (custom_instructions is null or length(custom_instructions) <= 2000) not valid;
exception when duplicate_object then null;
end $$;


-- ----------------------------------------------------------------
-- match_chunks — vector search, now with a priority boost
--
-- DROPPED AND RECREATED, not `create or replace`. Replacing cannot add
-- a parameter — it creates an overload instead — and two overloads
-- whose extra arguments all have defaults make the four-argument call
-- ambiguous, so the old Worker would start failing with
-- "function is not unique" rather than falling back cleanly.
--
-- The two-phase shape is not decoration. Ordering by
-- `similarity + boost` directly would be unindexable and throw away the
-- HNSW index, so the inner query takes the nearest candidates in index
-- order and the outer one re-ranks that pool. Filtering on similarity
-- after the limit is exactly equivalent to filtering before it, because
-- similarity decreases monotonically with distance: if the Nth-nearest
-- row fails the floor, so does everything behind it.
--
-- Still deliberately NOT security definer, for the reason 005 gave: the
-- chat path calls this as service_role and the tenant filter is the
-- mandatory p_bot_id argument, while the dashboard calls it as the end
-- user where RLS narrows it further. Definer would strip that second
-- layer for no benefit.
-- ----------------------------------------------------------------
drop function if exists public.match_chunks(uuid, vector, integer, double precision);

-- `or replace` on the NEW signature, so re-running this file is a
-- no-op rather than a "function already exists". The drop above is
-- what removes the old four-argument one; leaving both would make the
-- four-argument call ambiguous, since every extra argument has a
-- default.
create or replace function public.match_chunks(
  p_bot_id         uuid,
  p_query          vector(768),
  p_match_count    integer default 5,
  p_min_similarity double precision default 0.0,
  p_priority_boost double precision default 0.0
)
returns table (
  id          uuid,
  document_id uuid,
  ordinal     integer,
  content     text,
  similarity  double precision,
  kind        text,
  priority    smallint
)
language sql
stable
set search_path = public
as $$
  with candidates as (
    select c.id,
           c.document_id,
           c.ordinal,
           c.content,
           c.kind,
           c.priority,
           1 - (c.embedding <=> p_query) as similarity
      from public.chunks c
     where c.bot_id = p_bot_id
       and c.embedding is not null
     -- Over-fetch so the re-rank below has something to reorder. Deep
     -- enough that a boosted chunk sitting just outside the top k is
     -- still reachable, shallow enough to stay one index probe.
     order by c.embedding <=> p_query
     limit greatest(p_match_count, 0) * 4 + 10
  )
  select id, document_id, ordinal, content, similarity, kind, priority
    from candidates
   where similarity >= p_min_similarity
   order by similarity + (priority * coalesce(p_priority_boost, 0)) desc
   limit greatest(p_match_count, 0);
$$;

grant execute on function public.match_chunks(uuid, vector, integer, double precision, double precision)
  to authenticated, service_role;


-- ----------------------------------------------------------------
-- match_chunks_lexical — the fallback channel
--
-- Runs ONLY when the vector search returned nothing at all, so it
-- costs one query on the miss path and nothing on the happy path. What
-- it buys is the case similarity handles worst: a visitor typing
-- "do u take insurance" against a curated FAQ entry that says exactly
-- that in different words, where the embedding rolls badly and the
-- floor rejects a genuine match.
--
-- Restricted to priority > 0 — that is, to the FAQ. Keyword matching
-- across a hundred-page PDF drags out passages that share a word and
-- nothing else, which is precisely the noise the similarity floor
-- exists to keep out. The curated, hand-written rows are the ones
-- worth rescuing this way.
--
-- THE QUERY IS OR-ED, NOT AND-ED, AND THAT IS THE WHOLE DESIGN.
--
-- websearch_to_tsquery and plainto_tsquery both AND their terms, and
-- under the 'simple' config nothing is dropped as a stopword — so
-- "do u take insurance" would require *u* and *take* to appear
-- literally, and would find nothing at all in "Do you accept
-- insurance?". That is precisely the query this function exists to
-- rescue, so ANDing makes it useless in its only use case.
--
-- OR alone is too loose the other way: one shared common word would
-- match anything. The refinement is an overlap test — at least half
-- the distinct lexemes a visitor typed must appear in the chunk —
-- which rejects an FAQ entry that merely shares the word "do" while
-- accepting one that shares "do" and "insurance" out of four. Results
-- are ordered by that overlap first and ts_rank_cd second, because
-- "how many of your words are in here" is both more interpretable and
-- more stable than a rank score on chunks this short.
--
-- The @@ against the OR-ed tsquery stays as the leading predicate so
-- the GIN index still does the prefiltering; the overlap count then
-- refines what survives, over a candidate set already narrowed to one
-- bot's boosted chunks.
--
-- NOTE ON `similarity`: it is a ts_rank_cd score here, NOT a cosine
-- similarity, and the two are not on the same scale. The column keeps
-- its name so callers need one row shape; the Worker reports which
-- channel a chunk came from rather than pretending the numbers are
-- comparable.
-- ----------------------------------------------------------------
create or replace function public.match_chunks_lexical(
  p_bot_id      uuid,
  p_query_text  text,
  p_match_count integer default 5
)
returns table (
  id          uuid,
  document_id uuid,
  ordinal     integer,
  content     text,
  similarity  double precision,
  kind        text,
  priority    smallint
)
language sql
stable
set search_path = public
as $$
  with q as (
    -- The visitor's message reduced to distinct lexemes by the SAME
    -- config the generated column uses, so the two are comparable
    -- without any second normalisation to keep in step.
    select array_agg(distinct lexeme) as lex
      from unnest(to_tsvector('simple', coalesce(p_query_text, '')))
  ),
  tq as (
    select lex,
           coalesce(cardinality(lex), 0) as n,
           case
             when lex is null or cardinality(lex) = 0 then null
             -- quote_literal per lexeme: a token containing an
             -- apostrophe or an operator character would otherwise be
             -- a tsquery syntax error on text a visitor merely typed.
             else to_tsquery('simple',
                    (select string_agg(quote_literal(t), ' | ') from unnest(lex) as t))
           end as tsq
      from q
  )
  select c.id,
         c.document_id,
         c.ordinal,
         c.content,
         ts_rank_cd(c.search, tq.tsq)::double precision as similarity,
         c.kind,
         c.priority
    from public.chunks c
    cross join tq
    cross join lateral (
      select count(*)::int as hits
        from unnest(c.search) as cs(lexeme, positions, weights)
       where cs.lexeme = any (tq.lex)
    ) ov
   where tq.tsq is not null
     and c.bot_id = p_bot_id
     and c.priority > 0
     and c.search @@ tq.tsq
     and ov.hits * 2 >= tq.n
   order by ov.hits desc,
            ts_rank_cd(c.search, tq.tsq) desc,
            c.priority desc,
            c.ordinal asc
   limit greatest(p_match_count, 0);
$$;

grant execute on function public.match_chunks_lexical(uuid, text, integer)
  to authenticated, service_role;


-- ----------------------------------------------------------------
-- RLS — faq_items mirrors documents exactly
--
-- Unlike chunks, these ARE tenant-written: the FAQ editor is the whole
-- point of the table. So it gets documents' pair of policies, not
-- chunks' read-only one.
-- ----------------------------------------------------------------
alter table faq_items enable row level security;

drop policy if exists faq_items_select on faq_items;
drop policy if exists faq_items_write  on faq_items;

create policy faq_items_select on faq_items
  for select to authenticated
  using (org_id in (select public.user_org_ids()));

create policy faq_items_write on faq_items
  for all to authenticated
  using      (public.user_can_write(org_id))
  with check (public.user_can_write(org_id));

revoke all on faq_items from anon;
grant select, insert, update, delete on faq_items to authenticated;
grant all on faq_items to service_role;
