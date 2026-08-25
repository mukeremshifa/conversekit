#!/usr/bin/env node
/**
 * Worker secret management.
 *
 *   npm run secrets:push              apps/api/.dev.vars → ck-api
 *   npm run secrets:push -- --dry-run names only, no values, no upload
 *   npm run secrets:list              what the Worker currently holds
 *
 * This exists instead of a bare `wrangler secret bulk` for two reasons,
 * each of which is a mistake that is easy to make once and expensive to
 * notice:
 *
 *  1. It pushes an ALLOWLIST, not a file. `wrangler secret bulk
 *     some.json` uploads whatever is in the file. The allowlist is the
 *     same five names declared as `secrets.required` in wrangler.jsonc,
 *     so a credential that wanders into the file does not silently
 *     acquire a home on the edge.
 *
 *  2. It never writes secrets to disk. The JSON goes to wrangler over
 *     stdin, so there is no secrets.json left in the working tree for
 *     the next `git add -A` to find.
 */
import { readFileSync, existsSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  CLOUDFLARE_API_TOKEN: 'deploys Workers — belongs to your shell or wrangler login, not a Worker secret',
};

const LF = String.fromCharCode(10);
const die = (msg) => { console.error(LF + msg + LF); process.exit(1); };

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
function readRequired() {
  const raw = readFileSync(CONFIG, 'utf8')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const cfg = JSON.parse(raw);
  return cfg?.secrets?.required ?? null;
}

// ── Arguments ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith('-')) ?? 'push';
const dryRun = args.includes('--dry-run');

if (!['push', 'list', 'bootstrap'].includes(command)) die(`Unknown command '${command}'. Use: push | bootstrap | list`);

const worker = 'ck-api';

/**
 * Run the lockfile's wrangler through node directly rather than via
 * `npx`. On Windows `npx` is `npx.cmd`, and since Node 20.12 spawnSync
 * refuses to launch a .cmd without `shell: true` — it returns
 * `error: EINVAL` with a null status. Going straight to the .js entry
 * point puts no shell in the path at all, and pins the same wrangler the
 * artifact was built with.
 */
const WRANGLER = join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

function wrangler(extra, input) {
  const r = spawnSync(
    process.execPath,
    [WRANGLER, ...extra, '--config', CONFIG],
    { input, encoding: 'utf8', stdio: input === undefined ? 'inherit' : ['pipe', 'inherit', 'inherit'] },
  );
  // A launch failure leaves status null. Checking only the status — as
  // this did — turned that into a silent exit(1) AFTER the script had
  // printed the list of secrets it was about to push, which reads
  // exactly like success. The deploy was then the thing that discovered
  // nothing had been uploaded.
  if (r.error) die(`Could not run wrangler (${r.error.code || r.error.message}).` + LF + LF + `  tried: ${WRANGLER}`);
  return r;
}

if (command === 'list') {
  const r = wrangler(['secret', 'list']);
  process.exit(r.status ?? 0);
}

// ── Push ──────────────────────────────────────────────────────────
// The same file `wrangler dev` reads, so what runs locally and what is
// uploaded to the edge come from one place.
const file = join(API, '.dev.vars');
if (!existsSync(file)) {
  die(`No ${relative(ROOT, file)}.

Copy apps/api/.dev.vars.example to apps/api/.dev.vars and fill it in.`);
}

const required = readRequired();
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

const payload = Object.fromEntries(ALLOWED.map((k) => [k, parsed[k]]));

console.log(LF + `  ${relative(ROOT, file)}  →  ${worker}` +
            (command === 'bootstrap' ? '   (first deploy)' : '') + LF);
for (const k of ALLOWED) console.log(`  push    ${k}`);
for (const k of ignored) console.log(`  skip    ${k}  (not in secrets.required)`);

if (dryRun) {
  console.log('\n  --dry-run: nothing uploaded.\n');
  process.exit(0);
}

// Over stdin, so no file of secrets is ever written to the working tree.
if (command === 'bootstrap') {
  // First deploy of a Worker that does not exist yet. `secret bulk`
  // cannot help — it needs a Worker to attach to — and `deploy` refuses
  // because secrets.required is unmet. `--secrets-file` breaks the
  // cycle: the secrets go up WITH the version, so the Worker is created
  // and satisfied in one operation.
  //
  // A file on disk is the one thing this script otherwise refuses to
  // produce, so it goes to the OS temp directory rather than the working
  // tree, and is removed whether or not the deploy succeeds.
  const dir = mkdtempSync(join(tmpdir(), 'ck-secrets-'));
  const path = join(dir, 'secrets.json');
  let status;
  try {
    writeFileSync(path, JSON.stringify(payload), { mode: 0o600 });
    status = wrangler(['deploy', '--secrets-file', path]).status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (status !== 0) die(`wrangler exited ${status}.`);
  console.log(LF + `  ${worker} created with ${ALLOWED.length} secrets.` + LF);
  process.exit(0);
}

const r = wrangler(['secret', 'bulk'], JSON.stringify(payload));
if (r.status !== 0) {
  die(`wrangler exited ${r.status} — nothing was uploaded.` + LF + LF +
      `If it said the Worker was not found, this is its first deploy:` + LF +
      `  npm run secrets:bootstrap` + LF +
      `creates it and uploads the secrets in one step.`);
}
console.log(`\n  ${ALLOWED.length} secrets on ${worker}.\n`);
