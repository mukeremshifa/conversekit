#!/usr/bin/env node
/**
 * Proves 007_erasure.sql actually works, end to end, against the real
 * database — the objects exist, the clamp holds, and an erasure removes
 * a transcript and its lead together.
 *
 *   node scripts/verify-erasure.mjs
 *
 * WHY THIS EXISTS AS A SCRIPT rather than a psql session someone ran
 * once: "the migration applied ok" only says the DDL parsed. It does
 * not say erase_session finds a lead through the same session id the
 * chat path wrote, which is the one assumption the whole erasure story
 * rests on. That is worth being able to re-check after any change to
 * either table.
 *
 * It seeds its own bot, org and rows, and deletes all of them before it
 * returns — including on failure. It touches nothing it did not create.
 *
 * SAFE TO RUN AGAINST A LIVE DATABASE, and that is a property to keep.
 * The clamp assertions read prune_conversations' source rather than
 * calling it: invoking it to prove it will not truncate the table still
 * deletes every row past the floor it clamps to, which makes the check
 * itself the thing you have to be careful about running.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = {
  ...loadEnvFile(join(ROOT, 'apps', 'api', '.dev.vars')),
  ...loadEnvFile(join(ROOT, '.env.tools')),
  ...process.env,
};

const projectRef = /^https?:\/\/([a-z0-9-]+)\.supabase\./i.exec(env.SUPABASE_URL ?? '')?.[1];
if (!projectRef || !env.SUPABASE_ACCESS_TOKEN) {
  console.error('Need SUPABASE_URL (apps/api/.dev.vars) and SUPABASE_ACCESS_TOKEN (.env.tools)');
  process.exit(1);
}

async function q(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Management API ${res.status}: ${body.slice(0, 400)}`);
  return body ? JSON.parse(body) : [];
}

const SESSION = `verify-erasure-${Date.now()}`;
let pass = 0, fail = 0;
const ok  = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else      { fail++; console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
};

console.log(`\nTarget: project ${projectRef}\nSession: ${SESSION}\n`);

// Tracked separately from botId: a failure BETWEEN creating the org and
// creating the bot would otherwise leave the org behind, with nothing
// holding its id to clean up by.
let orgId = null;
let botId = null;
try {
  // ---- the objects exist -----------------------------------------
  const fns = await q(`select proname, prosecdef from pg_proc
                        where proname in ('prune_conversations','erase_session')`);
  ok('prune_conversations exists', fns.some((r) => r.proname === 'prune_conversations'));
  ok('erase_session exists',       fns.some((r) => r.proname === 'erase_session'));
  ok('both are security definer',  fns.length === 2 && fns.every((r) => r.prosecdef === true));

  const pol = await q(`select policyname, tablename from pg_policies
                        where tablename in ('conversations','leads') and cmd = 'DELETE'`);
  ok('conv_delete policy exists',  pol.some((r) => r.policyname === 'conv_delete'));
  ok('leads_delete policy exists', pol.some((r) => r.policyname === 'leads_delete'));

  // ---- the clamp holds --------------------------------------------
  // READ the clamp rather than exercising it. Calling
  // prune_conversations(0) to prove it does not truncate the table
  // still deletes everything past the floor it clamps to — a "safety"
  // check that destroys real transcripts every time it runs is not one
  // anybody should be able to run casually.
  //
  // The floor is what stops a zero or a null taking the table, so
  // assert on the source of the bound itself.
  const [{ src }] = await q(`select prosrc as src from pg_proc where proname = 'prune_conversations'`);
  ok('prune_conversations clamps into [7, 365]',
     /least\(\s*365\s*,\s*greatest\(\s*7\s*,/.test(src));
  ok('prune_conversations coalesces a null argument first',
     /coalesce\(\s*p_days\s*,\s*180\s*\)/.test(src));

  // ---- a blank session id raises rather than reporting zero --------
  let raised = false;
  try { await q(`select erase_session('00000000-0000-0000-0000-000000000000'::uuid, '  ')`); }
  catch { raised = true; }
  ok('erase_session refuses a blank session id', raised);

  // ---- erasure removes transcript AND lead together ---------------
  orgId = (await q(`insert into organizations (name, slug)
                     values ('verify-erasure', 'verify-erasure-${Date.now()}')
                     returning id`))[0].id;
  botId = (await q(`insert into bots (org_id, name, business_name,
                                      allowed_origin, allowed_origins)
                    values ('${orgId}', 'verify-erasure', 'Verify Erasure',
                            'https://example.com', array['https://example.com'])
                    returning id`))[0].id;

  await q(`insert into conversations (bot_id, session_id, role, content) values
             ('${botId}', '${SESSION}', 'user', 'hello'),
             ('${botId}', '${SESSION}', 'assistant', 'hi'),
             ('${botId}', 'other-session', 'user', 'untouched')`);
  await q(`insert into leads (bot_id, session_id, name, email)
           values ('${botId}', '${SESSION}', 'Test Person', 'test@example.com')`);

  const erased = (await q(`select erase_session('${botId}', '${SESSION}') as r`))[0].r;
  ok('erase_session removed 2 messages', erased.messages === 2, JSON.stringify(erased));
  ok('erase_session removed 1 lead',     erased.leads === 1,    JSON.stringify(erased));

  const leftMsg  = (await q(`select count(*)::int as n from conversations
                              where bot_id='${botId}' and session_id='${SESSION}'`))[0].n;
  const leftLead = (await q(`select count(*)::int as n from leads
                              where bot_id='${botId}' and session_id='${SESSION}'`))[0].n;
  const other    = (await q(`select count(*)::int as n from conversations
                              where bot_id='${botId}' and session_id='other-session'`))[0].n;
  ok('transcript gone',            leftMsg === 0);
  ok('lead gone',                  leftLead === 0);
  ok('other session left intact',  other === 1);
} finally {
  // Delete the ORG, not the bot: bots cascade from it and conversations
  // and leads cascade from them, so one delete removes everything this
  // seeded. Keyed off orgId rather than botId so a failure between the
  // two inserts still cleans up.
  if (orgId) {
    await q(`delete from organizations where id = '${orgId}'`).catch(() => {});
  }
}

console.log(`\n${pass} passed, ${fail} failed.\n`);
process.exit(fail ? 1 : 0);
