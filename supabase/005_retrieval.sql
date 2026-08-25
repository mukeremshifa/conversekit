-- ================================================================
-- ConverseKit — retrieval
--
-- Three RPCs and one observability table. Between them they are the
-- whole read side of the corpus.
--
--   match_faq_items         trigram lookup straight at the curated Q&A.
--                           A hit answers the turn with NO EMBEDDING
--                           CALL AT ALL.
--   match_chunks            vector search with a priority boost.
--   match_chunks_lexical    the keyword channel — a fallback when the
--                           vector search finds nothing, or a primary
--                           channel in hybrid mode.
--   retrieval_log           what was asked, and whether the bot could
--                           answer it.
--
-- NONE OF THE THREE IS SECURITY DEFINER, and that is deliberate. The
-- chat path calls them as service_role (which bypasses RLS anyway) and
-- the tenant filter is the mandatory p_bot_id argument; the dashboard
-- calls them as the end user, where RLS narrows them further. Definer
-- would strip that second layer for no benefit.
--
-- `similarity` MEANS TWO DIFFERENT THINGS across these functions: a
-- cosine similarity in match_chunks and a ts_rank_cd score in
-- match_chunks_lexical. They are not on the same scale. The column
-- keeps one name so callers need one row shape, and the Worker fuses
-- the two channels BY RANK (reciprocal rank fusion), never by score.
-- ================================================================


-- ----------------------------------------------------------------
-- match_faq_items — the FAQ shortcut
--
-- WHY THIS IS NOT match_chunks_lexical, which already restricts to
-- boosted chunks and is therefore FAQ material by construction:
--
--   1. ts_rank / ts_rank_cd IS NOT NORMALISED. Its magnitude depends on
--      document length and term frequency, so no value of it means
--      "this is definitely the same question" — and a threshold is the
--      entire mechanism here. pg_trgm's similarity() returns 0-1 and
--      CAN be thresholded.
--   2. It reads `chunks`, so it only works AFTER the FAQ has been
--      ingested. Reading faq_items directly means the shortcut works
--      the moment a tenant saves an answer, including on a bot whose
--      embedding vendor is misconfigured and whose corpus is empty.
--
-- On a hit, the round trip comes off the front of time-to-first-token
-- and the answer is the one the tenant wrote rather than the one that
-- scored best. On a miss it costs one indexed query against at most a
-- few hundred short rows.
--
-- Off by default: rag_config.faq_shortcut_threshold defaults to 0, and
-- 0 means off. One knob, not a knob and a boolean.
--
-- plpgsql rather than sql only because of the SET LOCAL: the threshold
-- is a parameter, and a function-level SET clause takes a constant.
-- VOLATILE by necessity, which also means PostgREST exposes it on POST
-- — the same shape every other RPC here is called with.
-- ----------------------------------------------------------------
drop function if exists public.match_faq_items(uuid, text, integer, double precision);

create function public.match_faq_items(
  p_bot_id         uuid,
  p_query_text     text,
  p_match_count    integer default 1,
  p_min_similarity double precision default 0.5
)
returns table (
  id         uuid,
  question   text,
  answer     text,
  similarity double precision
)
language plpgsql
volatile
security invoker
-- `extensions` as well as `public`: Supabase may have pg_trgm there
-- rather than in public, and without this the failure is a runtime
-- "operator does not exist" on the visitor's hot path rather than an
-- error at migration time.
set search_path = public, extensions
as $$
-- RETURNS TABLE makes `id`, `question`, `answer` and `similarity` into
-- plpgsql variables in this scope, and every one of them is also a
-- column of faq_items. Every reference below is alias-qualified, and
-- this pragma is the belt to that pair of braces: an ambiguous name
-- resolves to the COLUMN rather than to the output variable, which is
-- what a reader of the query expects it to mean.
#variable_conflict use_column
begin
  if p_query_text is null or btrim(p_query_text) = '' then
    return;
  end if;

  -- Transaction-scoped. set_limit() would change the SESSION setting
  -- and outlive this request on a pooled connection.
  perform set_config('pg_trgm.similarity_threshold',
                     greatest(p_min_similarity, 0)::text, true);

  -- `enabled = false` items are excluded HERE rather than filtered in
  -- the Worker: a disabled item is one a tenant switched off, and an
  -- answer reaching a visitor from one would be the single most
  -- alarming way for this shortcut to be wrong.
  --
  -- `%` rather than similarity() in the predicate so the trigram index
  -- does the filtering instead of a score computed per row.
  return query
  select f.id,
         f.question,
         f.answer,
         similarity(f.question, p_query_text)::double precision
    from public.faq_items f
   where f.bot_id = p_bot_id
     and f.enabled
     and f.question % p_query_text
   order by similarity(f.question, p_query_text) desc,
            f.position asc
   limit greatest(p_match_count, 0);
end;
$$;

grant execute on function public.match_faq_items(uuid, text, integer, double precision)
  to authenticated, service_role;


-- ----------------------------------------------------------------
-- match_chunks — vector search with a priority boost
--
-- THE TWO-PHASE SHAPE IS NOT DECORATION. Ordering by
-- `similarity + boost` directly would be unindexable and throw away the
-- HNSW index, so the inner query takes the nearest candidates in index
-- order and the outer one re-ranks that pool. Filtering on similarity
-- after the limit is exactly equivalent to filtering before it, because
-- similarity decreases monotonically with distance: if the Nth-nearest
-- row fails the floor, so does everything behind it.
--
-- THE TWO set_config CALLS ARE ONE FEATURE — filtered vector search.
-- One shared chunks table, one global HNSW index, and a bot_id filter
-- applied after the vector ordering is a recall trap: once a tenant's
-- slice is large enough that the planner prefers the index scan, it
-- walks only ef_search candidates GLOBALLY and keeps whichever happen
-- to belong to this tenant — returning fewer than top_k rows, sometimes
-- zero, for a corpus that contains a perfectly good answer. Invisible
-- at small row counts, unpleasant to debug later.
--
--   ef_search        the floor: deep enough that a filtered scan still
--                    has this tenant's rows in the candidate pool.
--   iterative_scan   the ceiling, pgvector 0.8+: keep pulling
--                    candidates until the filter has yielded enough
--                    rows. GUARDED, because set_config on an unknown
--                    GUC ERRORS — on 0.7 and earlier an unguarded call
--                    would turn every search into a 500.
--   max_scan_tuples  paired with it deliberately: relaxed order with no
--                    ceiling can degenerate into scanning most of the
--                    index for a tenant whose slice is tiny and whose
--                    query matches nothing — the pathology being fixed,
--                    inverted.
--
-- NOT VERIFIED AGAINST ROWS. The mechanism is pgvector's documented
-- filtered-search behaviour and the schema conditions are all present,
-- but no fixture has shown the trap happening. Building a 200k-row
-- fixture is what would change this sentence — do not describe it as
-- verified until someone does.
--
-- `perform set_config(...)` RATHER THAN `set local`, and that is a
-- requirement: SET is a utility statement and a STABLE function may not
-- run one. set_config is an ordinary function call in a SELECT, which a
-- read-only context permits. `is_local := true` scopes the value to the
-- TRANSACTION — and PostgREST runs every request in its own, so it
-- cannot leak between requests.
--
-- `language plpgsql` exists solely to make those calls possible.
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
  -- Floored at pgvector's own default so a small top_k never makes
  -- recall worse than it was before this line existed.
  perform set_config('hnsw.ef_search',
                     greatest(40, coalesce(p_match_count, 5) * 20)::text,
                     true);

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
-- match_chunks_lexical — the keyword channel
--
-- What it buys is the case similarity handles worst: a visitor typing
-- "do u take insurance" against a curated FAQ entry that says exactly
-- that in different words, where the embedding rolls badly and the
-- floor rejects a genuine match.
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
-- match anything. The refinement is an overlap test — at least half the
-- distinct lexemes a visitor typed must appear in the chunk — which
-- rejects an FAQ entry that merely shares the word "do" while accepting
-- one that shares "do" and "insurance" out of four. Results are ordered
-- by that overlap first and ts_rank_cd second, because "how many of
-- your words are in here" is both more interpretable and more stable
-- than a rank score on chunks this short.
--
-- The @@ against the OR-ed tsquery stays the LEADING predicate so the
-- GIN index still does the prefiltering; the overlap count then refines
-- what survives.
--
-- p_min_priority IS THE MODE SWITCH. 1 = curated, boosted chunks only,
-- which is the fallback channel. 0 = the whole corpus, which is what
-- hybrid mode asks for — the stated point of hybrid retrieval is to
-- reach "a proper noun buried in a PDF", and that is a priority = 0
-- prose chunk.
--
-- THE OVERLAP GATE IS THE ONLY THING STANDING BETWEEN HYBRID AND A
-- SILENT REGRESSION. In hybrid mode this runs against every chunk on
-- every turn, so any query sharing half its lexemes with any chunk
-- returns something, so rendered.length is almost never zero, so
-- missedRetrieval is almost never true — and fallback_message,
-- escalate_after_misses and the lexical fallback all die. `ov.hits * 2
-- >= tq.n` was tuned for a fallback channel over curated FAQ text, not
-- for a primary channel over an entire corpus. Watch the miss report
-- after enabling hybrid on a bot: a miss rate collapsing toward zero IS
-- that failure, and this gate is what has to be raised.
-- ----------------------------------------------------------------
drop function if exists public.match_chunks_lexical(uuid, text, integer, smallint);

create or replace function public.match_chunks_lexical(
  p_bot_id       uuid,
  p_query_text   text,
  p_match_count  integer  default 5,
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
             -- apostrophe or an operator character would otherwise be a
             -- tsquery syntax error on text a visitor merely typed.
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
-- retrieval_log — one row per turn where retrieval ran
--
-- THE QUERY IS STORED VERBATIM, and that is a decision rather than an
-- oversight. The whole value of this table is the tenant-facing report
-- "here are the questions your bot could not answer" — a normalised or
-- hashed query cannot be read back, and a report of question *shapes*
-- tells nobody what to write next. The conversations table already
-- holds the same text, so this adds a retention surface rather than a
-- new class of data. See docs/tenancy.md for the retention rules.
--
-- ROWS ARE WRITTEN FOR HITS TOO, not just misses. A miss-only table has
-- rows but no denominator: no miss rate, and no score distribution to
-- tune a floor against — which is exactly the trap this project fell
-- into once already, where a floor that could never reject looked like
-- it worked for months.
-- ----------------------------------------------------------------
create table if not exists retrieval_log (
  id              uuid        primary key default gen_random_uuid(),
  bot_id          uuid        not null references bots(id)          on delete cascade,
  org_id          uuid        not null references organizations(id) on delete cascade,
  -- Nullable: preview traffic has no real session, and a row is worth
  -- keeping even when it cannot be tied to a conversation.
  session_id      text,
  query           text        not null,
  -- "Was the model shown anything from this business's own material" —
  -- the same statement missedRetrieval makes in the Worker.
  matched         boolean     not null,
  -- 'vector' | 'lexical' | null (null on a miss). Deliberately not a
  -- CHECK: a third channel should not need a migration to start
  -- recording itself.
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

comment on table retrieval_log is
  'One row per chat turn where retrieval ran. Visitor query stored verbatim; pruned by prune_retrieval_log() on a daily cron. See docs/tenancy.md.';
comment on column retrieval_log.top_score is
  'Cosine similarity when channel = vector, ts_rank_cd when channel = lexical. Not comparable across channels.';

-- The report reads one bot's recent rows and nothing else, so this is
-- the only index it needs. `created_at desc` matches the query order.
create index if not exists idx_retrieval_log_bot
  on retrieval_log(bot_id, created_at desc);

drop trigger if exists trg_retrieval_log_org on retrieval_log;
create trigger trg_retrieval_log_org
  before insert on retrieval_log
  for each row execute function public.set_org_from_bot_row();


-- ----------------------------------------------------------------
-- prune_retrieval_log — the retention mechanism
--
-- THE CLAMP IS THE POINT, and it lives here rather than in the Worker.
-- The Worker holds a service-role key, and this is one of two tables on
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
-- RLS and grants — mirrors chunks, not documents
--
-- Select for members of the owning org, and no tenant write policy at
-- all. This is derived data: the Worker writes it with the service
-- role, and a tenant forging their own miss report is not a state worth
-- allowing.
-- ----------------------------------------------------------------
alter table retrieval_log enable row level security;

drop policy if exists retrieval_log_select on retrieval_log;

create policy retrieval_log_select on retrieval_log
  for select to authenticated
  using (org_id in (select public.user_org_ids()));

revoke all on retrieval_log from anon;
grant select on retrieval_log to authenticated;
grant all    on retrieval_log to service_role;
