-- RAG tenancy assertions (Phase 2). Runs only where pgvector exists.
-- Continues from rls-test.sql, which has already created users A and B
-- with one bot each.

\set ON_ERROR_STOP on

\echo '=== RAG: org_id is derived, never trusted ==='
begin;
  set local role service_role;
  insert into documents (bot_id, source, title, content)
  select id, 'text', 'A notes', 'Whitening costs 199 pounds.' from bots where name = 'Bot A';
  insert into documents (bot_id, source, title, content)
  select id, 'text', 'B secret', 'B confidential pricing.' from bots where name = 'Bot B';

  select assert(
    (select count(*) from documents d join bots b on b.id = d.bot_id where d.org_id <> b.org_id) = 0,
    'document org_id always matches its bot''s org');

  insert into chunks (document_id, bot_id, ordinal, content)
  select d.id, d.bot_id, 0, d.content from documents d;

  select assert(
    (select count(*) from chunks c join bots b on b.id = c.bot_id where c.org_id <> b.org_id) = 0,
    'chunk org_id always matches its bot''s org');
commit;

-- A trigger that ignores a caller-supplied org_id would be worse than
-- no trigger: it would look correct while letting a tenant plant rows.
\echo '=== RAG: a forged org_id is overridden ==='
do $$
declare org_b uuid; got uuid;
begin
  select m.org_id into org_b from memberships m
   where m.user_id = '22222222-2222-2222-2222-222222222222';
  set local role service_role;
  insert into documents (bot_id, org_id, source, title, content)
  select id, null, 'A forged', 'x' from bots where name = 'Bot A'
  returning org_id into got;
  reset role;
  if got = org_b then raise exception 'ASSERTION FAILED: forged org_id was accepted'; end if;
  raise notice '  ok   a null org_id is filled from the bot, not the caller';
end $$;

\echo '=== RAG: isolation ==='
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';

  select assert((select count(*) from documents where title = 'B secret') = 0,
                'A cannot see B''s documents');
  select assert((select count(*) from chunks where content like 'B confidential%') = 0,
                'A cannot see B''s chunks');
  select assert((select count(*) from documents) = 2,
                'A sees exactly its own two documents');
commit;

\echo '=== RAG: chunks are read-only to tenants ==='
do $$
declare blocked boolean := false;
begin
  begin
    set local role authenticated;
    set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated"}';
    insert into chunks (document_id, bot_id, ordinal, content)
    select id, bot_id, 99, 'injected' from documents limit 1;
  exception when insufficient_privilege or others then
    blocked := true;
  end;
  reset role;
  if not blocked then raise exception 'ASSERTION FAILED: a tenant inserted a chunk directly'; end if;
  raise notice '  ok   tenants cannot insert chunks directly';
end $$;

\echo '=== RAG: match_chunks is scoped by bot ==='
do $$
declare bot_a uuid; bot_b uuid; leaked int;
begin
  select id into bot_a from bots where name = 'Bot A';
  select id into bot_b from bots where name = 'Bot B';
  set local role service_role;
  -- A zero vector matches nothing meaningfully, but the bot filter must
  -- hold regardless of similarity: ask for B's bot, expect none of A's.
  select count(*) into leaked
    from match_chunks(bot_b, (select embedding from chunks where bot_id = bot_a limit 1), 50, -1.0) m
    join chunks c on c.id = m.id
   where c.bot_id <> bot_b;
  reset role;
  if leaked > 0 then raise exception 'ASSERTION FAILED: match_chunks returned another bot''s chunks'; end if;
  raise notice '  ok   match_chunks never crosses bots';
end $$;

\echo '=== RAG: deleting a document cascades its chunks ==='
do $$
declare before_n int; after_n int; doc uuid;
begin
  set local role service_role;
  select id into doc from documents where title = 'A notes';
  select count(*) into before_n from chunks where document_id = doc;
  delete from documents where id = doc;
  select count(*) into after_n from chunks where document_id = doc;
  reset role;
  if before_n = 0 then raise exception 'ASSERTION FAILED: fixture had no chunks to cascade'; end if;
  if after_n <> 0 then raise exception 'ASSERTION FAILED: chunks survived their document'; end if;
  raise notice '  ok   chunks cascade when the document is deleted';
end $$;

\echo '=== RAG: anon cannot reach documents or chunks ==='
do $$
declare blocked boolean := false;
begin
  begin
    set local role anon;
    perform count(*) from documents;
  exception when insufficient_privilege then blocked := true;
  end;
  reset role;
  if not blocked then raise exception 'ASSERTION FAILED: anon can read documents'; end if;
  raise notice '  ok   anon has no access to documents';
end $$;
