-- ================================================================
-- ConverseKit — Retrieval observability
-- Run in the Supabase SQL Editor after 011_knowledge.sql
--
-- Additive and safe to re-run. Every column added below is nullable or
-- defaulted, and the one backfill only ever fills a NULL.
--
-- WHAT THIS IS FOR. 011 gave retrieval two channels and a floor that
-- can actually reject; docs/rag-hardening.md then found that nothing
-- observes any of it. Every claim in that audit needed a hand-written
-- query against a table that happened to be small, and the tenant sees
-- nothing at all. This migration is the schema half of fixing that:
--
--   retrieval_log             what was asked, and whether the bot could
--                             answer it (M1)
--   bots.embedding_model_indexed
--                             the model the corpus was last built with,
--                             so a vendor switch can be detected rather
--                             than silently poisoning every answer (B2)
--   documents.ingest_started_at
--                             a claim, so two reindex clicks cannot
--                             leave a working document marked failed (B4)
--
-- and, because both retrieval RPCs have to be recreated anyway to add
-- the document title, it also carries S1's `hnsw.ef_search` and the S2
-- title fold that B6 promised "in the next migration".
--
-- ORDER MATTERS. Deploy this BEFORE the Worker. Both RPCs gain a column
-- in their return type, which `create or replace` cannot do — so they
-- are dropped and recreated. An OLD Worker against these NEW functions
-- is safe (PostgREST returns the extra column and the Worker ignores
-- it), so the window is one-directional: schema first, always.
-- ================================================================


-- ----------------------------------------------------------------
-- retrieval_log — one row per turn where retrieval actually ran
--
-- THE QUERY IS STORED VERBATIM, and that is a deliberate decision
-- rather than an oversight. The whole value of this table is the
-- tenant-facing report "here are the questions your bot could not
-- answer" — a normalised or hashed query cannot be read back, and a
-- report of question *shapes* tells nobody what to write next. The
-- conversations table already holds the same text (it holds the whole
-- transcript), so this adds a retention surface rather than a new class
-- of data. See docs/tenancy.md for the retention rules.
--
-- Rows are written for HITS TOO, not just misses. A miss-only table has
-- rows but no denominator: no miss rate, and no score distribution to
-- tune a floor against — which is exactly the trap B1 fell into, where
-- a floor that could never reject looked like it worked for months.
--
-- `matched` is "was the model shown anything from this business's own
-- material", the same statement missedRetrieval makes in the Worker.
-- `channel` says which search produced it, and is NULL on a miss.
-- `top_score` is a cosine similarity when channel = 'vector' and a
-- ts_rank_cd score when channel = 'lexical'; the two are NOT on the
-- same scale, which is why the channel is stored beside it.
-- ----------------------------------------------------------------
create table if not exists retrieval_log (
  id              uuid        primary key default gen_random_uuid(),
  bot_id          uuid        not null references bots(id)          on delete cascade,
  org_id          uuid        not null references organizations(id) on delete cascade,
  -- Nullable: preview traffic has no real session, and a row is worth
  -- keeping even when it cannot be tied to a conversation.
  session_id      text,
  query           text        not null,
  -- Did the model get shown anything at all.
  matched         boolean     not null,
  -- 'vector' | 'lexical' | null. Deliberately not a CHECK constraint:
  -- a third channel (hybrid/RRF is the obvious next one) should not
  -- need a migration to start recording itself.
  channel         text,
  top_score       double precision,
  chunk_count     integer     not null default 0,
  -- The floor THAT RAN, not the platform default — it is resolved from
  -- the embedding model, so recording it is what makes a stored score
  -- interpretable months later.
  min_similarity  double precision,
  embedding_model text,
  created_at      timestamptz not null default now()
);

-- The report reads one bot's recent rows and nothing else, so this is
-- the only index it needs. `created_at desc` matches the query order.
create index if not exists idx_retrieval_log_bot
  on retrieval_log(bot_id, created_at desc);

-- Same derivation as documents, chunks and faq_items: org_id comes from
-- the bot, never from the caller. See 005_rag.sql.
drop trigger if exists trg_retrieval_log_org on retrieval_log;
create trigger trg_retrieval_log_org
  before insert on retrieval_log
  for each row execute function public.set_org_from_bot_row();

comment on table retrieval_log is
  'One row per chat turn where retrieval ran. Visitor query stored verbatim; pruned by prune_retrieval_log() on a daily cron. See docs/tenancy.md.';
comment on column retrieval_log.top_score is
  'Cosine similarity when channel = vector, ts_rank_cd when channel = lexical. Not comparable across channels.';


-- ----------------------------------------------------------------
-- RLS — mirrors chunks, NOT documents
--
-- Select for members of the owning org, and no tenant write policy at
-- all. This is derived data: the Worker writes it with the service
-- role, and a tenant forging their own miss report is not a state worth
-- allowing. Same reasoning as chunks in 005_rag.sql.
-- ----------------------------------------------------------------
alter table retrieval_log enable row level security;

drop policy if exists retrieval_log_select on retrieval_log;

create policy retrieval_log_select on retrieval_log
  for select to authenticated
  using (org_id in (select public.user_org_ids()));

revoke all on retrieval_log from anon;
grant select on retrieval_log to authenticated;
grant all    on retrieval_log to service_role;


-- ----------------------------------------------------------------
-- prune_retrieval_log — the retention mechanism
--
-- THE CLAMP IS THE POINT, and it lives here rather than in the Worker.
-- The Worker holds a service-role key, and this is the one table on
-- this platform where a wrong number deletes tenant data outright.
-- Clamping into [7, 365] inside the function body means the Worker
-- cannot ask for a zero-day purge even by accident — a bug in the cron
-- handler, or a stray manual call, truncates nothing.
--
-- security definer so the caller needs execute on this and nothing
-- wider. Returns the row count, so the scheduled handler can log what
-- it actually did rather than "something probably happened".
-- ----------------------------------------------------------------
create or replace function public.prune_retrieval_log(p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  -- coalesce first: an explicit null argument would otherwise sail
  -- through both bounds and take the whole table with it.
  v_days    integer := least(365, greatest(7, coalesce(p_days, 90)));
  v_deleted integer;
begin
  delete from public.retrieval_log
   where created_at < now() - make_interval(days => v_days);
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$fn$;

revoke all on function public.prune_retrieval_log(integer) from public;
grant execute on function public.prune_retrieval_log(integer) to service_role;


-- ----------------------------------------------------------------
-- documents.ingest_started_at — the re-index claim (B4)
--
-- Not another `status` value, because it answers a different question.
-- `status` is what the tenant sees; this is whether a run currently
-- owns the document. Two reindex clicks used to interleave
-- delete-then-insert, and the loser marked the document `failed` while
-- the winner's chunks sat there indexed and working — a red row on a
-- document that is fine, and the natural response is to click reindex
-- again.
--
-- The compare-and-set is a single conditional UPDATE from the Worker
-- (claimDocument in src/supabase.ts), so it is atomic in Postgres. A
-- claim older than the Worker's stale window is treated as abandoned,
-- because a Worker can die mid-waitUntil with no chance to release.
-- ----------------------------------------------------------------
alter table documents add column if not exists ingest_started_at timestamptz;

comment on column documents.ingest_started_at is
  'Non-null while an ingest run holds this document. Claimed by conditional UPDATE, released on success and on failure. A stale claim is reclaimable — see src/rag/ingest.ts.';


-- ----------------------------------------------------------------
-- bots.embedding_model_indexed — drift detection (B2)
--
-- documents.embedding_model records what each document was built with.
-- This records what the BOT's corpus was last built with, which is the
-- cheap comparison the hot path can afford: retrieve() already holds
-- the bot row and already resolves the embedder, so the check costs
-- zero extra queries.
--
-- Why it matters: switch a bot from bge-base-en-v1.5 to
-- gemini-embedding-001 and both are 768-dimensional, so the width
-- assertion in embedPieces passes and Postgres raises nothing — but the
-- stored vectors and the query vector are now from different embedding
-- spaces, and cosine similarity between them is noise. Permanently,
-- silently, with no error and no status change.
--
-- NULL MEANS "UNKNOWN, ALLOW". A corpus indexed before this migration
-- has nothing to compare against, and treating unknown as mismatched
-- would switch retrieval off for every existing bot on the platform.
-- ----------------------------------------------------------------
alter table bots add column if not exists embedding_model_indexed text;

comment on column bots.embedding_model_indexed is
  'Embedding model the corpus was last successfully built with. NULL = unknown, which retrieval treats as "allow". Stamped by both ingest paths on success only.';

-- Backfill from each bot's most recently updated ready document, so
-- existing corpora are not all flagged as drifted on day one. The
-- `is null` guard is what makes re-running this file a no-op rather
-- than a rewrite of state a later ingest has since corrected.
update bots b
   set embedding_model_indexed = d.embedding_model
  from (
    select distinct on (bot_id) bot_id, embedding_model
      from documents
     where status = 'ready'
       and embedding_model is not null
       and embedding_model <> ''
     order by bot_id, updated_at desc
  ) d
 where d.bot_id = b.id
   and b.embedding_model_indexed is null;


-- ----------------------------------------------------------------
-- match_chunks — recreated for the title fold and hnsw.ef_search
--
-- DROPPED AND RECREATED, not `create or replace`: replace cannot widen
-- a return row type. The 011 header records why the old signature must
-- go rather than sit alongside as an overload — two overloads whose
-- extra arguments all have defaults make the shorter call ambiguous,
-- and an old Worker would start failing with "function is not unique"
-- rather than falling back cleanly.
--
-- TWO CHANGES, and the body is otherwise untouched.
--
-- 1. `document_title` in the returned row (S2). The chat path looked
--    this up in a second round trip on every turn with citations on;
--    B6 aligned the citations but explicitly left the round trip,
--    because dropping it means changing a versioned SQL function. This
--    is that migration. It is the same field added and then removed in
--    phase 1 as dead surface — it now has a reason to exist.
--
-- 2. `language plpgsql`, solely so the body can set hnsw.ef_search
--    before running (S1's first mitigation). One shared chunks table,
--    one global HNSW index, and a bot_id filter applied after the
--    vector ordering is a recall trap: once a tenant's slice is large
--    enough that the planner prefers the index scan, it walks only
--    ef_search candidates GLOBALLY and keeps whichever happen to belong
--    to this tenant — returning fewer than top_k rows, sometimes zero,
--    for a corpus that contains a perfectly good answer. Invisible at
--    today's row counts, unpleasant to debug later.
--
--    `perform set_config(...)` RATHER THAN `set local`, and that is a
--    requirement rather than a preference: SET is a utility statement,
--    and a STABLE function may not run one — `set local hnsw.ef_search
--    = 100` here fails outright with "SET is not allowed in a
--    non-volatile function". set_config is an ordinary function call
--    in a SELECT, which a read-only context permits.
--
--    is_local := true scopes the value to the TRANSACTION, not to this
--    function: it is still set for the rest of the transaction after
--    the call returns (a function's own SET clause commits its nested
--    values upward rather than discarding them), and is gone at
--    transaction end. That is the property that matters, because
--    PostgREST runs every request in its own transaction — so it
--    cannot leak between requests, which is the only leak that would
--    change another caller's results.
--
-- THE TWO-PHASE SHAPE IS NOT DECORATION, and it survives the rewrite
-- unchanged. Ordering by `similarity + boost` directly would be
-- unindexable and throw away the HNSW index, so the inner query takes
-- the nearest candidates in index order and the outer one re-ranks that
-- pool. Filtering on similarity after the limit is exactly equivalent
-- to filtering before it, because similarity decreases monotonically
-- with distance: if the Nth-nearest row fails the floor, so does
-- everything behind it.
--
-- Still deliberately NOT security definer, for the reason 005 gave: the
-- chat path calls this as service_role and the tenant filter is the
-- mandatory p_bot_id argument, while the dashboard calls it as the end
-- user where RLS narrows it further. Definer would strip that second
-- layer for no benefit.
-- ----------------------------------------------------------------
drop function if exists public.match_chunks(uuid, vector, integer, double precision, double precision);
drop function if exists public.match_chunks(uuid, vector, integer, double precision);

create or replace function public.match_chunks(
  p_bot_id         uuid,
  p_query          vector(768),
  p_match_count    integer default 5,
  p_min_similarity double precision default 0.0,
  p_priority_boost double precision default 0.0
)
returns table (
  id             uuid,
  document_id    uuid,
  ordinal        integer,
  content        text,
  similarity     double precision,
  kind           text,
  priority       smallint,
  document_title text
)
language plpgsql
stable
set search_path = public
as $fn$
begin
  -- Deep enough that a filtered index scan still has this tenant's rows
  -- in the candidate pool; floored at pgvector's own default so a small
  -- top_k never makes recall worse than it was before this line existed.
  perform set_config('hnsw.ef_search',
                     greatest(40, coalesce(p_match_count, 5) * 20)::text,
                     true);

  return query
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
  select cd.id, cd.document_id, cd.ordinal, cd.content, cd.similarity,
         cd.kind, cd.priority, d.title
    from candidates cd
    -- LEFT, not inner: a chunk whose document row is mid-delete must
    -- still be returned rather than silently vanishing from a search.
    left join public.documents d on d.id = cd.document_id
   where cd.similarity >= p_min_similarity
   order by cd.similarity + (cd.priority * coalesce(p_priority_boost, 0)) desc
   limit greatest(p_match_count, 0);
end;
$fn$;

grant execute on function public.match_chunks(uuid, vector, integer, double precision, double precision)
  to authenticated, service_role;


-- ----------------------------------------------------------------
-- match_chunks_lexical — recreated for the same title fold
--
-- Dropped and recreated for the same reason: the row type widens.
-- Nothing else about it changes, and the reasoning 011 recorded for the
-- OR-ed tsquery and the half-the-lexemes overlap gate applies
-- unchanged. In short, because it is the part most likely to be
-- "simplified" by someone reading this file cold:
--
--   websearch_to_tsquery and plainto_tsquery both AND their terms, and
--   under 'simple' nothing is dropped as a stopword — so "do u take
--   insurance" would require *u* and *take* literally and would find
--   nothing in "Do you accept insurance?", which is precisely the query
--   this function exists to rescue. OR alone is too loose the other
--   way, so at least half the distinct lexemes a visitor typed must
--   appear in the chunk. The @@ stays the leading predicate so the GIN
--   index still does the prefiltering.
--
-- NOTE ON `similarity`: it is a ts_rank_cd score here, NOT a cosine
-- similarity, and the two are not on the same scale. The column keeps
-- its name so callers need one row shape; the Worker reports which
-- channel a chunk came from rather than pretending they are comparable.
-- ----------------------------------------------------------------
drop function if exists public.match_chunks_lexical(uuid, text, integer);

create or replace function public.match_chunks_lexical(
  p_bot_id      uuid,
  p_query_text  text,
  p_match_count integer default 5
)
returns table (
  id             uuid,
  document_id    uuid,
  ordinal        integer,
  content        text,
  similarity     double precision,
  kind           text,
  priority       smallint,
  document_title text
)
language sql
stable
set search_path = public
as $fn$
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
         c.priority,
         d.title
    from public.chunks c
    cross join tq
    cross join lateral (
      select count(*)::int as hits
        from unnest(c.search) as cs(lexeme, positions, weights)
       where cs.lexeme = any (tq.lex)
    ) ov
    left join public.documents d on d.id = c.document_id
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
$fn$;

grant execute on function public.match_chunks_lexical(uuid, text, integer)
  to authenticated, service_role;
