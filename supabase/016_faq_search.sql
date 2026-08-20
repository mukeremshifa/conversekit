-- ================================================================
-- ConverseKit — direct FAQ lookup by trigram similarity
-- Run in the Supabase SQL Editor after 015_business_profile.sql
--
-- WHY THIS IS NOT match_chunks_lexical. That RPC already exists, and
-- since 011 it already restricts to boosted chunks via p_min_priority,
-- which is FAQ material by construction — so reusing it is the obvious
-- move and it is the wrong one, for two reasons:
--
--   1. ts_rank / ts_rank_cd IS NOT NORMALISED. Its magnitude depends on
--      document length and term frequency, so there is no value of it
--      that means "this is definitely the same question" — and a
--      threshold is the entire mechanism here. `similarity()` from
--      pg_trgm returns 0-1 and CAN be thresholded, which is why this is
--      trigram search and not full-text search.
--
--   2. It reads `chunks`, so it only works AFTER the FAQ has been
--      ingested. Reading faq_items directly means the shortcut works
--      the moment a tenant saves an answer, including on a bot whose
--      embedding vendor is misconfigured and whose corpus is therefore
--      empty.
--
-- WHAT IT BUYS. On a hit, the turn is answered from the curated Q&A
-- with NO EMBEDDING CALL AT ALL — the round trip comes off the front of
-- time-to-first-token, and the answer is the one the tenant wrote
-- rather than the one that scored best. On a miss it costs one indexed
-- query against at most a few hundred short rows, and retrieval carries
-- on exactly as it did before.
--
-- Off by default: rag_config.faq_shortcut_threshold defaults to 0, and
-- 0 means off. One knob, not a knob and a boolean.
--
-- Additive and re-runnable. Deploy BEFORE the Worker, per the rule 012
-- and 013 both record: a Worker calling an RPC that does not exist
-- fails outright, while this schema under the old Worker is unread.
-- ================================================================


-- ----------------------------------------------------------------
-- pg_trgm and the index
--
-- `gin_trgm_ops` is what makes the `%` operator indexable. The function
-- below sets pg_trgm.similarity_threshold with SET LOCAL — transaction
-- scoped, so it cannot leak across requests on a pooled PostgREST
-- connection the way set_limit() would — and then uses `%`, so the
-- index does the filtering rather than a similarity() computed per row.
-- ----------------------------------------------------------------
-- SEARCH PATH FIRST, AND IT IS NOT DECORATION. Supabase pre-creates
-- some extensions in an `extensions` schema rather than in `public`, so
-- `create extension if not exists` can be a silent no-op that leaves
-- `similarity()`, `%` and `gin_trgm_ops` somewhere `public` alone cannot
-- see. Naming both schemas here makes the opclass below resolve either
-- way, and the function further down carries the same pair for the same
-- reason.
set search_path = public, extensions;

create extension if not exists pg_trgm;

create index if not exists idx_faq_items_question_trgm
  on faq_items using gin (question gin_trgm_ops);


-- ----------------------------------------------------------------
-- match_faq_items
--
-- plpgsql rather than sql, and only because of the SET LOCAL: the
-- threshold is a parameter, and a function-level SET clause takes a
-- constant.
--
-- VOLATILE by necessity (SET LOCAL is a side effect), which also means
-- PostgREST exposes it on POST — the same shape every other RPC in this
-- schema is called with.
--
-- `enabled = false` items are excluded here rather than filtered in the
-- Worker: a disabled item is one a tenant switched off, and an answer
-- reaching a visitor from one would be the single most alarming way for
-- this shortcut to be wrong.
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
-- `extensions` as well as `public`: see the note at the top of this
-- file. Without it a Supabase project whose pg_trgm lives there cannot
-- resolve `%` or `similarity()` from inside this function, and the
-- failure is a runtime "operator does not exist" on the visitor's hot
-- path rather than an error at migration time.
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

-- service_role for the chat path, authenticated for the retrieval
-- preview — the same pair every other retrieval RPC is granted to.
grant execute on function public.match_faq_items(uuid, text, integer, double precision)
  to authenticated, service_role;
