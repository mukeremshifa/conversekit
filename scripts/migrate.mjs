#!/usr/bin/env node
/**
 * Migration runner for supabase/*.sql
 *
 * Replaces "paste it into the SQL Editor and hope you remember which
 * ones you already ran". Every migration this project has shipped was
 * applied by hand, which is how a Worker once got deployed ahead of the
 * schema it needed and broke bot creation in production.
 *
 *   npm run db:status              what is applied, what is pending
 *   npm run db:migrate             apply everything pending
 *   npm run db:migrate -- --dry-run
 *   npm run db:baseline            record existing files as applied
 *                                  WITHOUT running them (first-time setup
 *                                  on a database that was migrated by hand)
 *
 * Two transports, whichever credential you have. Both go in .dev.vars:
 *
 *   SUPABASE_ACCESS_TOKEN=sbp_...     Management API. Create at
 *                                     supabase.com/dashboard/account/tokens
 *                                     Preferred: revocable, and never
 *                                     needs the database password.
 *
 *   SUPABASE_DB_URL=postgresql://...  Direct connection, run through psql.
 *                                     Dashboard → Project Settings →
 *                                     Database → Connection string.
 *
 * The project ref is read from SUPABASE_URL, so neither transport needs
 * it configured separately.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it never runs against a database
 * it was not pointed at explicitly, it never rolls anything back (there
 * is no point-in-time recovery on this project's plan), and it refuses
 * to apply a file whose contents changed after it was applied.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'supabase');

// ---------------------------------------------------------------
// Config. .dev.vars is the project's existing secret store; reading it
// here means the runner needs no separate setup.
// ---------------------------------------------------------------
function loadDevVars() {
  const path = join(ROOT, '.dev.vars');
  if (!existsSync(path)) return {};
  const out = {};
  // Normalise CRLF first. `\r` is a line terminator to a JS regex, so a
  // trailing one puts the value past what `.*$` will match and every
  // line silently fails to parse — which presents as "no credentials
  // configured" while the file plainly has them.
  for (const line of readFileSync(path, 'utf8').replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...loadDevVars(), ...process.env };
const { SUPABASE_URL, SUPABASE_ACCESS_TOKEN, SUPABASE_DB_URL } = env;

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('-')) ?? 'status';
const dryRun = args.includes('--dry-run');

if (!['status', 'up', 'migrate', 'baseline'].includes(command)) {
  console.error(`Unknown command '${command}'. Use: status | up | baseline`);
  process.exit(2);
}

const projectRef = (() => {
  if (!SUPABASE_URL) return null;
  return /^https?:\/\/([a-z0-9-]+)\.supabase\./i.exec(SUPABASE_URL)?.[1] ?? null;
})();

// ---------------------------------------------------------------
// Transports
// ---------------------------------------------------------------
/**
 * Two operations, not one. `run` executes and ignores output; `query`
 * has to come back as rows.
 *
 * They are separate because the transports disagree about what a result
 * is: the Management API answers in JSON, while psql answers in text and
 * has to be asked for JSON explicitly. An earlier version of this file
 * had a single `execute` and fed psql's stdout to `Array.isArray`, which
 * was quietly always false — so the ledger read as empty and every
 * migration looked pending, on a database where they had all been run.
 */
async function apiCall(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });

  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 800);
    try { detail = JSON.parse(text).message ?? JSON.parse(text).error ?? detail; } catch { /* keep raw */ }
    throw new Error(`Management API ${res.status}: ${detail}`);
  }
  try { return text ? JSON.parse(text) : []; } catch { return []; }
}

function psqlCall(args, input) {
  const r = spawnSync('psql', [SUPABASE_DB_URL, '-v', 'ON_ERROR_STOP=1', ...args],
    { input, encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim().slice(0, 800));
  return r.stdout;
}

const useApi = !!(SUPABASE_ACCESS_TOKEN && projectRef);

/** Execute SQL. Output is not needed. */
const run = useApi
  ? apiCall
  // --single-transaction so a migration that fails halfway leaves the
  // schema exactly as it was, rather than half-applied.
  : async (sql) => { psqlCall(['-q', '--single-transaction', '-f', '-'], sql); };

/** Execute a SELECT and return its rows. */
const query = useApi
  ? async (sql) => {
      const rows = await apiCall(sql);
      return Array.isArray(rows) ? rows : [];
    }
  : async (sql) => {
      // psql speaks text, so ask Postgres for the JSON directly rather
      // than trying to parse a table off stdout.
      const wrapped = `select coalesce(json_agg(t), '[]'::json)::text from (${sql.replace(/;\s*$/, '')}) t;`;
      const out = psqlCall(['-tAqc', wrapped]).trim();
      try { return JSON.parse(out || '[]'); } catch { return []; }
    };

if (!SUPABASE_ACCESS_TOKEN && !SUPABASE_DB_URL) {
  console.error(`
No way to reach the database.

Add ONE of these to .dev.vars:

  SUPABASE_ACCESS_TOKEN=sbp_...
      Create at https://supabase.com/dashboard/account/tokens
      Recommended — revocable, and it never needs the database password.
      ${projectRef ? `Project ref '${projectRef}' was read from SUPABASE_URL.`
                   : 'SUPABASE_URL must also be set so the project ref can be derived.'}

  SUPABASE_DB_URL=postgresql://postgres:PASSWORD@db.${projectRef ?? '<ref>'}.supabase.co:5432/postgres
      Dashboard → Project Settings → Database → Connection string.
      Needs psql on PATH.
`);
  process.exit(2);
}

const transport = useApi ? 'Management API' : 'psql';

// ---------------------------------------------------------------
// Migration files
// ---------------------------------------------------------------
const files = readdirSync(DIR)
  .filter((f) => /^\d+.*\.sql$/.test(f))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

const sha = (s) => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);

const migrations = files.map((file) => {
  const sql = readFileSync(join(DIR, file), 'utf8');
  return { version: file.replace(/\.sql$/, ''), file, sql, checksum: sha(sql) };
});

// ---------------------------------------------------------------
const LEDGER = `
create table if not exists public.schema_migrations (
  version    text primary key,
  checksum   text not null,
  applied_at timestamptz not null default now()
);
-- Tenants have no business reading the schema history. Guarded on the
-- roles existing so the runner also works against a plain Postgres,
-- where anon and authenticated are Supabase's inventions and absent.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on public.schema_migrations from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on public.schema_migrations from authenticated;
  end if;
end $$;
`;

async function applied() {
  await run(LEDGER);
  const rows = await query('select version, checksum from public.schema_migrations order by version');
  return new Map(rows.map((r) => [r.version, r.checksum]));
}

function record(m) {
  return `insert into public.schema_migrations (version, checksum) values ('${m.version}', '${m.checksum}')
          on conflict (version) do update set checksum = excluded.checksum, applied_at = now();`;
}

// ---------------------------------------------------------------
async function main() {
  // Report the database actually being written to, derived from the
  // transport in use — never from whichever config happens to be set.
  // SUPABASE_URL is present even when the run targets a local database
  // through SUPABASE_DB_URL, and printing the production project ref
  // above a local migration is how someone convinces themselves they
  // just migrated prod when they did not, or the reverse.
  const target = useApi
    ? `project ${projectRef}`
    : SUPABASE_DB_URL.replace(/\/\/[^@/]*@/, '//***@');
  console.log(`\nTarget: ${target}  (via ${transport})\n`);

  const done = await applied();
  const pending = migrations.filter((m) => !done.has(m.version));
  const changed = migrations.filter((m) => done.has(m.version) && done.get(m.version) !== m.checksum);

  if (command === 'status') {
    for (const m of migrations) {
      const state = !done.has(m.version) ? 'PENDING'
                  : done.get(m.version) !== m.checksum ? 'CHANGED SINCE APPLIED'
                  : 'applied';
      console.log(`  ${state.padEnd(22)} ${m.file}`);
    }
    console.log(`\n${pending.length} pending, ${changed.length} changed after the fact.\n`);
    if (changed.length) {
      console.log('A changed migration is not re-run automatically. Postgres has already');
      console.log('got the old version of it, so write the difference as a NEW migration');
      console.log('rather than editing history.\n');
    }
    return;
  }

  if (command === 'baseline') {
    if (!pending.length) { console.log('Nothing to baseline — every migration is already recorded.\n'); return; }
    console.log('Recording these as applied WITHOUT running them:');
    for (const m of pending) console.log(`  ${m.file}`);
    if (dryRun) { console.log('\n--dry-run: nothing written.\n'); return; }
    await run(pending.map(record).join('\n'));
    console.log(`\n${pending.length} migration(s) baselined.\n`);
    return;
  }

  // up / migrate
  if (changed.length) {
    console.log('Refusing to run: these files changed after they were applied.\n');
    for (const m of changed) console.log(`  ${m.file}`);
    console.log('\nThe database has the old version. Add a new migration with the');
    console.log('difference instead of editing one that has already run.\n');
    process.exit(1);
  }

  if (!pending.length) { console.log('Up to date — nothing to apply.\n'); return; }

  console.log(`${pending.length} migration(s) to apply:`);
  for (const m of pending) console.log(`  ${m.file}`);
  if (dryRun) { console.log('\n--dry-run: nothing applied.\n'); return; }
  console.log('');

  for (const m of pending) {
    process.stdout.write(`  applying ${m.file} … `);
    try {
      await run(m.sql);
      await run(record(m));
      console.log('ok');
    } catch (err) {
      console.log('FAILED\n');
      console.error(`${err.message}\n`);
      console.error(`${m.file} was not recorded as applied. Fix it and run again —`);
      console.error('every migration in this project is written to be safely re-runnable.\n');
      process.exit(1);
    }
  }

  console.log(`\n${pending.length} migration(s) applied.\n`);
}

main().catch((err) => { console.error(`\n${err.message}\n`); process.exit(1); });
