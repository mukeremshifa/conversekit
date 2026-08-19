#!/usr/bin/env node
/**
 * Local RLS regression test — no network, no Supabase project.
 *
 * Applies every migration in order against a throwaway Postgres
 * database, then asserts the tenancy policies actually isolate:
 * cross-tenant reads and writes, privilege escalation, the policy
 * recursion trap, anon lockdown, and service_role bypass.
 *
 * Complements scripts/verify-isolation.mjs, which exercises the same
 * guarantees through the deployed Worker and a real Supabase project.
 * This one is the fast inner loop — run it after touching any policy.
 *
 * Needs psql on PATH and a Postgres you can create databases on.
 *
 *   npm run verify:rls
 *   PGURL=postgres://postgres@127.0.0.1:5432 npm run verify:rls
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const PGURL = process.env.PGURL ?? 'postgres://postgres@127.0.0.1:55432';
const DB    = process.env.PGDATABASE_TEST ?? 'conversekit_rls_test';

const MIGRATIONS = [
  join(HERE, 'rls', '00-supabase-stub.sql'),
  join(ROOT, 'supabase', '001_init.sql'),
  join(ROOT, 'supabase', '002_phase1.sql'),
  join(ROOT, 'supabase', '004_provider_config.sql'),
  join(ROOT, 'supabase', '003_tenancy.sql'),
  // 006 and 007 need no pgvector, so they belong in the base set.
  join(ROOT, 'supabase', '006_client_ready.sql'),
  join(ROOT, 'supabase', '007_org_recovery.sql'),
  join(HERE, 'rls', 'rls-test.sql'),
];

/**
 * 005 needs pgvector, which a stock Postgres install does not ship.
 * Skipping is reported loudly rather than passed over silently — a
 * green run that quietly tested less than you think is worse than a
 * red one. The RAG policies are covered by verify:isolation, which
 * runs against Supabase where the extension exists.
 */
const RAG_MIGRATIONS = [
  join(ROOT, 'supabase', '005_rag.sql'),
  join(HERE, 'rls', 'rag-test.sql'),
  // 008 extends the documents table 005 creates, so it is gated on
  // pgvector for the same reason.
  join(ROOT, 'supabase', '008_files.sql'),
  join(HERE, 'rls', 'files-test.sql'),
  // 011 alters chunks (a vector table) and changes match_chunks'
  // signature, so it is gated the same way.
  join(ROOT, 'supabase', '011_knowledge.sql'),
  join(HERE, 'rls', 'knowledge-test.sql'),
  // 012 recreates both retrieval RPCs, so it takes vector arguments
  // and is gated for the same reason. Its own assertions cover the new
  // table's policies and — the one worth having — that
  // prune_retrieval_log clamps its window rather than truncating.
  join(ROOT, 'supabase', '012_retrieval.sql'),
  join(HERE, 'rls', 'retrieval-test.sql'),
  // 013 recreates both RPCs again (a lexical priority parameter and
  // hnsw.iterative_scan) and adds bots.chunk_count, so it is gated for
  // the same reason. ranking-test.sql is the one open housekeeping item
  // from the phase 1 audit: the priority boost and the lexical overlap
  // gate were verified by hand against the live database during 011 and
  // were covered nowhere. It builds its own fixture with hand-written
  // embeddings, because ranking needs known distances.
  join(ROOT, 'supabase', '013_hybrid.sql'),
  join(HERE, 'rls', 'ranking-test.sql'),
];

/**
 * psql writes RAISE NOTICE to stderr, and the assertions in
 * rls-test.sql are notices — so both streams have to be captured or
 * the checks run invisibly.
 */
function psql(args, { db = null } = {}) {
  const r = spawnSync('psql', [db ? `${PGURL}/${db}` : PGURL, '-q', '-v', 'ON_ERROR_STOP=1', ...args],
    { encoding: 'utf8' });
  if (r.error) throw r.error;
  const output = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  if (r.status !== 0) {
    const err = new Error(`psql exited ${r.status}`);
    err.output = output;
    throw err;
  }
  return output;
}

try {
  psql(['-c', `drop database if exists ${DB};`, '-c', `create database ${DB};`]);
} catch (err) {
  console.error(`Could not reach Postgres at ${PGURL}\n${err.output || err.message}`);
  console.error('\nSet PGURL, or start a throwaway cluster:\n' +
                '  initdb -D /tmp/ckpg -U postgres --auth=trust\n' +
                '  pg_ctl -D /tmp/ckpg -o "-p 55432" start');
  process.exit(2);
}

let hasVector = false;
try {
  hasVector = psql(['-tAc', "select 1 from pg_available_extensions where name='vector'"]).trim().startsWith('1');
} catch { /* treated as absent */ }

const FILES = hasVector ? [...MIGRATIONS, ...RAG_MIGRATIONS] : MIGRATIONS;

let failed = false;
let checks = 0;
for (const file of FILES) {
  const label = file.split(/[\\/]/).pop();
  try {
    const out = psql(['-f', file], { db: DB });
    // Assertions arrive as NOTICEs from the assert() helper in rls-test.sql.
    const lines = out.split('\n')
      .map((l) => l.replace(/^.*?NOTICE:\s+/, '').trimEnd())
      .filter((l) => /^ok\s/.test(l.trim()) || l.startsWith('==='));
    console.log(lines.length ? lines.join('\n') : `applied ${label}`);
    if (lines.length) checks += lines.filter((l) => l.trim().startsWith('ok ')).length;
  } catch (err) {
    failed = true;
    const msg = (err.output || err.message).split('\n')
      .filter((l) => l.includes('ASSERTION') || l.includes('ERROR')).join('\n');
    console.error(`\nFAILED in ${label}:\n${msg || err.output || err.message}`);
    break;
  }
}

if (!failed) {
  try { psql(['-c', `drop database if exists ${DB};`]); } catch { /* leave it for inspection */ }
}

if (!hasVector) {
  console.log('\n=== RAG schema (005) and file sources (008) ===');
  console.log('  SKIPPED — pgvector is not installed on this Postgres.');
  console.log('  Those policies are covered by `npm run verify:isolation`,');
  console.log('  which runs against Supabase where the extension exists.');
}

console.log(failed ? '\nRLS verification FAILED.\n' : `\nRLS verification passed — ${checks} assertions.\n`);
process.exit(failed ? 1 : 0);
