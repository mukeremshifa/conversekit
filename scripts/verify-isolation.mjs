#!/usr/bin/env node
/**
 * Cross-tenant isolation check.
 *
 * The single biggest risk in this project is a query that forgets its
 * tenant filter and serves org A's data to org B. This proves it does
 * not happen, through BOTH ways it could go wrong:
 *
 *   1. the Worker's /v1/admin routes
 *   2. PostgREST directly, with the user's own JWT
 *
 * Every negative assertion is made against SEEDED data — asserting
 * "A sees none of B's leads" when B has no leads proves nothing.
 *
 * Usage:
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_ANON_KEY=eyJ... \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   WORKER_URL=http://localhost:8787 \
 *   node scripts/verify-isolation.mjs
 */

import { makePdf, makeTextlessPdf } from './lib/makepdf.mjs';

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  WORKER_URL = 'http://localhost:8787',
} = process.env;

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY })) {
  if (!v) { console.error(`Missing required env var: ${k}`); process.exit(2); }
}

const BASE = SUPABASE_URL.replace(/\/+$/, '');
const RUN  = Date.now();

let failures = 0;
const pass = (label) => console.log(`  ok   ${label}`);
const fail = (label, detail) => { failures++; console.log(`  FAIL ${label}\n       ${detail}`); };

function check(label, cond, detail = '') {
  cond ? pass(label) : fail(label, detail);
}

// ---------------------------------------------------------------
// Thin REST helpers
// ---------------------------------------------------------------
const svcHeaders = {
  apikey: SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
  'Content-Type': 'application/json',
};

async function rest(path, { token, method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${BASE}/rest/v1${path}`, {
    method,
    headers: {
      apikey: token ? SUPABASE_ANON_KEY : SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${token ?? SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { status: res.status, json, text };
}

/**
 * Multipart upload. Separate from worker() because that one pins
 * Content-Type to application/json, and a multipart body needs fetch to
 * generate the boundary itself.
 */
async function uploadFile(path, { token, bytes, filename, type, title }) {
  const form = new FormData();
  form.append('file', new Blob([bytes], { type }), filename);
  if (title) form.append('title', title);

  const res = await fetch(`${WORKER_URL}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
  return { status: res.status, json, text };
}

async function worker(path, { token, method = 'GET', body } = {}) {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* ignore */ }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------
async function createUser(tag) {
  const email    = `isolation+${tag}-${RUN}@conversekit.test`;
  const password = `pw-${RUN}-${tag}-Aa1!`;

  // Create pre-confirmed via the admin API so the test does not depend
  // on whether email confirmation is switched on for the project.
  const created = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: 'POST',
    headers: svcHeaders,
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  if (!created.ok) throw new Error(`admin createUser failed: ${created.status} ${await created.text()}`);
  const { id: userId } = await created.json();

  const signin = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!signin.ok) throw new Error(`sign-in failed: ${signin.status} ${await signin.text()}`);
  const { access_token } = await signin.json();

  return { tag, email, userId, token: access_token };
}

/**
 * Deleting the user cascades its membership, but organizations have no
 * FK to auth.users — so the org, its bots, and their conversations and
 * leads would survive as orphans. Drop the org explicitly; everything
 * below it cascades from there.
 */
async function cleanup({ userId, orgId } = {}) {
  const problems = [];
  // A run that fails before /v1/admin/me never learns its org id. Look it
  // up with the service role so an early abort cannot orphan rows.
  if (!orgId && userId) {
    const r = await rest(`/memberships?select=org_id&user_id=eq.${userId}`, {});
    orgId = r.json?.[0]?.org_id ?? null;
  }
  if (orgId) {
    const r = await fetch(`${BASE}/rest/v1/organizations?id=eq.${orgId}`, { method: 'DELETE', headers: svcHeaders });
    if (!r.ok) problems.push(`org ${orgId} (${r.status})`);
  }
  if (userId) {
    const r = await fetch(`${BASE}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: svcHeaders });
    if (!r.ok) problems.push(`user ${userId} (${r.status})`);
  }
  // Surface rather than swallow: silent teardown failures accumulate
  // orphaned rows in a real database, one run at a time.
  if (problems.length) console.log(`  CLEANUP FAILED — remove manually: ${problems.join(', ')}`);
}

// ---------------------------------------------------------------
async function main() {
  console.log(`\nCross-tenant isolation — Worker at ${WORKER_URL}\n`);

  let a, b;
  try {
    a = await createUser('a');
    b = await createUser('b');
  } catch (err) {
    console.error(`\nSetup failed: ${err.message}`);
    process.exit(2);
  }

  try {
    // ── The signup trigger must have produced exactly one org each ──
    console.log('Signup provisioning');
    const meA = await worker('/v1/admin/me', { token: a.token });
    const meB = await worker('/v1/admin/me', { token: b.token });
    check('user A has exactly one org', meA.json?.orgs?.length === 1, JSON.stringify(meA.json));
    check('user B has exactly one org', meB.json?.orgs?.length === 1, JSON.stringify(meB.json));
    check('user A is owner of it', meA.json?.orgs?.[0]?.role === 'owner', JSON.stringify(meA.json?.orgs));

    const orgA = meA.json?.orgs?.[0]?.id;
    const orgB = meB.json?.orgs?.[0]?.id;
    // Stash for teardown — orgs do not cascade from user deletion.
    a.orgId = orgA;
    b.orgId = orgB;
    check('orgs are distinct', !!orgA && !!orgB && orgA !== orgB, `${orgA} vs ${orgB}`);
    if (!orgA || !orgB) throw new Error('cannot continue without both orgs');

    // ── Each creates a bot ────────────────────────────────────────
    console.log('\nBot creation');
    const mk = (who, org) => worker('/v1/admin/bots', {
      token: who.token,
      method: 'POST',
      body: {
        org_id: org,
        name: `Bot ${who.tag}`,
        business_name: `Biz ${who.tag}`,
        // A list since 006: apex + www is the common shape.
        allowed_origins: [`https://${who.tag}-${RUN}.example.com`, `https://www.${who.tag}-${RUN}.example.com`],
      },
    });

    const botA = (await mk(a, orgA)).json;
    const botB = (await mk(b, orgB)).json;
    check('A created a bot', !!botA?.id, JSON.stringify(botA));
    check('B created a bot', !!botB?.id, JSON.stringify(botB));
    if (!botA?.id || !botB?.id) throw new Error('cannot continue without both bots');

    // A must not be able to plant a bot inside B's org.
    const crossInsert = await mk(a, orgB);
    check('A cannot create a bot in B\'s org', crossInsert.status === 403,
          `status ${crossInsert.status} ${crossInsert.text}`);

    // ── Seed data so the negative assertions are not vacuous ──────
    console.log('\nSeeding B\'s data (service role)');
    const seedLead = await rest('/leads', {
      method: 'POST', prefer: 'return=representation',
      body: { bot_id: botB.id, session_id: `iso-${RUN}`, name: 'Secret Lead',
              email: 'secret@example.com', inquiry: 'confidential' },
    });
    const seedConv = await rest('/conversations', {
      method: 'POST', prefer: 'return=representation',
      body: { bot_id: botB.id, session_id: `iso-${RUN}`, role: 'user', content: 'confidential message' },
    });
    check('seeded a lead for B', seedLead.status < 300, `${seedLead.status} ${seedLead.text}`);
    check('seeded a conversation for B', seedConv.status < 300, `${seedConv.status} ${seedConv.text}`);

    // Positive control: B can see B's own data. Without this, a total
    // outage would look identical to perfect isolation.
    console.log('\nPositive control — B sees B');
    const bLeads = await worker(`/v1/admin/bots/${botB.id}/leads`, { token: b.token });
    const bConvs = await worker(`/v1/admin/bots/${botB.id}/conversations`, { token: b.token });
    check('B sees its own bot',          (await worker(`/v1/admin/bots/${botB.id}`, { token: b.token })).status === 200);
    check('B sees its own lead',         bLeads.json?.leads?.length === 1, JSON.stringify(bLeads.json));
    check('B sees its own conversation', bConvs.json?.conversations?.length === 1, JSON.stringify(bConvs.json));

    // ── The actual isolation assertions, via the Worker ───────────
    console.log('\nIsolation via Worker admin routes');
    const aGetsB     = await worker(`/v1/admin/bots/${botB.id}`, { token: a.token });
    const aLeadsB    = await worker(`/v1/admin/bots/${botB.id}/leads`, { token: a.token });
    const aConvsB    = await worker(`/v1/admin/bots/${botB.id}/conversations`, { token: a.token });
    const aListsAll  = await worker('/v1/admin/bots', { token: a.token });
    const aUpdatesB  = await worker(`/v1/admin/bots/${botB.id}`, { token: a.token, method: 'PUT', body: { name: 'pwned' } });
    const aDeletesB  = await worker(`/v1/admin/bots/${botB.id}`, { token: a.token, method: 'DELETE' });

    check('A gets 404 for B\'s bot',            aGetsB.status === 404, `status ${aGetsB.status}`);
    check('A sees no leads of B',               (aLeadsB.json?.leads ?? []).length === 0, JSON.stringify(aLeadsB.json));
    check('A sees no conversations of B',       (aConvsB.json?.conversations ?? []).length === 0, JSON.stringify(aConvsB.json));
    check('A\'s bot list excludes B',           !(aListsAll.json?.bots ?? []).some((x) => x.id === botB.id));
    check('A\'s bot list contains only its own', (aListsAll.json?.bots ?? []).every((x) => x.org_id === orgA));
    check('A cannot update B\'s bot',           aUpdatesB.status === 404, `status ${aUpdatesB.status}`);
    check('A cannot delete B\'s bot',           aDeletesB.status === 404, `status ${aDeletesB.status}`);

    // Confirm the delete attempt really was a no-op.
    const stillThere = await worker(`/v1/admin/bots/${botB.id}`, { token: b.token });
    check('B\'s bot survived A\'s delete attempt', stillThere.status === 200, `status ${stillThere.status}`);
    check('B\'s bot name unchanged',              stillThere.json?.name === `Bot b`, stillThere.json?.name);

    // ── Same assertions straight at PostgREST ────────────────────
    // The Worker could be filtering correctly while the policies are
    // wide open; this is what proves the database itself refuses.
    console.log('\nIsolation via PostgREST (RLS directly)');
    const rawBots  = await rest(`/bots?select=*&id=eq.${botB.id}`, { token: a.token });
    const rawLeads = await rest(`/leads?select=*&bot_id=eq.${botB.id}`, { token: a.token });
    const rawConvs = await rest(`/conversations?select=*&bot_id=eq.${botB.id}`, { token: a.token });
    const rawAll   = await rest('/bots?select=id,org_id', { token: a.token });
    const rawOrgs  = await rest('/organizations?select=id', { token: a.token });
    const rawMems  = await rest('/memberships?select=org_id,user_id', { token: a.token });

    check('RLS hides B\'s bot from A',           Array.isArray(rawBots.json)  && rawBots.json.length === 0,  rawBots.text);
    check('RLS hides B\'s leads from A',         Array.isArray(rawLeads.json) && rawLeads.json.length === 0, rawLeads.text);
    check('RLS hides B\'s conversations from A', Array.isArray(rawConvs.json) && rawConvs.json.length === 0, rawConvs.text);
    check('RLS scopes bot list to A\'s org',     Array.isArray(rawAll.json)   && rawAll.json.every((x) => x.org_id === orgA), rawAll.text);
    check('RLS scopes organizations to A',       Array.isArray(rawOrgs.json)  && rawOrgs.json.length === 1,  rawOrgs.text);
    check('RLS scopes memberships to A',         Array.isArray(rawMems.json)  && rawMems.json.every((m) => m.user_id === a.userId), rawMems.text);

    // A must not be able to write into B's tables either.
    const rawWrite = await rest('/leads', {
      token: a.token, method: 'POST',
      body: { bot_id: botB.id, session_id: 'x', name: 'x', email: 'x@y.z' },
    });
    check('RLS blocks A writing a lead for B', rawWrite.status >= 400, `status ${rawWrite.status} ${rawWrite.text}`);

    // ── The anon key must be inert after 003 ─────────────────────
    console.log('\nAnon key lockdown');
    const anonBots = await fetch(`${BASE}/rest/v1/bots?select=id`, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    const anonBody = await anonBots.text();
    let anonRows = null;
    try { anonRows = JSON.parse(anonBody); } catch { /* error body */ }
    check('anon key cannot read bots',
          anonBots.status >= 400 || (Array.isArray(anonRows) && anonRows.length === 0),
          `status ${anonBots.status} ${anonBody.slice(0, 160)}`);

    // ── Auth guards ──────────────────────────────────────────────
    console.log('\nAuth guards');
    check('no token → 401',           (await worker('/v1/admin/bots')).status === 401);
    check('garbage token → 401',      (await worker('/v1/admin/bots', { token: 'not-a-jwt' })).status === 401);
    // Both API keys are themselves JWTs. If either were accepted as a
    // bearer token the whole tenancy model would be bypassable, so these
    // two are the highest-value regressions in the file.
    check('anon key as bearer → 401', (await worker('/v1/admin/bots', { token: SUPABASE_ANON_KEY })).status === 401);
    check('service_role key as bearer → 401',
          (await worker('/v1/admin/bots', { token: SUPABASE_SERVICE_ROLE_KEY })).status === 401);
    check('providers route requires auth', (await worker('/v1/admin/providers')).status === 401);

    // ── BYOK keys must never round-trip to a browser ─────────────
    console.log('\nBYOK redaction');
    const withKey = await worker(`/v1/admin/bots/${botA.id}`, {
      token: a.token, method: 'PUT',
      body: { provider_config: { vendor: 'groq', apiKey: 'gsk_supersecret_tail1234' } },
    });
    const shown = withKey.json?.provider_config;
    check('apiKey is absent from the response',  shown && !('apiKey' in shown), JSON.stringify(shown));
    check('presence is reported without the key', shown?.hasApiKey === true && shown?.apiKeyLast4 === '1234', JSON.stringify(shown));
    check('raw key never appears in the payload',
          !JSON.stringify(withKey.json).includes('supersecret'),
          'plaintext BYOK key leaked to the client');

    // The realistic round-trip: the dashboard sends back exactly what it
    // was given — no apiKey, because the server never supplied one.
    await worker(`/v1/admin/bots/${botA.id}`, {
      token: a.token, method: 'PUT',
      body: { provider_config: { vendor: 'groq', model: 'llama-3.3-70b-versatile', hasApiKey: true, apiKeyLast4: '1234' } },
    });
    const stored = (await rest(`/bots?select=provider_config&id=eq.${botA.id}`, {})).json?.[0]?.provider_config;
    check('stored key survives the round-trip', stored?.apiKey === 'gsk_supersecret_tail1234', JSON.stringify(stored));
    check('the rest of the config still updated', stored?.model === 'llama-3.3-70b-versatile', JSON.stringify(stored));
    check('display-only fields are not persisted',
          stored && !('hasApiKey' in stored) && !('apiKeyLast4' in stored), JSON.stringify(stored));

    // ── RAG (Phase 2) ────────────────────────────────────────────
    // Skipped rather than failed when 005 has not been applied, so this
    // suite stays runnable between migrations.
    const ragProbe = await rest('/documents?select=id&limit=1', {});
    if (ragProbe.status === 404 || /does not exist|schema cache/i.test(ragProbe.text)) {
      console.log('\nRAG isolation\n  SKIPPED — 005_rag.sql has not been applied yet.');
    } else {
      console.log('\nRAG isolation');
      const addDoc = (who, botId, title, content) => worker(`/v1/admin/bots/${botId}/documents`, {
        token: who.token, method: 'POST',
        body: { source: 'text', title, content },
      });

      const docA = await addDoc(a, botA.id, 'A pricing', 'Whitening at clinic A costs 199 pounds.');
      const docB = await addDoc(b, botB.id, 'B pricing', 'Whitening at clinic B costs 777 pounds.');
      check('A can add a source to its own bot', docA.status === 202, `status ${docA.status} ${docA.text}`);
      check('B can add a source to its own bot', docB.status === 202, `status ${docB.status} ${docB.text}`);

      const crossDoc = await addDoc(a, botB.id, 'planted', 'malicious');
      check('A cannot add a source to B\'s bot', crossDoc.status === 404, `status ${crossDoc.status}`);

      // Ingestion is async; give it a moment before asserting on chunks.
      await new Promise((r) => setTimeout(r, 6000));

      const aDocs = await worker(`/v1/admin/bots/${botA.id}/documents`, { token: a.token });
      const bDocsViaA = await worker(`/v1/admin/bots/${botB.id}/documents`, { token: a.token });
      check('A sees its own document', (aDocs.json?.documents ?? []).some((d) => d.title === 'A pricing'));
      check('A sees none of B\'s documents', (bDocsViaA.json?.documents ?? []).length === 0, JSON.stringify(bDocsViaA.json));

      const rawDocs   = await rest('/documents?select=id,title,org_id', { token: a.token });
      const rawChunks = await rest('/chunks?select=id,org_id', { token: a.token });
      check('RLS scopes documents to A\'s org',
            Array.isArray(rawDocs.json) && rawDocs.json.every((d) => d.org_id === orgA), rawDocs.text);
      check('RLS scopes chunks to A\'s org',
            Array.isArray(rawChunks.json) && rawChunks.json.every((c) => c.org_id === orgA), rawChunks.text);
      check('A never sees B\'s document title',
            !JSON.stringify(rawDocs.json).includes('B pricing'), rawDocs.text);

      // A tenant must not be able to write chunks directly — they are
      // derived data and forging one poisons retrieval.
      const forge = await rest('/chunks', {
        token: a.token, method: 'POST',
        body: { document_id: docA.json?.id, bot_id: botA.id, ordinal: 99, content: 'forged' },
      });
      check('tenants cannot insert chunks directly', forge.status >= 400, `status ${forge.status}`);

      const ingested = (aDocs.json?.documents ?? []).find((d) => d.title === 'A pricing');
      check('ingestion produced chunks',
            ingested && ingested.status === 'ready' && ingested.chunk_count > 0,
            JSON.stringify(ingested));
      check('ingestion recorded the embedding model',
            !!ingested?.embedding_model && ingested?.embedding_dimensions === 768,
            JSON.stringify(ingested));

      // ── File sources (Phase 2B) ────────────────────────────────
      // Skipped rather than failed when 008 has not run or R2 is not
      // bound, so this suite stays runnable through the rollout.
      // Schema first, so a run before the migration does not upload
      // anything it will only have to roll back.
      const filesProbe = await rest('/documents?select=r2_key&limit=1', {});
      // Realistic content, not a one-word probe: a PDF holding a single
      // short word is indistinguishable from a failed extraction, and an
      // earlier version of this fixture failed for exactly that reason.
      const handbook = makePdf([
        'Elm Street Dental opens at 9am on weekdays and closes at 5pm.',
        'Whitening costs 199 pounds and takes about an hour.',
        'Cleaning costs 80 pounds. Implants start at 1200 pounds.',
      ]);

      const capability = /r2_key/.test(filesProbe.text) && filesProbe.status >= 400
        ? null
        : await uploadFile(`/v1/admin/bots/${botA.id}/documents/upload`, {
            token: a.token, bytes: handbook, filename: 'handbook.pdf', type: 'application/pdf',
          });

      if (!capability) {
        console.log('\nFile sources\n  SKIPPED — 008_files.sql has not been applied yet.');
      } else if (capability.status === 501) {
        console.log(`\nFile sources\n  SKIPPED — ${capability.json?.error ?? 'the DOCS bucket is not bound.'}`);
      } else {
        console.log('\nFile sources');
        check('A can upload a PDF to its own bot', capability.status === 202,
              `status ${capability.status} ${capability.text}`);
        check('the upload is recorded as a file source with a stored object',
              capability.json?.source === 'file' && !!capability.json?.r2_key &&
              capability.json?.mime_type === 'application/pdf' && capability.json?.size_bytes > 0,
              JSON.stringify(capability.json));

        const crossUpload = await uploadFile(`/v1/admin/bots/${botB.id}/documents/upload`, {
          token: a.token, bytes: makePdf(['planted']), filename: 'planted.pdf', type: 'application/pdf',
        });
        check('A cannot upload into B\'s bot', crossUpload.status === 404, `status ${crossUpload.status}`);

        // toMarkdown validates nothing — it returned a .zip and a .txt
        // verbatim during the spike. These two assertions are the whole
        // reason the upload route sniffs magic bytes.
        const asText = await uploadFile(`/v1/admin/bots/${botA.id}/documents/upload`, {
          token: a.token, bytes: new TextEncoder().encode('just some text'),
          filename: 'notes.txt', type: 'text/plain',
        });
        check('an unsupported extension is refused', asText.status === 415, `status ${asText.status} ${asText.text}`);

        const renamedZip = await uploadFile(`/v1/admin/bots/${botA.id}/documents/upload`, {
          token: a.token, bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]),
          filename: 'payload.pdf', type: 'application/pdf',
        });
        check('a file whose bytes contradict its name is refused',
              renamedZip.status === 415, `status ${renamedZip.status} ${renamedZip.text}`);

        // A PDF that is structurally valid but carries no text must fail
        // loudly. Left alone it would index the PDF's own metadata.
        const textless = await uploadFile(`/v1/admin/bots/${botA.id}/documents/upload`, {
          token: a.token, bytes: makeTextlessPdf(), filename: 'scanned.pdf', type: 'application/pdf',
        });
        check('a PDF with no text is accepted for processing', textless.status === 202, `status ${textless.status}`);

        // Conversion is ~1s and embedding a handful of chunks a few more.
        await new Promise((r) => setTimeout(r, 12000));

        const afterDocs = (await worker(`/v1/admin/bots/${botA.id}/documents`, { token: a.token })).json?.documents ?? [];
        const uploaded = afterDocs.find((d) => d.id === capability.json?.id);
        check('the uploaded PDF finished indexing',
              uploaded?.status === 'ready' && uploaded?.chunk_count > 0, JSON.stringify(uploaded));

        const uploadedChunks = (await worker(`/v1/admin/documents/${capability.json?.id}/chunks`, { token: a.token })).json?.chunks ?? [];
        check('the PDF\'s words reached the corpus',
              uploadedChunks.some((ch) => ch.content.includes('Elm Street Dental')),
              JSON.stringify(uploadedChunks).slice(0, 300));
        check('the PDF\'s metadata did not',
              !JSON.stringify(uploadedChunks).includes('ConverseKit tests'),
              JSON.stringify(uploadedChunks).slice(0, 300));

        const scanned = afterDocs.find((d) => d.id === textless.json?.id);
        check('a textless PDF fails with an explanation rather than indexing metadata',
              scanned?.status === 'failed' && /No readable text/.test(scanned?.error ?? ''),
              JSON.stringify(scanned));

        const rawFileDocs = await rest('/documents?select=r2_key&r2_key=not.is.null', { token: b.token });
        check('B cannot see A\'s stored object keys',
              Array.isArray(rawFileDocs.json) && rawFileDocs.json.length === 0, rawFileDocs.text);

        const removed = await worker(`/v1/admin/documents/${capability.json?.id}`, { token: a.token, method: 'DELETE' });
        check('A can delete its own uploaded source', removed.status === 204, `status ${removed.status}`);
      }
    }

    // ── The public path must still work for anonymous visitors ───
    console.log('\nPublic chat path (service_role)');
    const health = await worker(`/v1/bots/${botA.id}/health`);
    check('health endpoint reachable', health.status === 200, `status ${health.status} ${health.text}`);
    check('health does not leak provider config',
          health.json && !('provider_config' in health.json) && !('faq' in health.json),
          JSON.stringify(health.json));
  } catch (err) {
    fail('unexpected error', err.stack || err.message);
  } finally {
    console.log('\nTeardown');
    if (a?.extraOrgId) await cleanup({ orgId: a.extraOrgId }).catch(() => {});
    await cleanup({ userId: a?.userId, orgId: a?.orgId }).catch((e) => console.log(`  cleanup error: ${e.message}`));
    await cleanup({ userId: b?.userId, orgId: b?.orgId }).catch((e) => console.log(`  cleanup error: ${e.message}`));
  }

  console.log(failures === 0
    ? '\nIsolation verified — no cross-tenant access.\n'
    : `\n${failures} isolation failure(s).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
