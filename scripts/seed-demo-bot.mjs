#!/usr/bin/env node
/**
 * Provisions the demo bot on the landing page.
 *
 *   npm run seed:demo                 provision / update it
 *   npm run seed:demo -- --dry-run    say what would change, touch nothing
 *   npm run seed:demo -- --check      exit non-zero if it is not serving
 *
 * WHY THIS EXISTS. The landing page carries a live widget. Until now the
 * bot behind it was provisioned by hand from a checklist in
 * docs/demo-bot-knowledge.md, which meant it survived exactly as long as
 * the database did: `npm run db:reset` erased it, nothing replayed it,
 * and the page went on serving a `data-bot-id` that matched no row. The
 * widget does the right thing with that — a 404 from /health is
 * definitive, so it unmounts rather than greeting a visitor it cannot
 * answer — and the visible result is a landing page with no chat on it.
 *
 * So the demo bot is now described in config/demo-bot.js and created
 * from here. Reseeding is how you edit it.
 *
 * IDEMPOTENT, AND SPECIFICALLY: safe to run against a database that
 * already has it. Rows are matched on the fixed ids in config/demo-bot.js
 * and updated in place; sources are matched on title and FAQ items on
 * question text, so re-running converges rather than duplicating.
 *
 * WHAT IT WILL NOT DO. It only ever writes the org and bot named by
 * those fixed ids, and the corpus underneath that one bot. It never
 * walks outward from the owner to whatever else they are a member of —
 * the same rule scripts/lib/testenv.mjs enforces, and for the same
 * reason: this project has already lost a database to a cleanup that
 * reasoned from a user to "their" org.
 *
 * TWO TRANSPORTS, ON PURPOSE.
 *
 *   Rows       PostgREST as service_role. The demo bot is platform
 *              furniture with ids the product's own create-bot route
 *              cannot assign, so it is written directly.
 *
 *   Knowledge  The admin API as a signed-in user. Chunking, embedding
 *              and the FAQ document are the ingest pipeline's job, and
 *              a seed script that reimplemented them would be a second
 *              copy of the pipeline that drifts from the first. It also
 *              means this exercises the same path a tenant does.
 *
 * That second transport is why an owner account is required at all:
 * src/auth.ts explicitly refuses the service-role key as a bearer token
 * (`Token is not an end-user session`), so there is no admin call
 * without a real session.
 *
 * CREDENTIALS, in the two files that already own them:
 *
 *   apps/api/.dev.vars   SUPABASE_URL, SUPABASE_ANON_KEY,
 *                        SUPABASE_SERVICE_ROLE_KEY — which project, and
 *                        what may write to it.
 *
 *   .env.tools           CK_DEMO_OWNER_EMAIL, CK_DEMO_OWNER_PASSWORD —
 *                        who owns the demo org. Uploaded to nothing,
 *                        which is why they are here and not beside the
 *                        Worker's runtime secrets.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ORIGINS, SUPABASE } from '../config/origins.js';
import {
  DEMO_ORG_ID, DEMO_BOT_ID, DEMO_ORG_NAME, DEMO_BOT, DEMO_SOURCES, DEMO_FAQ,
} from '../config/demo-bot.js';

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
  // CRLF first, for the reason scripts/migrate.mjs spells out: `\r` is a
  // line terminator to a JS regex, so a trailing one puts the value past
  // what `.*$` matches and every line silently fails to parse.
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

// Two files name the project for this environment: the Worker's runtime
// secrets, and config/origins.js — which is what the dashboard bundle is
// built from. They must agree, and when they did not the failure was
// invisible from both sides: the dashboard signed users in against one
// project while the API trusted tokens from another, so sign-in appeared
// to succeed and every admin call 401'd.
//
// Checked here because this is the one script that reads both.
if (SUPABASE.url.replace(/\/+$/, '') !== SUPABASE_URL.replace(/\/+$/, '')) {
  fail(
    'Supabase project mismatch — the dashboard and the API would be pointed at\n' +
    'different databases:\n\n' +
    `  config/origins.js  ${SUPABASE.url}   (baked into the dashboard bundle)\n` +
    `  ${devVarsPath.padEnd(17)}  ${SUPABASE_URL}   (what the Worker uses)\n\n` +
    'Fix whichever is wrong before seeding. Signing in against one project and\n' +
    'calling an API backed by the other looks like it works and then 401s on\n' +
    'every admin request — src/auth.ts pins the token issuer.',
  );
}

const OWNER_EMAIL = tools.CK_DEMO_OWNER_EMAIL;
const OWNER_PASSWORD = tools.CK_DEMO_OWNER_PASSWORD;

if (!CHECK_ONLY && (!OWNER_EMAIL || !OWNER_PASSWORD)) {
  fail(
    'No demo-bot owner configured. Add to .env.tools:\n\n' +
    '  CK_DEMO_OWNER_EMAIL=you@example.com\n' +
    '  CK_DEMO_OWNER_PASSWORD=<a password you choose>\n\n' +
    'The account is created on first run if it does not exist, and is the login you\n' +
    'then use to edit the demo bot at\n' +
    `  ${ORIGINS.app}\n\n` +
    'The knowledge half of this seed goes through the admin API, which refuses the\n' +
    'service-role key as a bearer token (src/auth.ts) — so a real session is\n' +
    'required and there is no way to skip this.',
  );
}

const API_BASE = ORIGINS.api;
const SITE_ORIGIN = ORIGINS.site;

// ---------------------------------------------------------------
// Transport
// ---------------------------------------------------------------
const svcHeaders = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

/** PostgREST as service_role. `prefer` carries representation/upsert. */
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

/**
 * The owner account, created if absent, and a session token.
 *
 * Sign-in is attempted BEFORE the admin lookup so the ordinary case —
 * an account that already exists with the configured password — costs
 * one request and never touches the admin API. A failure there is not
 * treated as "no such user": it is equally "wrong password", and those
 * two need different messages.
 */
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

  // Distinguish "no account" from "wrong password". Guessing wrong here
  // and calling admin/users would 422 on a duplicate email, which reads
  // as a bug rather than as the configuration error it is.
  const found = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?filter=${encodeURIComponent(OWNER_EMAIL)}`,
    { headers: svcHeaders },
  ).then((r) => (r.ok ? r.json() : { users: [] }));

  const already = (found.users ?? []).some(
    (u) => (u.email ?? '').toLowerCase() === OWNER_EMAIL.toLowerCase(),
  );
  if (already) {
    fail(
      `An account for ${OWNER_EMAIL} exists but CK_DEMO_OWNER_PASSWORD does not sign in.\n` +
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
    // Confirmed on creation. There is no inbox to click through here,
    // and an unconfirmed user cannot sign in to finish the seed.
    body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD, email_confirm: true }),
  });
  if (!r.ok) fail(`Could not create ${OWNER_EMAIL}: ${r.status} ${(await r.text()).slice(0, 300)}`);
  did(`created owner account ${OWNER_EMAIL}`);

  // Signup fires handle_new_user, which provisions a personal org and an
  // empty bot for this user. That org is left entirely alone — the demo
  // bot gets its own, because supabase/002 allows one bot per org.
  const token = await signIn();
  if (!token) fail('Created the owner account but could not sign in as it.');
  return token;
}

// ---------------------------------------------------------------
// Rows
// ---------------------------------------------------------------
async function seedOrg(userId) {
  const [org] = await rest(`/organizations?id=eq.${DEMO_ORG_ID}&select=id,name`);
  if (!org) {
    if (DRY_RUN) { did(`create org "${DEMO_ORG_NAME}"`); }
    else {
      await rest('/organizations', {
        method: 'POST',
        prefer: 'return=minimal',
        // The slug shape mirrors handle_new_user's, so the demo org does
        // not stand out as having been made by a different mechanism.
        body: { id: DEMO_ORG_ID, name: DEMO_ORG_NAME, slug: `org-${DEMO_ORG_ID.replace(/-/g, '')}` },
      });
      did(`created org "${DEMO_ORG_NAME}"`);
    }
  } else if (org.name !== DEMO_ORG_NAME) {
    if (!DRY_RUN) await rest(`/organizations?id=eq.${DEMO_ORG_ID}`, { method: 'PATCH', prefer: 'return=minimal', body: { name: DEMO_ORG_NAME } });
    did(`renamed org to "${DEMO_ORG_NAME}"`);
  } else {
    same(`org "${DEMO_ORG_NAME}"`);
  }

  if (!userId) return;

  const members = await rest(
    `/memberships?org_id=eq.${DEMO_ORG_ID}&user_id=eq.${userId}&select=role`,
  );
  if (!members.length) {
    if (DRY_RUN) { did(`add ${OWNER_EMAIL} as owner`); }
    else {
      await rest('/memberships', {
        method: 'POST',
        prefer: 'return=minimal',
        body: { org_id: DEMO_ORG_ID, user_id: userId, role: 'owner' },
      });
      did(`added ${OWNER_EMAIL} as owner`);
    }
  } else {
    same(`${OWNER_EMAIL} is ${members[0].role}`);
  }
}

async function seedBot() {
  // The page's own origin, from the same switch that writes the page.
  // An origin that does not match exactly — scheme, host and port — is
  // refused with a 403 the widget cannot explain, which is the single
  // most common way a working bot looks broken.
  const allowed = [SITE_ORIGIN];

  const row = {
    ...DEMO_BOT,
    id: DEMO_BOT_ID,
    org_id: DEMO_ORG_ID,
    allowed_origins: allowed,
    // Deprecated and still written, because src/supabase.ts createBot
    // writes it on every insert and allowedOriginsFor still reads it as
    // a fallback. A demo bot that skipped it would be the one row on the
    // platform shaped differently from the rest.
    allowed_origin: allowed[0],
  };

  // Only the columns this script owns. Selecting `*` would drag in
  // chunk_count, knowledge_migrated_at and the provider blobs — all of
  // them written by the platform, none of them ours to compare — and
  // every run would report a difference it then did not make.
  const owned = Object.keys(row).join(',');
  const [existing] = await rest(`/bots?id=eq.${DEMO_BOT_ID}&select=${owned}`);

  if (existing && existing.org_id !== DEMO_ORG_ID) {
    fail(
      `Bot ${DEMO_BOT_ID} exists but belongs to org ${existing.org_id}, not the demo org.\n` +
      'Refusing to move it — that would be reaching into a tenant this script does not own.',
    );
  }

  // Key order is not meaningful in either jsonb or a JS object literal,
  // so it is normalised away before comparing. Without this the settings
  // blobs compare unequal on every run purely because Postgres returns
  // jsonb keys in its own order.
  const canon = (v) =>
    JSON.stringify(v, (_, x) =>
      x && typeof x === 'object' && !Array.isArray(x)
        ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]]))
        : x);

  const differs = !existing || Object.keys(row).some((k) => canon(existing[k]) !== canon(row[k]));

  if (!differs) {
    same('demo bot');
  } else if (DRY_RUN) {
    did(existing ? 'update demo bot' : 'create demo bot');
  } else if (existing) {
    await rest(`/bots?id=eq.${DEMO_BOT_ID}`, { method: 'PATCH', prefer: 'return=minimal', body: row });
    did('updated demo bot');
  } else {
    await rest('/bots', { method: 'POST', prefer: 'return=minimal', body: row });
    did('created demo bot');
  }

  console.log(`         id ${DEMO_BOT_ID}`);
  console.log(`         allows ${allowed.join(', ')}`);
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
 * what is already stored, which is not what a changed config file
 * means. Deleting first also keeps a renamed source from accumulating.
 */
async function seedSources(token) {
  const { documents } = await admin(`/v1/admin/bots/${DEMO_BOT_ID}/documents`, { token });

  for (const source of DEMO_SOURCES) {
    const prior = documents.filter((d) => d.title === source.title);

    // Unchanged content that indexed cleanly is left alone: re-embedding
    // it costs the same tokens as the first time and produces the same
    // chunks. `content` is deliberately not in the list route's field
    // set (DOC_FIELDS in src/supabase.ts) — it is bulk the dashboard
    // never renders — so the comparison reads the column directly rather
    // than assuming a field that is always undefined, which would make
    // every run re-ingest while reporting that it had checked.
    const clean = prior.length === 1 && prior[0].status === 'ready'
      ? await rest(`/documents?id=eq.${prior[0].id}&select=content`)
          .then(([row]) => row?.content?.trim() === source.content.trim())
      : false;
    if (clean) { same(`source "${source.title}" (${prior[0].chunk_count ?? '?'} chunks)`); continue; }

    if (DRY_RUN) { did(`reindex source "${source.title}"`); continue; }

    for (const d of prior) await admin(`/v1/admin/documents/${d.id}`, { method: 'DELETE', token });
    const doc = await admin(`/v1/admin/bots/${DEMO_BOT_ID}/documents`, {
      method: 'POST', token,
      body: { source: source.source, title: source.title, content: source.content },
    });
    did(`ingesting source "${source.title}" (${doc.id})`);
  }
}

/**
 * FAQ rows, matched on question text.
 *
 * Every write here re-triggers a full FAQ reindex server-side, so the
 * loop deliberately does nothing when an item already matches — a seed
 * that PUT all twelve unconditionally would kick off twelve overlapping
 * ingests, eleven of which lose their claim on documents.ingest_started_at
 * and log an AlreadyIndexing for no reason.
 */
async function seedFaq(token) {
  const { items } = await admin(`/v1/admin/bots/${DEMO_BOT_ID}/faq`, { token });
  const key = (q) => q.trim().toLowerCase();
  const byQuestion = new Map(items.map((i) => [key(i.question), i]));

  let position = 0;
  for (const entry of DEMO_FAQ) {
    const found = byQuestion.get(key(entry.question));
    byQuestion.delete(key(entry.question));

    if (!found) {
      if (DRY_RUN) { did(`add FAQ "${entry.question}"`); position++; continue; }
      await admin(`/v1/admin/bots/${DEMO_BOT_ID}/faq`, {
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

  // Anything left is an item this file no longer declares. config/demo-bot.js
  // is the source of truth for the demo bot, so deleting a question here
  // has to delete it there or the file stops describing reality.
  for (const orphan of byQuestion.values()) {
    if (DRY_RUN) { did(`remove FAQ "${orphan.question}"`); continue; }
    await admin(`/v1/admin/faq/${orphan.id}`, { method: 'DELETE', token });
    did(`removed FAQ "${orphan.question}" (no longer in config/demo-bot.js)`);
  }
}

/**
 * Ingest is fire-and-forget behind `waitUntil`, so the seed has to watch
 * the document rows rather than assume. Reporting "seeded" while every
 * chunk_count is still zero is how you end up with a landing page whose
 * bot loads, greets, and then cannot answer anything.
 */
async function waitForIndexing(token, timeoutMs = 120_000) {
  const started = Date.now();
  let last = '';

  while (Date.now() - started < timeoutMs) {
    const { documents } = await admin(`/v1/admin/bots/${DEMO_BOT_ID}/documents`, { token });
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
// The last three assertions are the ones that actually matter, because
// each is a way the bot can exist and still not work: /health has to
// answer (the widget unmounts on 404), the site origin has to be
// allowed (a 403 the visitor never sees), and there has to be a corpus
// (a bot that greets and then knows nothing).
// ---------------------------------------------------------------
async function verify() {
  const r = await fetch(`${API_BASE}/v1/bots/${DEMO_BOT_ID}/health`);
  if (!r.ok) {
    console.log(`  FAIL   GET /v1/bots/${DEMO_BOT_ID}/health → ${r.status}`);
    return false;
  }
  const health = await r.json();
  console.log(`  ok     /health → ${health.businessName}, ${health.primaryColor}, ${health.suggestions?.length ?? 0} suggestion(s)`);

  const [bot] = await rest(`/bots?id=eq.${DEMO_BOT_ID}&select=allowed_origins,chunk_count`);
  const allowsSite = (bot?.allowed_origins ?? []).includes(SITE_ORIGIN);
  console.log(`  ${allowsSite ? 'ok    ' : 'FAIL  '} allows ${SITE_ORIGIN}`);

  const corpus = bot?.chunk_count ?? 0;
  console.log(`  ${corpus > 0 ? 'ok    ' : 'FAIL  '} corpus: ${corpus} chunk(s)`);

  return allowsSite && corpus > 0;
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
  console.log(ok ? '\nDemo bot is serving.' : '\nDemo bot is NOT serving.');
  process.exit(ok ? 0 : 1);
}

const token = await ownerSession();

// A dry run past this point has no session and no rows to read from, so
// it stops here rather than reporting a fictional plan for the corpus.
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
    ? `\nDemo bot is serving. Rebuild and redeploy the page to pick up the id:\n` +
      `  npm run check:landing && npm run deploy:site\n`
    : '\nSeeded, but the bot is not serving — see the failures above.\n',
);
process.exit(ok && !failed ? 0 : 1);
