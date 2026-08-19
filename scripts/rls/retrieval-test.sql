-- Retrieval observability assertions (012). Runs only where pgvector
-- exists, because 012 recreates match_chunks and match_chunks_lexical
-- and both take vector arguments.
--
-- Continues from rag-test.sql, files-test.sql and knowledge-test.sql,
-- which have already created users A and B with one bot each and left
-- documents and chunks behind.

\set ON_ERROR_STOP on

\echo '=== RETRIEVAL: retrieval_log derives org_id from the bot ==='
do $$
declare bot_b uuid; org_b uuid; got uuid;
begin
  select id into bot_b from bots where name = 'Bot B';
  select m.org_id into org_b from memberships m
   where m.user_id = '22222222-2222-2222-2222-222222222222';

  set local role service_role;
  -- org_id deliberately omitted. The trigger is the only thing that
  -- may set it: a caller that could supply its own would be able to
  -- file a row into another tenant's report.
  insert into retrieval_log (bot_id, query, matched, channel, top_score, chunk_count)
  values (bot_b, 'do you take insurance', true, 'vector', 0.71, 2)
  returning org_id into got;
  reset role;

  if got is distinct from org_b then
    raise exception 'ASSERTION FAILED: retrieval_log.org_id was %, expected %', got, org_b;
  end if;
  raise notice '  ok   org_id comes from the bot, never from the caller';
end $$;

\echo '=== RETRIEVAL: tenants may read their own rows and write none ==='
do $$
declare bot_b uuid; blocked boolean := false; visible int;
begin
  select id into bot_b from bots where name = 'Bot B';

  -- Derived data, exactly like chunks: readable so the miss report can
  -- render, never writable, because a tenant forging their own report
  -- is not a state worth allowing. There is no write POLICY at all —
  -- the grant is the first thing that stops this, and that is the
  -- deliberate difference from documents and faq_items.
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';

  select count(*) into visible from retrieval_log;

  begin
    insert into retrieval_log (bot_id, query, matched) values (bot_b, 'forged', false);
  exception when insufficient_privilege or check_violation then blocked := true;
  end;
  reset role;

  if visible < 1 then
    raise exception 'ASSERTION FAILED: a member cannot read their own bot''s retrieval_log';
  end if;
  if not blocked then
    raise exception 'ASSERTION FAILED: a tenant wrote a retrieval_log row';
  end if;
  raise notice '  ok   members read, tenants never write';
end $$;

\echo '=== RETRIEVAL: RLS scopes the log to the owning org ==='
do $$
declare leaked int;
begin
  -- User A must not see the row filed against Bot B above. This is the
  -- assertion that matters most on this table: it holds what visitors
  -- typed, verbatim.
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
  select count(*) into leaked from retrieval_log where query = 'do you take insurance';
  reset role;

  if leaked > 0 then
    raise exception 'ASSERTION FAILED: another org''s retrieval_log rows are readable';
  end if;
  raise notice '  ok   one tenant cannot read another''s questions';
end $$;

\echo '=== RETRIEVAL: anon cannot reach retrieval_log at all ==='
do $$
declare blocked boolean := false;
begin
  begin
    set local role anon;
    perform count(*) from retrieval_log;
  exception when insufficient_privilege then blocked := true;
  end;
  reset role;
  if not blocked then raise exception 'ASSERTION FAILED: anon can read retrieval_log'; end if;
  raise notice '  ok   anon has no access to retrieval_log';
end $$;

\echo '=== RETRIEVAL: prune_retrieval_log clamps rather than truncating ==='
do $$
declare bot_b uuid; removed int; survivors int;
begin
  select id into bot_b from bots where name = 'Bot B';
  set local role service_role;

  delete from retrieval_log;
  insert into retrieval_log (bot_id, query, matched, created_at)
  values (bot_b, 'asked yesterday', false, now() - interval '1 day'),
         (bot_b, 'asked last week', false, now() - interval '8 days'),
         (bot_b, 'asked last year', false, now() - interval '400 days');

  -- THE CLAMP IS THE ASSERTION. The Worker holds a service-role key and
  -- this is the one table where a wrong number deletes tenant data
  -- outright, so 0 must behave as 7 rather than as "everything".
  select prune_retrieval_log(0) into removed;
  select count(*) into survivors from retrieval_log;
  reset role;

  if removed <> 2 then
    raise exception 'ASSERTION FAILED: prune_retrieval_log(0) removed % rows, expected 2 (a 7-day floor)', removed;
  end if;
  if survivors <> 1 then
    raise exception 'ASSERTION FAILED: % rows survived a clamped purge, expected 1', survivors;
  end if;
  raise notice '  ok   prune_retrieval_log(0) prunes at 7 days, not 0';
end $$;

\echo '=== RETRIEVAL: prune_retrieval_log clamps the upper bound too ==='
do $$
declare bot_b uuid; removed int;
begin
  select id into bot_b from bots where name = 'Bot B';
  set local role service_role;

  delete from retrieval_log;
  insert into retrieval_log (bot_id, query, matched, created_at)
  values (bot_b, 'ancient', false, now() - interval '400 days');

  -- A number past the ceiling must not become "keep forever".
  select prune_retrieval_log(99999) into removed;
  delete from retrieval_log;
  reset role;

  if removed <> 1 then
    raise exception 'ASSERTION FAILED: prune_retrieval_log(99999) removed % rows, expected 1 (a 365-day ceiling)', removed;
  end if;
  raise notice '  ok   an over-large window clamps to 365 days';
end $$;

\echo '=== RETRIEVAL: match_chunks returns the document title ==='
do $$
declare bot_a uuid; v vector(768); titled int; total int;
begin
  select id into bot_a from bots where name = 'Bot A';
  set local role service_role;
  select embedding into v from chunks where bot_id = bot_a and embedding is not null limit 1;

  -- The S2 fold. If the join is wrong every citation in the product
  -- silently loses its source name, and nothing else would notice.
  select count(*), count(document_title)
    into total, titled
    from match_chunks(bot_a, v, 50, -1.0, 0.05);
  reset role;

  if total = 0 then
    raise exception 'ASSERTION FAILED: match_chunks returned nothing to check the title fold against';
  end if;
  if titled <> total then
    raise exception 'ASSERTION FAILED: % of % rows came back without a document_title', total - titled, total;
  end if;
  raise notice '  ok   every matched chunk names its source';
end $$;

\echo '=== RETRIEVAL: the recreated match_chunks still refuses to cross bots ==='
do $$
declare bot_a uuid; bot_b uuid; leaked int;
begin
  select id into bot_a from bots where name = 'Bot A';
  select id into bot_b from bots where name = 'Bot B';
  set local role service_role;
  -- Repeated from knowledge-test.sql on purpose: 012 dropped and
  -- recreated this function, and the tenant filter is the one property
  -- a rewrite must not lose.
  select count(*) into leaked
    from match_chunks(bot_b, (select embedding from chunks where bot_id = bot_a and embedding is not null limit 1), 50, -1.0, 0.05) m
    join chunks c on c.id = m.id
   where c.bot_id <> bot_b;
  reset role;
  if leaked > 0 then raise exception 'ASSERTION FAILED: match_chunks returned another bot''s chunks'; end if;
  raise notice '  ok   the rewritten function keeps the bot filter';
end $$;

\echo '=== RETRIEVAL: the drift columns exist and default to NULL ==='
do $$
declare unknown int;
begin
  set local role service_role;
  -- NULL is "unknown, allow". The backfill only fills bots that have a
  -- ready document with a model recorded, and these test bots' chunks
  -- were inserted directly — so the column staying NULL here is the
  -- correct outcome, and the point is that the column is there at all.
  select count(*) into unknown from bots where embedding_model_indexed is null;
  perform 1 from documents where ingest_started_at is null limit 1;
  reset role;

  if unknown < 1 then
    raise exception 'ASSERTION FAILED: expected at least one bot with an unknown indexed model';
  end if;
  raise notice '  ok   embedding_model_indexed and ingest_started_at exist, NULL by default';
end $$;
