-- File-source assertions (Phase 2B). Runs only where pgvector exists,
-- because the documents table itself arrives with 005_rag.sql.
-- Continues from rag-test.sql, which has already created users A and B
-- with one bot each and left some documents behind.

\set ON_ERROR_STOP on

\echo '=== FILES: source accepts file, and only the four known kinds ==='
do $$
declare bot_a uuid; rejected boolean := false;
begin
  select id into bot_a from bots where name = 'Bot A';
  set local role service_role;

  insert into documents (bot_id, source, title, r2_key, mime_type, size_bytes)
  values (bot_a, 'file', 'A handbook.pdf', 'org/bot/handbook.pdf', 'application/pdf', 1024);

  begin
    insert into documents (bot_id, source, title)
    values (bot_a, 'video', 'nope');
  exception when check_violation then rejected := true;
  end;
  reset role;

  if not rejected then raise exception 'ASSERTION FAILED: an unknown source was accepted'; end if;
  raise notice '  ok   source accepts ''file'' and still rejects unknown kinds';
end $$;

\echo '=== FILES: one document per R2 object ==='
do $$
declare bot_a uuid; bot_b uuid; blocked boolean := false;
begin
  select id into bot_a from bots where name = 'Bot A';
  select id into bot_b from bots where name = 'Bot B';
  set local role service_role;
  begin
    -- The dangerous shape: B's document pointed at A's object.
    insert into documents (bot_id, source, title, r2_key, mime_type, size_bytes)
    values (bot_b, 'file', 'stolen', 'org/bot/handbook.pdf', 'application/pdf', 1024);
  exception when unique_violation then blocked := true;
  end;
  reset role;
  if not blocked then raise exception 'ASSERTION FAILED: two documents share one r2_key'; end if;
  raise notice '  ok   an R2 key cannot be claimed by a second document';
end $$;

\echo '=== FILES: storage is counted per org ==='
do $$
declare org_a uuid; used bigint;
begin
  select org_id into org_a from bots where name = 'Bot A';
  set local role service_role;
  select org_storage_bytes(org_a) into used;
  reset role;
  if used <> 1024 then
    raise exception 'ASSERTION FAILED: expected 1024 bytes counted, got %', used;
  end if;
  raise notice '  ok   org_storage_bytes sums only that org''s files';
end $$;

\echo '=== FILES: the per-org cap is enforced in the database ==='
do $$
declare bot_a uuid; blocked boolean := false; msg text;
begin
  select id into bot_a from bots where name = 'Bot A';
  set local role service_role;
  begin
    -- 100 MB + 1. The Worker rejects this long before Postgres sees it;
    -- the point is that a caller who skips the Worker is still stopped.
    insert into documents (bot_id, source, title, r2_key, mime_type, size_bytes)
    values (bot_a, 'file', 'too big', 'org/bot/huge.pdf', 'application/pdf', 104857601);
  exception when others then
    blocked := true;
    msg := sqlerrm;
  end;
  reset role;
  if not blocked then raise exception 'ASSERTION FAILED: the org storage cap did not fire'; end if;
  if msg not like 'Storage limit reached%' then
    raise exception 'ASSERTION FAILED: cap fired with an unhelpful message: %', msg;
  end if;
  raise notice '  ok   an over-cap insert is rejected with a legible message';
end $$;

\echo '=== FILES: a tenant cannot read another org''s r2_key ==='
do $$
declare leaked int;
begin
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated"}';
  select count(*) into leaked from documents where r2_key is not null;
  reset role;
  if leaked <> 0 then
    raise exception 'ASSERTION FAILED: B can see % file document(s) belonging to A', leaked;
  end if;
  raise notice '  ok   r2_key is invisible across tenants';
end $$;
