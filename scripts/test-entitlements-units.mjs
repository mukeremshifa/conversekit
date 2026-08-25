#!/usr/bin/env node
/**
 * Unit tests for the entitlements seam.
 *
 * The point of this module is not what it currently returns — every
 * plan is permissive today — it is that the mapping lives in exactly
 * one place and that unknown input fails toward least privilege. Both
 * of those are the kind of property that erodes silently: a plan string
 * with different casing, a typo in a database row, a fourth tier added
 * to the table but not to the limiter bindings.
 *
 * The rate-limiter selection is the part with teeth. A limit is static
 * configuration, so the tiers exist as separate bindings in
 * apps/api/wrangler.jsonc; if this mapping ever points two plans at one
 * namespace, one tier silently spends another's allowance.
 *
 *   npm run test:entitlements
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = mkdtempSync(join(tmpdir(), 'ck-ent-'));

await build({
  entryPoints: [join(ROOT, 'apps/api/src/entitlements.ts')],
  outdir: OUT, format: 'esm', bundle: true, platform: 'neutral',
});
const { getEntitlements, entitlementsFor, vendorAllowed, chatLimiterFor } =
  await import(`file://${OUT}/entitlements.js`);

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const eq = (label, actual, expected) =>
  check(label, Object.is(actual, expected), `expected ${expected}, got ${actual}`);

// ── Plan normalisation ────────────────────────────────────────────
console.log('\nPlan normalisation');
eq('free is free', getEntitlements({ plan: 'free' }).plan, 'free');
eq('pro is pro', getEntitlements({ plan: 'pro' }).plan, 'pro');
eq('scale is scale', getEntitlements({ plan: 'scale' }).plan, 'scale');
eq('case and whitespace do not change the answer', getEntitlements({ plan: '  PRO ' }).plan, 'pro');

// The failure direction that matters. `organizations.plan` is free text
// in the database, so an unrecognised value is not a hypothetical — and
// resolving it upward would hand out a tier nobody paid for.
eq('an unknown plan falls to free', getEntitlements({ plan: 'enterprise' }).plan, 'free');
eq('a null plan falls to free', getEntitlements({ plan: null }).plan, 'free');
eq('a missing org falls to free', getEntitlements(null).plan, 'free');
eq('an undefined org falls to free', getEntitlements(undefined).plan, 'free');

// ── The bot convenience ───────────────────────────────────────────
console.log('\nEntitlements from a bot row');
eq('reads the embedded organizations(plan)',
  entitlementsFor({ organizations: { plan: 'scale' } }).plan, 'scale');
// selectBot embeds the org; rows returned from an insert or an update
// do not. Those paths do not ask, but if one starts to, it must not
// silently receive the top tier.
eq('a row fetched without the embed is free',
  entitlementsFor({ organizations: undefined }).plan, 'free');

// ── Vendors ───────────────────────────────────────────────────────
console.log('\nVendor allowlist');
check("'*' allows anything", vendorAllowed(getEntitlements({ plan: 'free' }), 'google'));
check('an explicit list allows what is on it',
  vendorAllowed({ vendors: ['google', 'workers-ai'] }, 'workers-ai'));
check('an explicit list refuses what is not',
  !vendorAllowed({ vendors: ['google'] }, 'anthropic'));
check('an empty list refuses everything',
  !vendorAllowed({ vendors: [] }, 'google'));

// ── Limiter selection ─────────────────────────────────────────────
console.log('\nRate limiter selection');
const env = { RL_FREE: 'free-ns', RL_PRO: 'pro-ns', RL_SCALE: 'scale-ns' };
eq('free counts against RL_FREE', chatLimiterFor(env, getEntitlements({ plan: 'free' })), 'free-ns');
eq('pro counts against RL_PRO', chatLimiterFor(env, getEntitlements({ plan: 'pro' })), 'pro-ns');
eq('scale counts against RL_SCALE', chatLimiterFor(env, getEntitlements({ plan: 'scale' })), 'scale-ns');

// One namespace per tier, or a burst on one plan eats another's budget.
const bindings = ['free', 'pro', 'scale'].map((p) => getEntitlements({ plan: p }).limiter);
eq('no two plans share a limiter binding', new Set(bindings).size, bindings.length);

// Fail open. A limiter outage, a `wrangler dev` session without the
// config, or a Worker deployed ahead of its wrangler.jsonc must all
// mean "no limiting", never "no chat" and never "no deploy".
eq('an absent binding yields undefined rather than throwing',
  chatLimiterFor({}, getEntitlements({ plan: 'free' })), undefined);

// ── The bindings actually exist ───────────────────────────────────
//
// The one thing a unit test can check about deploy-time configuration:
// that every binding this module names is declared, in both
// environments. A plan pointing at a binding that was never configured
// silently stops being rate limited at all.
console.log('\nDeclared bindings match the code');
const wrangler = readFileSync(join(ROOT, 'apps/api/wrangler.jsonc'), 'utf8');
for (const binding of bindings) {
  check(`${binding} is declared in production`,
    new RegExp(`"name":\\s*"${binding}"`).test(wrangler));
}
const staging = wrangler.slice(wrangler.indexOf('"staging"'));
for (const binding of bindings) {
  check(`${binding} is declared in staging`,
    new RegExp(`"name":\\s*"${binding}"`).test(staging));
}
// Namespace ids are account-wide. Two bindings sharing one is the same
// bug as two plans sharing a binding, one layer down.
const ids = [...wrangler.matchAll(/"namespace_id":\s*"(\d+)"/g)].map((m) => m[1]);
eq('every rate-limit namespace id is distinct', new Set(ids).size, ids.length);

rmSync(OUT, { recursive: true, force: true });
console.log(failures ? `\n${failures} failing check(s).\n` : '\nAll entitlements unit tests passed.\n');
process.exit(failures ? 1 : 0);
