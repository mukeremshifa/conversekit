#!/usr/bin/env node
/**
 * Worker secret management.
 *
 *   npm run secrets:push                    apps/api/.dev.vars         → ck-api
 *   npm run secrets:push -- --env staging   apps/api/.dev.vars.staging → ck-api-staging
 *   npm run secrets:push -- --dry-run       names only, no values, no upload
 *   npm run secrets:list                    what the Worker currently holds
 *
 * This exists instead of a bare `wrangler secret bulk` for three
 * reasons, each of which is a mistake that is easy to make once and
 * expensive to notice:
 *
 *  1. It pushes an ALLOWLIST, not a file. `wrangler secret bulk
 *     some.json` uploads whatever is in the file. The allowlist is the
 *     same five names declared as `secrets.required` in wrangler.jsonc,
 *     so a credential that wanders into the file does not silently
 *     acquire a home on the edge.
 *
 *  2. It refuses a staging push whose SUPABASE_URL matches production's.
 *     Staging pointed at the production database is not staging, and the
 *     failure mode is a test run that quietly writes real rows.
 *
 *  3. It never writes secrets to disk. The JSON goes to wrangler over
 *     stdin, so there is no secrets.json left in the working tree for
 *     the next `git add -A` to find.
 */
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = join(ROOT, 'apps', 'api');
const CONFIG = join(API, 'wrangler.jsonc');

/** The only names that may reach the edge. Kept in step with
 *  `secrets.required` in wrangler.jsonc — the check below fails if the
 *  two ever drift, because two lists that must agree and are never
 *  compared will not agree for long. */
const ALLOWED = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
];

/** Named rather than merely absent from ALLOWED, so the refusal says
 *  why instead of "unknown key". */
const NEVER = {
  SUPABASE_ACCESS_TOKEN: 'can drop and recreate the schema — .env.tools, never the edge',
  SUPABASE_DB_URL: 'holds the database password — .env.tools, never the edge',
  CLOUDFLARE_API_TOKEN: 'deploys Workers — a GitHub Actions secret, not a Worker secret',
};

const die = (msg) => { console.error(`\n${msg}\n`); process.exit(1); };

function parseEnvFile(path) {
  const out = {};
  // Normalise CRLF first: `\r` is a line terminator to a JS regex, so a
  // trailing one puts the value past what `.*$` will match and every
  // line silently fails to parse.
  for (const line of readFileSync(path, 'utf8').replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** wrangler.jsonc is JSON with comments; strip them rather than adding a
 *  parser dependency for one read. */
function readRequired(env) {
  const raw = readFileSync(CONFIG, 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const cfg = JSON.parse(raw);
  const scope = env ? cfg.env?.[env] : cfg;
  return scope?.secrets?.required ?? null;
}

// ── Arguments ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('-')) ?? 'push';
const dryRun = args.includes('--dry-run');
const envIdx = args.indexOf('--env');
const env = envIdx === -1 ? null : args[envIdx + 1];

if (!['push', 'list'].includes(command)) die(`Unknown command '${command}'. Use: push | list`);
if (envIdx !== -1 && !env) die('--env needs a value, e.g. --env staging');

const worker = env ? `ck-api-${env}` : 'ck-api';
const wrangler = (extra, input) => spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['wrangler', ...extra, '--config', CONFIG, ...(env ? ['--env', env] : [])],
  { input, encoding: 'utf8', stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'] },
);

if (command === 'list') {
  const r = wrangler(['secret', 'list']);
  process.exit(r.status ?? 0);
}

// ── Push ──────────────────────────────────────────────────────────
// wrangler loads .dev.vars.<env> INSTEAD OF .dev.vars, not merged with
// it, so this mirrors that: one file, complete, or nothing.
const file = join(API, env ? `.dev.vars.${env}` : '.dev.vars');
if (!existsSync(file)) {
  die(`No ${relative(ROOT, file)}.

${env
  ? `Copy apps/api/.dev.vars.example to that path and point the three
SUPABASE_ values at a separate Supabase project. It replaces .dev.vars
rather than merging with it, so all ${ALLOWED.length} keys must be present.`
  : `Copy apps/api/.dev.vars.example to apps/api/.dev.vars and fill it in.`}`);
}

const required = readRequired(env);
if (!required) die(`wrangler.jsonc declares no secrets.required for ${worker}. Add it, so a deploy fails on a missing secret rather than a request 502ing.`);

const drift = [
  ...ALLOWED.filter((k) => !required.includes(k)).map((k) => `  ${k} — allowlisted here, not in wrangler.jsonc`),
  ...required.filter((k) => !ALLOWED.includes(k)).map((k) => `  ${k} — required by wrangler.jsonc, not allowlisted here`),
];
if (drift.length) die(`ALLOWED and secrets.required disagree:\n\n${drift.join('\n')}`);

const parsed = parseEnvFile(file);

const refused = Object.keys(parsed).filter((k) => k in NEVER);
if (refused.length) {
  die(`Refusing to push — ${relative(ROOT, file)} holds credentials that must never reach a Worker:\n\n${
    refused.map((k) => `  ${k}\n      ${NEVER[k]}`).join('\n')}\n\nMove them out and run again.`);
}

const missing = ALLOWED.filter((k) => !parsed[k]);
if (missing.length) die(`${relative(ROOT, file)} is missing:\n\n${missing.map((k) => `  ${k}`).join('\n')}`);

const ignored = Object.keys(parsed).filter((k) => !ALLOWED.includes(k));

// Staging sharing production's database is the failure this whole
// arrangement exists to prevent, so it is checked rather than trusted.
if (env) {
  const prod = join(API, '.dev.vars');
  if (existsSync(prod)) {
    const prodUrl = parseEnvFile(prod).SUPABASE_URL;
    if (prodUrl && prodUrl === parsed.SUPABASE_URL) {
      die(`Refusing to push — ${relative(ROOT, file)} has the same SUPABASE_URL as production.

Staging pointed at the production database is not staging: every test
run writes real rows, and db:reset would take production with it.
Create a second Supabase project, apply the migrations to it
(npm run db:reset -- --env ${env} --yes), and point this file there.`);
    }
  }
}

const payload = Object.fromEntries(ALLOWED.map((k) => [k, parsed[k]]));

console.log(`\n  ${relative(ROOT, file)}  →  ${worker}\n`);
for (const k of ALLOWED) console.log(`  push    ${k}`);
for (const k of ignored) console.log(`  skip    ${k}  (not in secrets.required)`);

if (dryRun) {
  console.log('\n  --dry-run: nothing uploaded.\n');
  process.exit(0);
}

// Over stdin, so no file of secrets is ever written to the working tree.
const r = wrangler(['secret', 'bulk'], JSON.stringify(payload));
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`\n  ${ALLOWED.length} secrets on ${worker}.\n`);
