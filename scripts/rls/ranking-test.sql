-- Ranking assertions for both retrieval channels. Runs only where
-- pgvector exists, because everything here calls match_chunks.
--
-- THE ONE OPEN HOUSEKEEPING ITEM FROM THE PHASE 1 AUDIT. match_chunks'
-- priority boost and match_chunks_lexical's overlap gate were verified
-- by hand against the live database during 011 and were covered
-- nowhere: knowledge-test.sql tests isolation, not ranking. Every
-- assertion below is a property some later "simplification" could
-- remove without any other test going red.
--
-- SELF-CONTAINED, unlike the other files in this directory. It creates
-- its own bot, its own document and its own chunks with HAND-BUILT
-- EMBEDDINGS, because ranking assertions need known distances between
-- known vectors — reusing the fixtures the earlier files left behind
-- would make every number here depend on what those files happen to
-- insert. It cleans up after itself so the counts other files assert on
-- are unaffected.
--
-- The vectors are 768-wide with a single non-zero leading pair, so
-- cosine similarity between any two of them is arithmetic anyone can
-- check by hand rather than a number that came out of a model.

\set ON_ERROR_STOP on

\echo '=== RANKING: fixture ==='
do $$
declare org_a uuid; bot uuid; doc uuid;
begin
  set local role service_role;

  select b.org_id into org_a from bots b where b.name = 'Bot A';

  insert into bots (org_id, name, business_name, allowed_origin)
  values (org_a, 'Bot Rank', 'Ranking Fixture', 'https://rank.test')
  returning id into bot;

  insert into documents (bot_id, source, title, content)
  values (bot, 'text', 'Ranking fixture', 'seed')
  returning id into doc;

  -- The query vector this file uses throughout is [1, 0, 0, ...].
  --
  --   near  = [1, 0, ...]        cosine 1.00
  --   mid   = [1, 1, 0, ...]     cosine 0.7071
  --   far   = [1, 4, 0, ...]     cosine 0.2425
  --
  -- so `mid` at priority 1 versus `near` at priority 0 is a gap of
  -- 0.2929 — far wider than the 0.05 default boost and far narrower
  -- than the 0.5 cap, which is exactly the range the two boost
  -- assertions below need to sit either side of.
  insert into chunks (document_id, bot_id, ordinal, content, kind, priority, embedding)
  values
    (doc, bot, 0, 'The plain passage about parking and access.', 'prose', 0,
     ('[1,0' || repeat(',0', 766) || ']')::vector),
    (doc, bot, 1, 'Q: Do you accept insurance?' || chr(10) || 'A: Yes, we work with most major providers.',
     'faq', 1, ('[1,1' || repeat(',0', 766) || ']')::vector),
    (doc, bot, 2, 'An unrelated note about the annual staff outing.', 'prose', 0,
     ('[1,4' || repeat(',0', 766) || ']')::vector);
  reset role;

  raise notice '  ok   ranking fixture: one bot, three chunks, known distances';
end $$;


-- ----------------------------------------------------------------
-- The priority boost
--
-- It decides near-ties in favour of a hand-written FAQ answer. Two
-- assertions, because the interesting property is not that the boost
-- works — it is that it works ONLY when it is turned on, so a tenant
-- who sets it to 0 gets pure relevance rather than a boost that is
-- baked in somewhere else.
-- ----------------------------------------------------------------
\echo '=== RANKING: a large boost lifts a lower-scoring FAQ chunk ==='
do $$
declare bot uuid; v vector(768); top_ord integer;
begin
  select id into bot from bots where name = 'Bot Rank';
  v := ('[1,0' || repeat(',0', 766) || ']')::vector;
  set local role service_role;

  -- 0.5 is the cap ragConfigFor enforces, and it is more than the
  -- 0.2929 that separates these two chunks — so the boosted chunk must
  -- come first despite scoring lower on raw similarity.
  select ordinal into top_ord
    from match_chunks(bot, v, 5, -1.0, 0.5) limit 1;
  reset role;

  if top_ord is distinct from 1 then
    raise exception 'ASSERTION FAILED: at boost 0.5 the top chunk was ordinal %, expected the boosted FAQ chunk (1)', top_ord;
  end if;
  raise notice '  ok   a boost wider than the similarity gap reorders';
end $$;

\echo '=== RANKING: at boost 0 relevance alone decides ==='
do $$
declare bot uuid; v vector(768); top_ord integer; def_ord integer;
begin
  select id into bot from bots where name = 'Bot Rank';
  v := ('[1,0' || repeat(',0', 766) || ']')::vector;
  set local role service_role;

  select ordinal into top_ord from match_chunks(bot, v, 5, -1.0, 0.0) limit 1;

  -- And at the shipped default of 0.05, which is deliberately far
  -- SMALLER than the gap: the boost is a tie-breaker, not a pin. A
  -- change that made it a pin would pass the assertion above and fail
  -- this one, which is the whole reason both exist.
  select ordinal into def_ord from match_chunks(bot, v, 5, -1.0, 0.05) limit 1;
  reset role;

  if top_ord is distinct from 0 then
    raise exception 'ASSERTION FAILED: at boost 0 the top chunk was ordinal %, expected the most similar (0)', top_ord;
  end if;
  if def_ord is distinct from 0 then
    raise exception 'ASSERTION FAILED: the 0.05 default boost overruled a 0.29 similarity gap (top was ordinal %)', def_ord;
  end if;
  raise notice '  ok   the boost breaks ties, it does not pin';
end $$;

\echo '=== RANKING: the floor tests RAW similarity, not the boosted score ==='
do $$
declare bot uuid; v vector(768); got int;
begin
  select id into bot from bots where name = 'Bot Rank';
  v := ('[1,0' || repeat(',0', 766) || ']')::vector;
  set local role service_role;

  -- 012 states this in a comment and nothing checked it. The boosted
  -- chunk's raw similarity is 0.7071; with a 0.5 boost its ordering
  -- score is 1.2071. A floor of 0.9 must therefore reject it — if the
  -- floor were ever moved after the boost, it would not, and a chunk
  -- nowhere near relevant would reach a visitor because a tenant had
  -- marked it important.
  select count(*) into got
    from match_chunks(bot, v, 5, 0.9, 0.5)
   where ordinal = 1;
  reset role;

  if got <> 0 then
    raise exception 'ASSERTION FAILED: the boost smuggled a 0.71 chunk past a 0.9 floor';
  end if;
  raise notice '  ok   min_similarity is applied before the boost, never after';
end $$;


-- ----------------------------------------------------------------
-- The lexical overlap gate
--
-- `ov.hits * 2 >= tq.n` — at least half the distinct lexemes a visitor
-- typed must appear in the chunk. It is the counterweight to the OR-ed
-- tsquery, and since 013 it is the ONLY thing standing between hybrid
-- mode and an unreachable `missedRetrieval`. Two assertions, one either
-- side of the line.
-- ----------------------------------------------------------------
\echo '=== RANKING: the overlap gate rejects one lexeme in five ==='
do $$
declare bot uuid; got int;
begin
  select id into bot from bots where name = 'Bot Rank';
  set local role service_role;

  -- Five distinct lexemes, of which only 'insurance' appears in the
  -- FAQ chunk. 1 * 2 >= 5 is false, so nothing may come back — this is
  -- the noise an OR-ed tsquery would otherwise drag out of every
  -- document sharing one common word.
  select count(*) into got
    from match_chunks_lexical(bot, 'wombat trampoline insurance saxophone glacier', 10, 0::smallint);
  reset role;

  if got <> 0 then
    raise exception 'ASSERTION FAILED: one lexeme in five matched % rows', got;
  end if;
  raise notice '  ok   one term in five is not a match';
end $$;

\echo '=== RANKING: the overlap gate accepts three lexemes in five ==='
do $$
declare bot uuid; got int;
begin
  select id into bot from bots where name = 'Bot Rank';
  set local role service_role;

  -- 'do', 'you', 'accept' and 'insurance' are all in the chunk; 'u' is
  -- not. 4 * 2 >= 5, so it matches — and this is the exact query 011
  -- rewrote the function for, since an AND-ed tsquery under 'simple'
  -- would require the literal 'u' and find nothing.
  select count(*) into got
    from match_chunks_lexical(bot, 'do u accept insurance', 10, 0::smallint);
  reset role;

  if got < 1 then
    raise exception 'ASSERTION FAILED: a mostly-overlapping question matched nothing';
  end if;
  raise notice '  ok   a majority of terms is a match';
end $$;

\echo '=== RANKING: a visitor may type an apostrophe or an operator ==='
do $$
declare bot uuid; got int;
begin
  select id into bot from bots where name = 'Bot Rank';
  set local role service_role;

  -- The quote_literal case. Without it these are tsquery SYNTAX ERRORS
  -- on text a visitor merely typed — a 500 on the chat path, waiting
  -- for the right question. Zero rows is a fine answer; an exception is
  -- not, so the assertion is that these all return.
  select count(*) into got from match_chunks_lexical(bot, 'don''t you accept insurance', 10, 0::smallint);
  select count(*) into got from match_chunks_lexical(bot, 'insurance & parking', 10, 0::smallint);
  select count(*) into got from match_chunks_lexical(bot, 'parking | insurance !', 10, 0::smallint);
  select count(*) into got from match_chunks_lexical(bot, 'insurance <-> parking', 10, 0::smallint);
  reset role;

  raise notice '  ok   apostrophes and tsquery operators are literals, not syntax';
end $$;


-- ----------------------------------------------------------------
-- M4 — the priority gate is a parameter now (013)
-- ----------------------------------------------------------------
\echo '=== RANKING: p_min_priority is what separates fallback from hybrid ==='
do $$
declare bot uuid; fallback_n int; hybrid_n int; default_n int;
begin
  select id into bot from bots where name = 'Bot Rank';
  set local role service_role;

  -- 'parking' and 'access' both appear in the priority-0 prose chunk
  -- and in neither FAQ chunk. At the fallback gate it is invisible; at
  -- the hybrid gate it is exactly the proper-noun-in-a-PDF case the
  -- whole feature exists for.
  select count(*) into fallback_n from match_chunks_lexical(bot, 'parking access', 10, 1::smallint);
  select count(*) into hybrid_n   from match_chunks_lexical(bot, 'parking access', 10, 0::smallint);
  -- Omitting the argument must reproduce the fallback exactly — an old
  -- Worker against this new function may not change behaviour.
  select count(*) into default_n  from match_chunks_lexical(bot, 'parking access', 10);
  reset role;

  if fallback_n <> 0 then
    raise exception 'ASSERTION FAILED: the fallback gate returned % prose rows', fallback_n;
  end if;
  if hybrid_n < 1 then
    raise exception 'ASSERTION FAILED: the hybrid gate could not reach a prose chunk';
  end if;
  if default_n <> fallback_n then
    raise exception 'ASSERTION FAILED: the default p_min_priority changed behaviour (% vs %)', default_n, fallback_n;
  end if;
  raise notice '  ok   priority 1 keeps prose out, priority 0 lets it in, the default is unchanged';
end $$;


-- ----------------------------------------------------------------
-- S2 — bots.chunk_count (013)
--
-- The counter has to survive the one statement shape that actually
-- happens: replaceChunks is delete-then-insert of every row for a
-- document, inside one transaction.
-- ----------------------------------------------------------------
\echo '=== RANKING: chunk_count tracks inserts, deletes and a replace ==='
do $$
declare bot uuid; doc uuid; n int;
begin
  select id into bot from bots where name = 'Bot Rank';
  select id into doc from documents where bot_id = bot limit 1;
  set local role service_role;

  select chunk_count into n from bots where id = bot;
  if n <> 3 then
    raise exception 'ASSERTION FAILED: chunk_count was % after the fixture insert, expected 3', n;
  end if;

  -- The delete-then-insert cycle, in one transaction, exactly as
  -- replaceChunks issues it.
  delete from chunks where document_id = doc;
  insert into chunks (document_id, bot_id, ordinal, content)
  values (doc, bot, 0, 'one'), (doc, bot, 1, 'two');

  select chunk_count into n from bots where id = bot;
  if n <> 2 then
    raise exception 'ASSERTION FAILED: chunk_count was % after a replace, expected 2', n;
  end if;

  delete from chunks where document_id = doc;
  select chunk_count into n from bots where id = bot;
  if n <> 0 then
    raise exception 'ASSERTION FAILED: chunk_count was % after deleting everything, expected 0', n;
  end if;
  reset role;

  raise notice '  ok   chunk_count is exact across delete-then-insert';
end $$;

\echo '=== RANKING: cleanup ==='
do $$
declare bot uuid;
begin
  select id into bot from bots where name = 'Bot Rank';
  set local role service_role;
  -- Cascades to documents and chunks. Removed so the row counts the
  -- other files in this directory assert on are untouched by this one.
  delete from bots where id = bot;
  reset role;
  raise notice '  ok   ranking fixture removed';
end $$;
