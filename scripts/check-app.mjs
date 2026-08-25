#!/usr/bin/env node
// ----------------------------------------------------------------
// Static checks for the BUILT dashboard bundle.
//
// This exists because of a bug nothing could have caught. The dashboard
// talks to Supabase directly for sign-in — only the resulting JWT goes
// to our API — and the project URL and publishable key it used were two
// hardcoded constants in src/lib/config.ts, filled in by hand per a
// checklist. The four-Worker rebuild filled them in with STAGING's
// values and shipped them to production.
//
// The result was a split brain that looked fine from every angle a
// build can see: the bundle compiled, the types checked, the landing
// page passed its own checks, and the deployed dashboard rendered. It
// authenticated users against the staging project and then sent those
// tokens to the production Worker, which pins issuer and audience
// (src/auth.ts) and refused every one of them. Sign-in appeared to
// work; every admin call 401'd. An account created on production could
// not sign in at all, because the login went to a project that had
// never heard of it.
//
// The values now come from config/origins.js via Vite `define`, so
// CK_ENV moves both halves together. This asserts that what actually
// landed in the bundle is what that switch selected — which catches a
// re-hardcoded literal, a stale define, and a build that ran without
// the CK_ENV its deploy target needs.
//
// Run after `npm run build:app`.
// ----------------------------------------------------------------
import fs from 'fs';
import path from 'path';
import { ORIGINS, SUPABASE } from '../config/origins.js';

const ROOT = 'apps/app/dist';
const indexPath = path.join(ROOT, 'index.html');

if (!fs.existsSync(indexPath)) {
  console.error(`No dashboard build at ${indexPath} — run \`npm run build:app\` first.`);
  process.exit(1);
}

let fail = 0;
const bad = (m) => { console.log('  FAIL ' + m); fail++; };
const ok = (m) => console.log('  ok   ' + m);

const html = fs.readFileSync(indexPath, 'utf8');

// ── the entry bundle ──
// Named by content hash, so it is discovered rather than assumed.
const entry = [...html.matchAll(/src="([^"]*\/assets\/index-[^"]+\.js)"/g)].map((m) => m[1]);
if (entry.length !== 1) {
  console.error(`Expected exactly one entry bundle in index.html, found ${entry.length}.`);
  process.exit(1);
}
const bundlePath = path.join(ROOT, entry[0].replace(/^\//, ''));
if (!fs.existsSync(bundlePath)) {
  console.error(`index.html points at ${entry[0]}, which is not on disk.`);
  process.exit(1);
}
const js = fs.readFileSync(bundlePath, 'utf8');
console.log(`\nDashboard bundle: ${entry[0]}  (${(js.length / 1024).toFixed(0)} KB)`);
console.log(`Expecting the ${process.env.CK_ENV === 'staging' ? 'STAGING' : 'PRODUCTION'} set.\n`);

// ── the Supabase project ──
// Both halves, because either one alone being right is not enough: the
// key authenticates against the project the URL names, and a mismatched
// pair fails at sign-in rather than at build.
js.includes(SUPABASE.url)
  ? ok(`auth points at ${SUPABASE.url}`)
  : bad(`bundle does not contain ${SUPABASE.url} — it is built against the wrong project`);

js.includes(SUPABASE.anonKey)
  ? ok('publishable key matches that project')
  : bad('bundle does not carry the expected publishable key');

// The one that actually catches the split brain. A second project URL
// in the bundle means something still names one directly instead of
// reading the switch.
const projects = [...new Set([...js.matchAll(/https:\/\/[a-z0-9-]+\.supabase\.co/g)].map((m) => m[0]))];
const strays = projects.filter((u) => u !== SUPABASE.url);
strays.length
  ? bad(`bundle names ${strays.length} other Supabase project(s): ${strays.join(', ')}`)
  : ok('no other Supabase project in the bundle');

// ── the API it calls ──
// The Worker that verifies those tokens. If this disagrees with the
// project above, the tokens are minted by one database and checked
// against another — which is the failure this file is named after.
js.includes(ORIGINS.api)
  ? ok(`API base is ${ORIGINS.api}`)
  : bad(`bundle does not contain ${ORIGINS.api}`);

// ── nothing left unsubstituted ──
// A surviving token is a `define` that was never wired up: the constant
// reaches the browser as a ReferenceError at module scope, which blanks
// the whole app rather than degrading.
const leftover = [...new Set([...js.matchAll(/__CK_[A-Z_]+__/g)].map((m) => m[0]))];
leftover.length
  ? bad(`unsubstituted token(s) in the bundle: ${leftover.join(', ')}`)
  : ok('every __CK_*__ token substituted');

console.log(fail ? `\n${fail} FAILURE(S)` : '\nAll dashboard checks passed.');
process.exit(fail ? 1 : 0);
