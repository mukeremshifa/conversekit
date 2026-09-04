#!/usr/bin/env node
/**
 * Provisions the AURAK Coding Club tenant.
 *
 *   npm run seed:club                 provision / update it
 *   npm run seed:club -- --dry-run    say what would change, touch nothing
 *   npm run seed:club -- --check      exit non-zero if it is not serving
 *
 * WHY THIS EXISTS. The club is an ordinary tenant — one org, one bot,
 * one corpus — and the event page is just a second renderer of the same
 * public /v1/chat/stream the widget uses. Nothing about the platform
 * changes to support it. What the club needs that a dashboard signup
 * does not give it is a corpus that can be REPLAYED: the knowledge is
 * club facts in docs/coding-club/*.md, edited by a human, and a
 * db:reset must not lose them.
 *
 * This is a sibling of scripts/seed-demo-bot.mjs and deliberately keeps
 * its structure, its two transports and its refusal to reach outward
 * from an owner to "their" orgs. Read that file's header for the
 * reasoning; it applies here unchanged.
 *
 * WHAT IT WILL NOT DO. It only ever writes the org and bot named by the
 * fixed ids in config/coding-club-bot.js, and the corpus underneath
 * that one bot.
 *
 * CREDENTIALS:
 *
 *   apps/api/.dev.vars   SUPABASE_URL, SUPABASE_ANON_KEY,
 *                        SUPABASE_SERVICE_ROLE_KEY
 *
 *   .env.tools           CK_CODING_CLUB_EMAIL, CK_CODING_CLUB_PASSWORD —
 *                        who owns the club org, and the dashboard login
 *                        the club's own crew uses to edit chunks.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ORIGINS, SUPABASE } from '../config/origins.js';
import {
  CLUB_ORG_ID, CLUB_BOT_ID, CLUB_ORG_NAME, CLUB_BOT, CLUB_ORIGINS,
  CLUB_FAQ, clubSources,
} from '../config/coding-club-bot.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

const DRY_RUN = has('--dry-run');
const CHECK_ONLY = has('--check');

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------
function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  // CRLF first: `\r` is a line terminator to a JS regex, so a trailing
  // one puts the value past what `.*$` matches and every line silently
  // fails to parse.
  for (const line of readFileSync(path, 'utf8').replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const devVarsPath = join(ROOT, 'apps', 'api', '.dev.vars');
const devVars = loadEnvFile(devVarsPath);
const tools = { ...loadEnvFile(join(ROOT, '.env.tools')), ...process.env };

const SUPABASE_URL = devVars.SUPABASE_URL;
const ANON_KEY = devVars.SUPABASE_ANON_KEY;
const SERVICE_KEY = devVars.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_KEY) {
  fail(
    `Missing Supabase credentials in ${devVarsPath}.\n` +
    'Needs SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.',
  );
}

// Same check seed-demo-bot.mjs makes, for the same reason: signing in
// against one project while the API trusts another looks like it works
// and then 401s on every admin call.
if (SUPABASE.url.replace(/\/+$/, '') !== SUPABASE_URL.replace(/\/+$/, '')) {
  fail(
    'Supabase project mismatch — the dashboard and the API would be pointed at\n' +
    'different databases:\n\n' +
    `  config/origins.js  ${SUPABASE.url}\n` +
    `  ${devVarsPath}  ${SUPABASE_URL}\n`,
  );
}

const OWNER_EMAIL = tools.CK_CODING_CLUB_EMAIL;
const OWNER_PASSWORD = tools.CK_CODING_CLUB_PASSWORD;

if (!CHECK_ONLY && (!OWNER_EMAIL || !OWNER_PASSWORD)) {
  fail(
    'No coding-club owner configured. Add to .env.tools:\n\n' +
    '  CK_CODING_CLUB_EMAIL=club@example.com\n' +
    '  CK_CODING_CLUB_PASSWORD=<a password you choose>\n\n' +
    'The account is created on first run if it does not exist, and is the login the\n' +
    `club then uses to edit its own chunks at\n  ${ORIGINS.app}`,
  );
}

const API_BASE = ORIGINS.api;

// ---------------------------------------------------------------
// Transport
// ---------------------------------------------------------------
const svcHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

/** PostgREST as service_role. */
async function rest(path, { method = 'GET', body, prefer } = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    method,
    headers: { ...svcHeaders, ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`REST ${method} ${path} → ${r.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** The Worker's admin API as the owner. */
async function admin(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  if (!r.ok) throw new Error(`API ${method} ${path} → ${r.status} ${text.slice(0, 300)}`);
  return json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------
let changes = 0;
const did = (what) => { changes++; console.log(`  ${DRY_RUN ? 'would' : 'ok   '}  ${what}`); };
const same = (what) => console.log(`  same   ${what}`);

// ---------------------------------------------------------------
// Owner
// ---------------------------------------------------------------
async function ownerSession() {
  const signIn = async () => {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    });
    return r.ok ? (await r.json()).access_token : null;
  };

  const existing = await signIn();
  if (existing) {
    same(`owner ${OWNER_EMAIL} signed in`);
    return existing;
  }

  const found = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(OWNER_EMAIL)}`,
    { headers: svcHeaders },
  ).then((r) => (r.ok ? r.json() : { users: [] }));

  const already = (found.users ?? []).some(
    (u) => (u.email ?? '').toLowerCase() === OWNER_EMAIL.toLowerCase(),
  );
  if (already) {
    fail(
      `An account for ${OWNER_EMAIL} exists but CK_CODING_CLUB_PASSWORD does not sign in.\n` +
      'Fix the password in .env.tools, or reset it from the Supabase dashboard.',
    );
  }

  if (DRY_RUN) {
    did(`create owner account ${OWNER_EMAIL}`);
    return null;
  }

  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: svcHeaders,
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD, email_confirm: true }),
  });
  if (!r.ok) fail(`Could not create ${OWNER_EMAIL}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  did(`created owner account ${OWNER_EMAIL}`);

  // Signup fires handle_new_user, which provisions a personal org and an
  // empty bot. That org is left entirely alone — the club bot gets its
  // own, because supabase/002 allows one bot per org.
  const token = await signIn();
  if (!token) fail('Created the owner account but could not sign in as it.');
  return token;
}

// ---------------------------------------------------------------
// Rows
// ---------------------------------------------------------------
async function seedOrg(userId) {
  const [org] = await rest(`/organizations?id=eq.${CLUB_ORG_ID}&select=id,name`);
  if (!org) {
    if (DRY_RUN) { did(`create org "${CLUB_ORG_NAME}"`); }
    else {
      await rest('/organizations', {
        method: 'POST',
        prefer: 'return=minimal',
        body: { id: CLUB_ORG_ID, name: CLUB_ORG_NAME, slug: `org-${CLUB_ORG_ID.replace(/-/g, '')}` },
      });
      did(`created org "${CLUB_ORG_NAME}"`);
    }
  } else if (org.name !== CLUB_ORG_NAME) {
    if (!DRY_RUN) await rest(`/organizations?id=eq.${CLUB_ORG_ID}`, { method: 'PATCH', prefer: 'return=minimal', body: { name: CLUB_ORG_NAME } });
    did(`renamed org to "${CLUB_ORG_NAME}"`);
  } else {
    same(`org "${CLUB_ORG_NAME}"`);
  }

  if (!userId) return;

  const members = await rest(
    `/memberships?org_id=eq.${CLUB_ORG_ID}&user_id=eq.${userId}&select=role`,
  );
  if (!members.length) {
    if (DRY_RUN) { did(`add ${OWNER_EMAIL} as owner`); }
    else {
      await rest('/memberships', {
        method: 'POST',
        prefer: 'return=minimal',
        body: { org_id: CLUB_ORG_ID, user_id: userId, role: 'owner' },
      });
      did(`added ${OWNER_EMAIL} as owner`);
    }
  } else {
    same(`${OWNER_EMAIL} is ${members[0].role}`);
  }
}

async function seedBot() {
  const row = {
    ...CLUB_BOT,
    id: CLUB_BOT_ID,
    org_id: CLUB_ORG_ID,
    allowed_origins: CLUB_ORIGINS,
    // Deprecated and still written: src/supabase.ts createBot writes it
    // on every insert and allowedOriginsFor still reads it as a
    // fallback. A bot that skipped it would be shaped differently from
    // every other row on the platform.
    allowed_origin: CLUB_ORIGINS[0],
  };

  // Only the columns this script owns — selecting `*` would drag in
  // chunk_count and the provider blobs, none of them ours to compare.
  const owned = Object.keys(row).join(',');
  const [existing] = await rest(`/bots?id=eq.${CLUB_BOT_ID}&select=${owned}`);

  if (existing && existing.org_id !== CLUB_ORG_ID) {
    fail(
      `Bot ${CLUB_BOT_ID} exists but belongs to org ${existing.org_id}, not the club org.\n` +
      'Refusing to move it — that would be reaching into a tenant this script does not own.',
    );
  }

  // jsonb key order is not meaningful, so normalise it away before
  // comparing or every run reports a difference it then does not make.
  const canon = (v) =>
    JSON.stringify(v, (_, x) =>
      x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
        : x);

  const differs = !existing || Object.keys(row).some((k) => canon(existing[k]) !== canon(row[k]));

  if (!differs) {
    same('club bot');
  } else if (DRY_RUN) {
    did(existing ? 'update club bot' : 'create club bot');
  } else if (existing) {
    await rest(`/bots?id=eq.${CLUB_BOT_ID}`, { method: 'PATCH', prefer: 'return=minimal', body: row });
    did('updated club bot');
  } else {
    await rest('/bots', { method: 'POST', prefer: 'return=minimal', body: row });
    did('created club bot');
  }

  console.log(`         id ${CLUB_BOT_ID}`);
  console.log(`         allows ${CLUB_ORIGINS.join(', ')}`);
}

// ---------------------------------------------------------------
// Knowledge
// ---------------------------------------------------------------

/**
 * Prose sources, through the real ingest route.
 *
 * A source whose title matches is DELETED and recreated rather than
 * patched, because the ingest route embeds on create and there is no
 * "replace the content of this document" endpoint — reindex re-embeds
 * what is already stored, which is not what an edited markdown file
 * means.
 */
async function seedSources(token) {
  const sources = clubSources();
  const { documents } = await admin(`/v1/admin/bots/${CLUB_BOT_ID}/documents`, { token });

  for (const source of sources) {
    const prior = documents.filter((d) => d.title === source.title);

    // Unchanged content that indexed cleanly is left alone: re-embedding
    // costs the same tokens and produces the same chunks. `content` is
    // not in the list route's field set, so this reads the column
    // directly rather than comparing against an always-undefined field.
    const clean = prior.length === 1 && prior[0].status === 'ready'
      ? await rest(`/documents?id=eq.${prior[0].id}&select=content`)
          .then(([r]) => r?.content?.trim() === source.content.trim())
      : false;
    if (clean) { same(`source "${source.title}" (${prior[0].chunk_count ?? '?'} chunks)`); continue; }

    if (DRY_RUN) { did(`reindex source "${source.title}"`); continue; }

    for (const d of prior) await admin(`/v1/admin/documents/${d.id}`, { method: 'DELETE', token });
    const doc = await admin(`/v1/admin/bots/${CLUB_BOT_ID}/documents`, {
      method: 'POST', token,
      body: { source: source.source, title: source.title, content: source.content },
    });
    did(`ingesting source "${source.title}" (${doc.id})`);
  }
}

/**
 * FAQ rows, matched on question text.
 *
 * Every write re-triggers a full FAQ reindex server-side, so the loop
 * does nothing when an item already matches — writing all eight
 * unconditionally would kick off eight overlapping ingests, seven of
 * which lose their claim and log an AlreadyIndexing for no reason.
 */
async function seedFaq(token) {
  const { items } = await admin(`/v1/admin/bots/${CLUB_BOT_ID}/faq`, { token });
  const key = (q) => q.trim().toLowerCase();
  const byQuestion = new Map(items.map((i) => [key(i.question), i]));

  let position = 0;
  for (const entry of CLUB_FAQ) {
    const found = byQuestion.get(key(entry.question));
    byQuestion.delete(key(entry.question));

    if (!found) {
      if (DRY_RUN) { did(`add FAQ "${entry.question}"`); position++; continue; }
      await admin(`/v1/admin/bots/${CLUB_BOT_ID}/faq`, {
        method: 'POST', token,
        body: { question: entry.question, answer: entry.answer, position },
      });
      did(`added FAQ "${entry.question}"`);
    } else if (found.answer.trim() !== entry.answer.trim() || found.position !== position || !found.enabled) {
      if (DRY_RUN) { did(`update FAQ "${entry.question}"`); position++; continue; }
      await admin(`/v1/admin/faq/${found.id}`, {
        method: 'PUT', token,
        body: { question: entry.question, answer: entry.answer, position, enabled: true },
      });
      did(`updated FAQ "${entry.question}"`);
    } else {
      same(`FAQ "${entry.question}"`);
    }
    position++;
  }

  // Anything left is an item this config no longer declares.
  //
  // NOTE, and this differs from the demo bot: the club's own crew edits
  // this bot from the dashboard, so an unrecognised FAQ row may be one
  // THEY added rather than one this file dropped. Deleting it would
  // silently undo their work on the next reseed, so it is reported and
  // left alone. Remove it from the dashboard if you want it gone.
  for (const orphan of byQuestion.values()) {
    console.log(`  keep   FAQ "${orphan.question}" (added outside config/coding-club-bot.js)`);
  }
}

/**
 * Ingest is fire-and-forget behind `waitUntil`, so the seed watches the
 * document rows rather than assuming. Reporting "seeded" while every
 * chunk_count is still zero is how you get a bot that greets and then
 * cannot answer anything.
 */
async function waitForIndexing(token, timeoutMs = 120_000) {
  const started = Date.now();
  let last = '';

  while (Date.now() - started < timeoutMs) {
    const { documents } = await admin(`/v1/admin/bots/${CLUB_BOT_ID}/documents`, { token });
    const pending = documents.filter((d) => d.status === 'pending' || d.status === 'processing');
    const failed = documents.filter((d) => d.status === 'failed');
    const chunks = documents.reduce((n, d) => n + (d.chunk_count ?? 0), 0);

    const line = `  …      ${documents.length} source(s), ${chunks} chunk(s), ${pending.length} still indexing`;
    if (line !== last) { console.log(line); last = line; }

    if (!pending.length) {
      for (const d of failed) console.log(`  FAIL   "${d.title}": ${d.error ?? 'ingest failed'}`);
      return { chunks, failed: failed.length };
    }
    await sleep(3000);
  }

  console.log('  WARN   still indexing after 2 minutes — check the dashboard');
  return { chunks: 0, failed: 0 };
}

// ---------------------------------------------------------------
// Verification
//
// Each assertion is a way the bot can exist and still not work:
// /health has to answer, the event page's origin has to be allowed,
// and there has to be a corpus.
// ---------------------------------------------------------------
async function verify() {
  const r = await fetch(`${API_BASE}/v1/bots/${CLUB_BOT_ID}/health`);
  if (!r.ok) {
    console.log(`  FAIL   GET /v1/bots/${CLUB_BOT_ID}/health → ${r.status}`);
    return false;
  }
  const health = await r.json();
  console.log(`  ok     /health → ${health.businessName}, ${health.primaryColor}, ${health.suggestions?.length ?? 0} suggestion(s)`);

  const [bot] = await rest(`/bots?id=eq.${CLUB_BOT_ID}&select=allowed_origins,chunk_count`);
  const stored = bot?.allowed_origins ?? [];
  const missing = CLUB_ORIGINS.filter((o) => !stored.includes(o));
  console.log(`  ${missing.length ? 'FAIL  ' : 'ok    '} allows ${CLUB_ORIGINS.join(', ')}`);
  if (missing.length) console.log(`         missing: ${missing.join(', ')}`);

  const corpus = bot?.chunk_count ?? 0;
  console.log(`  ${corpus > 0 ? 'ok    ' : 'FAIL  '} corpus: ${corpus} chunk(s)`);

  return !missing.length && corpus > 0;
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------
const project = new URL(SUPABASE_URL).hostname.split('.')[0];
console.log(`
Target: project ${project}  api ${API_BASE}`);
if (DRY_RUN) console.log('        --dry-run: nothing will be written\n');
else console.log('');

if (CHECK_ONLY) {
  const ok = await verify();
  console.log(ok ? '\nCoding Club bot is serving.' : '\nCoding Club bot is NOT serving.');
  process.exit(ok ? 0 : 1);
}

const token = await ownerSession();

if (DRY_RUN && !token) {
  console.log('\n(dry run stops here: the rest depends on the account that would be created)');
  process.exit(0);
}

const me = await admin('/v1/admin/me', { token });
await seedOrg(me.userId);
await seedBot();
await seedSources(token);
await seedFaq(token);

if (DRY_RUN) {
  console.log(`\n${changes} change(s) would be made.`);
  process.exit(0);
}

console.log('');
const { failed } = await waitForIndexing(token);

console.log('');
const ok = await verify();

console.log(
  ok
    ? `\nCoding Club bot is serving.\n` +
      `  bot id   ${CLUB_BOT_ID}\n` +
      `  dashboard ${ORIGINS.app}  (sign in as ${OWNER_EMAIL})\n`
    : '\nSeeded, but the bot is not serving — see the failures above.\n',
);
process.exit(ok && !failed ? 0 : 1);
