#!/usr/bin/env node
/**
 * Unit tests for signed session ids.
 *
 * The security property here must not depend on an LLM having quota,
 * so it is tested against the crypto directly rather than by asking a
 * model what it remembers. scripts/test-session.mjs remains as a thin
 * end-to-end smoke check.
 *
 *   npm run test:session-units
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = mkdtempSync(join(tmpdir(), 'ck-sess-'));
await build({
  entryPoints: [join(ROOT, 'src/session.ts')],
  outdir: OUT, format: 'esm', bundle: true, platform: 'neutral',
});
const { issueSessionId, verifySessionId } = await import(`file://${OUT}/session.js`);

let bad = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { bad++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};

const env = { SESSION_SECRET: 'test-secret-value', SUPABASE_SERVICE_ROLE_KEY: 'unused' };
const BOT_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const BOT_B = 'bbbbbbbb-0000-0000-0000-000000000002';

console.log('\nIssuance');
const t = await issueSessionId(env, BOT_A);
check('has the versioned prefix', t.startsWith('ck1.'), t);
check('has four parts', t.split('.').length === 4, t);
check('random part is >= 128 bits of base64url', t.split('.')[1].length >= 22, t);
check('is url-safe', /^[A-Za-z0-9._-]+$/.test(t), t);
const t2 = await issueSessionId(env, BOT_A);
check('two issues never collide', t !== t2);

console.log('\nVerification');
check('a freshly issued token verifies', await verifySessionId(env, BOT_A, t));
check('verifies repeatedly (no single-use)', await verifySessionId(env, BOT_A, t));

console.log('\nForgery');
check('rejects a token minted for another bot', !(await verifySessionId(env, BOT_B, t)));
check('rejects a tampered MAC', !(await verifySessionId(env, BOT_A, `${t.slice(0, -4)}AAAA`)));
check('rejects a tampered random part',
      !(await verifySessionId(env, BOT_A, t.replace(/\.([^.]+)\./, '.AAAAAAAAAAAAAAAAAAAAAA.'))));
check('rejects a swapped prefix', !(await verifySessionId(env, BOT_A, t.replace('ck1.', 'ck2.'))));
check('rejects the old client-generated format', !(await verifySessionId(env, BOT_A, 'ck-abc123xyz-1699999999')));
check('rejects an empty string', !(await verifySessionId(env, BOT_A, '')));
check('rejects a bare uuid', !(await verifySessionId(env, BOT_A, crypto.randomUUID())));
check('rejects too few parts', !(await verifySessionId(env, BOT_A, 'ck1.abc.def')));
check('rejects too many parts', !(await verifySessionId(env, BOT_A, `${t}.extra`)));

console.log('\nKey separation');
const other = { SESSION_SECRET: 'a-different-secret' };
check('a token does not verify under a different secret', !(await verifySessionId(other, BOT_A, t)));
// Falling back to the service-role key must still produce a *derived*
// key, never sign with the raw secret.
const derived = { SUPABASE_SERVICE_ROLE_KEY: 'sb_secret_example' };
const dt = await issueSessionId(derived, BOT_A);
check('works with no SESSION_SECRET set', await verifySessionId(derived, BOT_A, dt));
check('derived-key tokens do not verify under an explicit secret', !(await verifySessionId(env, BOT_A, dt)));

console.log('\nExpiry');
const parts = t.split('.');
const stale = Math.floor(Date.now() / 1000 - 8 * 24 * 3600).toString(36);
check('rejects an expired timestamp', !(await verifySessionId(env, BOT_A, `ck1.${parts[1]}.${stale}.${parts[3]}`)));
const future = Math.floor(Date.now() / 1000 + 3600).toString(36);
check('rejects a forward-dated token', !(await verifySessionId(env, BOT_A, `ck1.${parts[1]}.${future}.${parts[3]}`)));
check('rejects a non-numeric timestamp', !(await verifySessionId(env, BOT_A, `ck1.${parts[1]}.zzz!!.${parts[3]}`)));

console.log('\nRobustness');
for (const junk of ['....', 'ck1...', 'ck1.a.b.', '..'.repeat(50), 'ck1.' + 'A'.repeat(5000)]) {
  const r = await verifySessionId(env, BOT_A, junk).catch(() => 'threw');
  check(`does not throw on malformed input (${junk.slice(0, 12)}…)`, r === false, `got ${r}`);
}

rmSync(OUT, { recursive: true, force: true });
console.log(bad === 0 ? '\nAll session unit tests passed.\n' : `\n${bad} failure(s).\n`);
process.exit(bad === 0 ? 0 : 1);
