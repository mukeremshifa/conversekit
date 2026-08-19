-- ================================================================
-- ConverseKit — Hybrid retrieval, iterative scan, corpus counter
-- Run in the Supabase SQL Editor after 012_retrieval.sql
--
-- Additive and safe to re-run. The one new column is defaulted, the
-- backfill only ever corrects a wrong number, and both functions are
-- dropped and recreated rather than replaced.
--
-- THREE CHANGES, riding together because two of them recreate a
-- retrieval RPC and shipping two migrations that each recreate one is a
-- worse story than one migration that recreates both.
--
--   M4  match_chunks_lexical's priority gate becomes a PARAMETER, so
--       lexical can run as a primary channel over the whole corpus
--       instead of only as a fallback over curated FAQ chunks.
--   S1  match_chunks sets hnsw.iterative_scan, guarded, so a filtered
--       vector search on pgvector 0.8+ keeps looking until it has this
--       tenant's rows rather than stopping at ef_search globally.
--   S2  bots.chunk_count, maintained by a statement-level trigger, so
--       "does this bot have a corpus" stops being a per-turn query.
--
-- ORDER MATTERS, same as 012 and for the same reason: deploy this
-- BEFORE the Worker. A Worker calling match_chunks_lexical with a
-- fourth argument against the three-argument function fails outright,
-- while this schema under the OLD Worker is a no-op — the new parameter
-- defaults to today's behaviour and the new column goes unread.
-- ================================================================


-- ----------------------------------------------------------------
-- M4 — match_chunks_lexical gains p_min_priority
--
-- THE BRIEF SAID THIS NEEDED NO MIGRATION. It did:
--
--     and c.priority > 0
--
-- was hard-coded in 012, and that line is exactly what makes lexical a
-- fallback rather than a channel. The stated point of hybrid retrieval
-- is to reach "a proper noun buried in a PDF" — a priority = 0 prose
-- chunk, which this predicate excludes by construction. So the gate
-- becomes an argument, and 1 is its default so nothing changes for a
-- caller that does not pass it.
--
-- THE DROP IS NOT OPTIONAL. Adding a defaulted fourth parameter beside
-- the existing three-argument function makes the three-argument call
-- ambiguous rather than overloaded, and PostgREST would start failing
-- with "function is not unique" — the same trap 011 and 012 both
-- recorded for match_chunks.
--
-- EVERYTHING ELSE IS UNCHANGED, and the reasoning 012 recorded becomes
-- MORE load-bearing here rather than less, because this is now a
-- channel that can run on every turn:
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
-- THE OVERLAP GATE IS NOW THE ONLY THING STANDING BETWEEN HYBRID AND
-- B1. In hybrid mode this runs against every chunk on every turn, so
-- any query sharing half its lexemes with any chunk returns something,
-- so rendered.length is almost never zero, so missedRetrieval is almost
-- never true — and fallback_message and escalate_after_misses die
-- exactly as they did under B1, reached from the opposite direction.
-- `ov.hits * 2 >= tq.n` was tuned for a fallback channel over curated
-- FAQ text, not for a primary channel over an entire corpus. Watch the
-- miss report after enabling hybrid on a bot: a miss rate collapsing
-- toward zero IS that failure, and this gate is what has to be raised.
--
-- NOTE ON `similarity`: still a ts_rank_cd score here, NOT a cosine
-- similarity. Which is why the Worker fuses the two channels by RANK
-- (reciprocal rank fusion) and never by score.
-- ----------------------------------------------------------------
drop function if exists public.match_chunks_lexical(uuid, text, integer);
drop function if exists public.match_chunks_lexical(uuid, text, integer, smallint);

create or replace function public.match_chunks_lexical(
  p_bot_id       uuid,
  p_query_text   text,
  p_match_count  integer  default 5,
  -- 1 = today's fallback behaviour: curated, boosted chunks only.
  -- 0 = the whole corpus, which is what hybrid mode asks for.
  p_min_priority smallint default 1
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
     and c.priority >= coalesce(p_min_priority, 1)
     and c.search @@ tq.tsq
     and ov.hits * 2 >= tq.n
   order by ov.hits desc,
            ts_rank_cd(c.search, tq.tsq) desc,
            c.priority desc,
            c.ordinal asc
   limit greatest(p_match_count, 0);
$fn$;

grant execute on function public.match_chunks_lexical(uuid, text, integer, smallint)
  to authenticated, service_role;

comment on function public.match_chunks_lexical(uuid, text, integer, smallint) is
  'Lexical channel. p_min_priority 1 = curated chunks only (the fallback), 0 = the whole corpus (hybrid). similarity is ts_rank_cd, not cosine — fuse by rank, never by score.';


-- ----------------------------------------------------------------
-- S1, second half — hnsw.iterative_scan
--
-- 012 set hnsw.ef_search, which is the floor: deep enough that a
-- filtered index scan still has this tenant's rows in the candidate
-- pool. This is the ceiling. On pgvector 0.8+, `relaxed_order` is the
-- feature built precisely for filtered vector search — the scan keeps
-- pulling candidates until the filter has yielded enough rows, instead
-- of walking ef_search nodes globally and keeping whichever happen to
-- belong to this bot.
--
-- GUARDED, BECAUSE set_config ON AN UNKNOWN GUC ERRORS. On pgvector
-- 0.7 and earlier `hnsw.iterative_scan` does not exist, and an
-- unguarded call would turn every search on such a deployment into a
-- 500. The alternative — emitting the body conditionally at migration
-- time with `do $$ ... execute ... $$` — is faster by an immeasurable
-- amount and hides the fallback from anyone reading the function. The
-- exception block is self-documenting; that is the point.
--
-- max_scan_tuples IS PAIRED WITH IT DELIBERATELY. Relaxed order with no
-- ceiling can degenerate into scanning most of the index for a tenant
-- whose slice is tiny and whose query matches nothing — the pathology
-- being fixed, inverted. 20k is far past what any legitimate top_k
-- needs and far short of a table scan.
--
-- NOT VERIFIED AGAINST ROWS. The phase 2 attempt to demonstrate the
-- recall trap empirically needed a `drop index` to force the plan and
-- was blocked. This ships in exactly the state ef_search did: the
-- mechanism is pgvector's documented filtered-search behaviour and the
-- schema conditions for it are all present, but no fixture has shown
-- it happening. Building the 200k-row fixture under scripts/spike/ is
-- what would change that sentence — do not describe it as verified
-- until someone does.
--
-- Everything else is unchanged from 012: the two-phase
-- over-fetch-then-rerank shape, the left join for the title, the floor
-- tested against RAW similarity, and `stable` rather than
-- `security definer`.
-- ----------------------------------------------------------------
drop function if exists public.match_chunks(uuid, vector, integer, double precision, double precision);

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

  -- pgvector 0.8+ only. On anything older these GUCs do not exist and
  -- set_config raises; the search is still correct without them, so the
  -- failure is swallowed rather than propagated. Both are set in one
  -- block because they are one feature.
  begin
    perform set_config('hnsw.iterative_scan',  'relaxed_order', true);
    perform set_config('hnsw.max_scan_tuples', '20000',         true);
  exception when others then
    -- Older pgvector. ef_search above is still in force.
    null;
  end;

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
-- S2 — bots.chunk_count, the corpus probe that costs nothing
--
-- `hasChunks(db, botId)` was a PostgREST round trip before retrieval on
-- every single chat turn, purely to decide whether to embed at all.
--
-- THE OBVIOUS FOLD IS THE WRONG ONE, and it is worth recording here
-- rather than only in the brief. Folding it into match_chunks —
-- "returning zero rows IS no corpus" — collapses two states that have
-- to stay distinct. src/index.ts computes
--
--     missedRetrieval = hasCorpus and not staleIndex and rendered = 0
--
-- so deriving hasCorpus from whether match_chunks returned rows makes
-- that `(rows > 0) and (rendered = 0)`, true only when the context
-- budget dropped everything. fallback_message, escalate_after_misses
-- and lexical_fallback all go dead again — the exact three features B1
-- disabled, by a different mechanism, one phase later. It would also
-- cost an embedding call per turn for bots with NO corpus, which is the
-- one case the probe exists to make free.
--
-- A counter on the bot row keeps both properties: "no corpus" and
-- "nothing cleared the floor" stay two different numbers, and the bot
-- row is already fetched before retrieval, so hasCorpus becomes a field
-- read. Correctness lives here, in one trigger, instead of in every
-- code path that would have to remember to update it. The side benefit
-- is that Sources can say "11 chunks indexed" without a query.
--
-- STATEMENT-LEVEL, NOT ROW-LEVEL, and that is the whole reason for the
-- transition tables. replaceChunks is delete-then-insert of up to 400
-- rows per document; a per-row trigger would fire 800 times per ingest
-- to compute a number that only has to be right at the end. This fires
-- twice, and recomputes only the bots the statement actually touched.
-- ----------------------------------------------------------------
alter table bots add column if not exists chunk_count integer not null default 0;

comment on column bots.chunk_count is
  'Indexed chunks for this bot. Maintained by trg_chunks_count_* — never written by the application. Read by the chat path instead of a per-turn "does this bot have a corpus" query.';

create or replace function public.recount_bot_chunks()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  -- One UPDATE over the distinct bots this statement touched. The count
  -- is RECOMPUTED rather than incremented by a delta: a delta is a
  -- second source of truth that drifts the first time a statement does
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

-- Backfill. Not guarded on NULL — the column is NOT NULL DEFAULT 0, so
-- every existing bot reads as "no corpus" until this runs. Written as a
-- correction rather than an assignment so re-running the file touches
-- no rows.
update bots b
   set chunk_count = coalesce(
         (select count(*) from chunks c where c.bot_id = b.id), 0)
 where b.chunk_count is distinct from coalesce(
         (select count(*) from chunks c where c.bot_id = b.id), 0);
