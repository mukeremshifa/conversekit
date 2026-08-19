-- Knowledge pipeline assertions (011). Runs only where pgvector
-- exists, because everything here hangs off the tables 005 creates.
-- Continues from rag-test.sql and files-test.sql, which have already
-- created users A and B with one bot each and left documents behind.

\set ON_ERROR_STOP on

\echo '=== KNOWLEDGE: documents.source accepts faq, one per bot ==='
do $$
declare bot_a uuid; blocked boolean := false;
begin
  select id into bot_a from bots where name = 'Bot A';
  set local role service_role;

  insert into documents (bot_id, source, title)
  values (bot_a, 'faq', 'Frequently Asked Questions');

  -- Two FAQ documents would both index and both retrieve, doubling the
  -- weight of every FAQ answer. The partial unique index says no.
  begin
    insert into documents (bot_id, source, title)
    values (bot_a, 'faq', 'Frequently Asked Questions');
  exception when unique_violation then blocked := true;
  end;
  reset role;

  if not blocked then raise exception 'ASSERTION FAILED: a bot got two FAQ documents'; end if;
  raise notice '  ok   source accepts ''faq'', and only one per bot';
end $$;

\echo '=== KNOWLEDGE: faq_items derive org_id from the bot ==='
do $$
declare bot_b uuid; doc_b uuid; org_b uuid; got uuid;
begin
  select id into bot_b from bots where name = 'Bot B';
  select m.org_id into org_b from memberships m
   where m.user_id = '22222222-2222-2222-2222-222222222222';

  set local role service_role;
  insert into documents (bot_id, source, title)
  values (bot_b, 'faq', 'Frequently Asked Questions')
  returning id into doc_b;

  -- A forged org_id must be overridden, exactly as it is for documents
  -- and chunks. A trigger that trusted the caller would look correct
  -- while letting a tenant plant rows in someone else's org.
  insert into faq_items (bot_id, org_id, document_id, question, answer)
  values (bot_b, null, doc_b, 'B only: what is the code?', 'B confidential answer.')
  returning org_id into got;
  reset role;

  if got is distinct from org_b then
    raise exception 'ASSERTION FAILED: faq_item org_id was not derived from its bot';
  end if;
  raise notice '  ok   faq_item org_id always matches its bot''s org';
end $$;

\echo '=== KNOWLEDGE: faq_items are isolated by org ==='
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

  select assert((select count(*) from faq_items where answer like 'B confidential%') = 0,
                'A cannot see B''s FAQ items');
  select assert((select count(*) from faq_items) = 0,
                'A sees only its own FAQ items, and has none yet');
commit;

\echo '=== KNOWLEDGE: a tenant cannot write into another org''s FAQ ==='
do $$
declare bot_b uuid; doc_b uuid; blocked boolean := false;
begin
  select id into bot_b from bots where name = 'Bot B';
  select id into doc_b from documents where bot_id = bot_b and source = 'faq';
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
    insert into faq_items (bot_id, document_id, question, answer)
    values (bot_b, doc_b, 'injected', 'injected');
  exception when insufficient_privilege or check_violation or others then
    blocked := true;
  end;
  reset role;
  if not blocked then raise exception 'ASSERTION FAILED: A inserted a FAQ item into B''s bot'; end if;
  raise notice '  ok   RLS refuses a cross-org FAQ insert';
end $$;

\echo '=== KNOWLEDGE: deleting the FAQ document cascades its items ==='
do $$
declare bot_b uuid; doc_b uuid; before_n int; after_n int;
begin
  set local role service_role;
  select id into bot_b from bots where name = 'Bot B';
  select id into doc_b from documents where bot_id = bot_b and source = 'faq';
  select count(*) into before_n from faq_items where document_id = doc_b;
  delete from documents where id = doc_b;
  select count(*) into after_n from faq_items where document_id = doc_b;
  reset role;
  if before_n = 0 then raise exception 'ASSERTION FAILED: fixture had no items to cascade'; end if;
  if after_n <> 0 then raise exception 'ASSERTION FAILED: FAQ items survived their document'; end if;
  raise notice '  ok   faq_items cascade when the FAQ document is deleted';
end $$;

\echo '=== KNOWLEDGE: chunk kind and priority are constrained ==='
do $$
declare doc uuid; bot uuid; rejected int := 0;
begin
  set local role service_role;
  select d.id, d.bot_id into doc, bot from documents d limit 1;

  begin
    insert into chunks (document_id, bot_id, ordinal, content, kind)
    values (doc, bot, 900, 'x', 'spreadsheet');
  exception when check_violation then rejected := rejected + 1;
  end;

  begin
    insert into chunks (document_id, bot_id, ordinal, content, priority)
    values (doc, bot, 901, 'x', 7);
  exception when check_violation then rejected := rejected + 1;
  end;

  begin
    insert into chunks (document_id, bot_id, ordinal, content, metadata)
    values (doc, bot, 902, 'x', '"a string"'::jsonb);
  exception when check_violation then rejected := rejected + 1;
  end;
  reset role;

  if rejected <> 3 then
    raise exception 'ASSERTION FAILED: only % of 3 bad chunk rows were rejected', rejected;
  end if;
  raise notice '  ok   kind, priority and metadata reject nonsense';
end $$;

\echo '=== KNOWLEDGE: chunks default to prose at priority 0 ==='
do $$
declare doc uuid; bot uuid; k text; p smallint;
begin
  set local role service_role;
  select d.id, d.bot_id into doc, bot from documents d limit 1;
  insert into chunks (document_id, bot_id, ordinal, content)
  values (doc, bot, 903, 'A plain passage.')
  returning kind, priority into k, p;
  reset role;
  if k <> 'prose' or p <> 0 then
    raise exception 'ASSERTION FAILED: chunk defaults are % / %', k, p;
  end if;
  raise notice '  ok   an unspecified chunk is prose at priority 0';
end $$;

\echo '=== KNOWLEDGE: the tsvector is generated and indexed ==='
do $$
declare doc uuid; bot uuid; hits int;
begin
  set local role service_role;
  select d.id, d.bot_id into doc, bot from documents d limit 1;
  insert into chunks (document_id, bot_id, ordinal, content, kind, priority)
  values (doc, bot, 904,
          'Q: Do you accept insurance?' || chr(10) || 'A: Yes, we work with most major providers.',
          'faq', 1);

  select count(*) into hits from chunks c
   where c.ordinal = 904
     and c.search @@ websearch_to_tsquery('simple', 'insurance');
  reset role;
  if hits <> 1 then raise exception 'ASSERTION FAILED: the generated tsvector did not match'; end if;
  raise notice '  ok   chunks.search is populated without the application writing it';
end $$;

-- The regression this function was rewritten for. An AND-ed tsquery
-- under the 'simple' config — which drops no stopwords — requires
-- every word the visitor typed, so the phrasing a real visitor uses
-- finds nothing at all. That is the one case the fallback exists for.
\echo '=== KNOWLEDGE: lexical search matches a differently-worded question ==='
do $$
declare bot_a uuid; got int;
begin
  select id into bot_a from bots where name = 'Bot A';
  set local role service_role;

  select count(*) into got from match_chunks_lexical(bot_a, 'do u take insurance', 5);
  if got <> 1 then
    raise exception 'ASSERTION FAILED: lexical search found % rows for a reworded question', got;
  end if;

  -- And the other half of the bargain: OR-ing terms must not make it
  -- match anything that happens to share one common word.
  select count(*) into got from match_chunks_lexical(bot_a, 'do you deliver to spain', 5);
  if got <> 0 then
    raise exception 'ASSERTION FAILED: lexical search matched % unrelated rows', got;
  end if;
  reset role;
  raise notice '  ok   lexical search is OR-ed but gated on term overlap';
end $$;

\echo '=== KNOWLEDGE: match_chunks_lexical is scoped by bot and to boosted rows ==='
do $$
declare bot_a uuid; bot_b uuid; leaked int; unboosted int;
begin
  select id into bot_a from bots where name = 'Bot A';
  select id into bot_b from bots where name = 'Bot B';
  set local role service_role;

  -- Asking for B must never return A's rows, whatever the rank.
  select count(*) into leaked
    from match_chunks_lexical(bot_b, 'insurance', 50) m
    join chunks c on c.id = m.id
   where c.bot_id <> bot_b;

  -- And an ordinary prose chunk is not a candidate: keyword matching
  -- across a long document drags out passages that share a word and
  -- nothing else, which is the noise the similarity floor exists for.
  select count(*) into unboosted
    from match_chunks_lexical(bot_a, 'passage plain', 50) m
    join chunks c on c.id = m.id
   where c.priority = 0;
  reset role;

  if leaked > 0 then raise exception 'ASSERTION FAILED: lexical search crossed bots'; end if;
  if unboosted > 0 then raise exception 'ASSERTION FAILED: lexical search returned an unboosted chunk'; end if;
  raise notice '  ok   match_chunks_lexical stays inside one bot and one priority band';
end $$;

\echo '=== KNOWLEDGE: the boost orders, it does not bypass the floor ==='
do $$
declare bot_a uuid; v vector(768); floored int;
begin
  select id into bot_a from bots where name = 'Bot A';
  set local role service_role;
  select embedding into v from chunks where bot_id = bot_a and embedding is not null limit 1;

  -- A floor of 2.0 is unreachable: cosine similarity tops out at 1, so
  -- no boost, however large, may let a row through.
  select count(*) into floored from match_chunks(bot_a, v, 50, 2.0, 0.5);
  reset role;

  if floored > 0 then
    raise exception 'ASSERTION FAILED: the priority boost smuggled a chunk past min_similarity';
  end if;
  raise notice '  ok   the boost affects ordering only';
end $$;

\echo '=== KNOWLEDGE: match_chunks still refuses to cross bots ==='
do $$
declare bot_a uuid; bot_b uuid; leaked int;
begin
  select id into bot_a from bots where name = 'Bot A';
  select id into bot_b from bots where name = 'Bot B';
  set local role service_role;
  select count(*) into leaked
    from match_chunks(bot_b, (select embedding from chunks where bot_id = bot_a and embedding is not null limit 1), 50, -1.0, 0.05) m
    join chunks c on c.id = m.id
   where c.bot_id <> bot_b;
  reset role;
  if leaked > 0 then raise exception 'ASSERTION FAILED: match_chunks returned another bot''s chunks'; end if;
  raise notice '  ok   the new signature keeps the bot filter';
end $$;

\echo '=== KNOWLEDGE: anon cannot reach faq_items ==='
do $$
declare blocked boolean := false;
begin
  begin
    set local role anon;
    perform count(*) from faq_items;
  exception when insufficient_privilege then blocked := true;
  end;
  reset role;
  if not blocked then raise exception 'ASSERTION FAILED: anon can read faq_items'; end if;
  raise notice '  ok   anon has no access to faq_items';
end $$;

\echo '=== KNOWLEDGE: the prompt-text caps guard new writes ==='
do $$
declare rejected boolean := false;
begin
  set local role service_role;
  begin
    update bots set custom_instructions = repeat('x', 2001) where name = 'Bot A';
  exception when check_violation then rejected := true;
  end;
  reset role;
  if not rejected then
    raise exception 'ASSERTION FAILED: an over-long custom_instructions was stored';
  end if;
  raise notice '  ok   NOT VALID constraints still check every new write';
end $$;
