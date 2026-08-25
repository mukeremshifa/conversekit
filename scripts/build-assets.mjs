#!/usr/bin/env node
// ----------------------------------------------------------------
// Builds the two buildless targets — apps/cdn and apps/site — out of
// their `assets/` sources into `dist/`.
//
// Three jobs, and none of them is a bundler:
//
//  1. Token substitution. No source file in this repo names a hostname;
//     they carry `__CK_API__`, `__CK_CDN__` and friends, and this fills
//     them in from config/origins.js. That is what makes moving to
//     conversekit.io a one-line change.
//
//  2. Widget placement. widget.js is written to ONE path, /v1/widget.js,
//     alongside the fonts it pulls. The major is in the URL because that
//     string ends up pasted into other people's HTML and can never be
//     changed afterwards; a breaking widget change bumps WIDGET_MAJOR in
//     config/origins.js and /v1/ keeps serving the old build.
//
//  3. Shared brand. packages/brand/assets/ is the single copy of the
//     favicons, logos and web fonts; it is copied into every target that
//     serves them rather than referenced cross-origin, so the landing
//     page and the dashboard keep same-origin icon and font loads.
//
// Idempotent: dist/ is removed and rebuilt every run.
// ----------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { substitute, WIDGET_MAJOR } from '../config/origins.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Only the served half. The package's own README and font
// provenance notes sit one level up, where no copy step can reach them.
const BRAND = path.join(ROOT, 'packages', 'brand', 'assets');

/** Files whose contents get token substitution. Everything else is
 *  copied byte-for-byte — a `__CK_` sequence inside a .png is a
 *  coincidence, not a token. */
const TEXTUAL = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.txt', '']);

/**
 * Names that never reach a dist/, whatever they are:
 *
 *  - `__*` — scratch harnesses. `public/__shot.html`, a screenshot rig
 *    with seeded fake messages, was once served from the site root
 *    because `wrangler pages deploy public` uploaded the directory as it
 *    found it, git's opinion notwithstanding. This build step replaced
 *    that upload, so the guard belongs here rather than in a predeploy
 *    script that only ever ran on one laptop.
 *  - `README*` — provenance travels with the source, not with the bytes.
 */
const excluded = (name) => name.startsWith('__') || /^README/i.test(name);

const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });

function fill(text, extraTokens = {}) {
  let out = substitute(text);
  for (const [token, value] of Object.entries(extraTokens)) out = out.split(token).join(value);
  return out;
}

function copyTree(from, to, { tokens = {}, skip = () => false } = {}) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (excluded(entry.name) || skip(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) { copyTree(src, dst, { tokens, skip }); continue; }
    if (TEXTUAL.has(path.extname(entry.name))) {
      fs.writeFileSync(dst, fill(fs.readFileSync(src, 'utf8'), tokens));
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

/** The version the widget reports to the server on every session. It is
 *  declared once, in widget.js, and read from there rather than kept in
 *  a second place that can drift out of step with the artifact. Not a
 *  URL any more — it is what the build logs and what a session carries,
 *  which is how you tell which build a tenant is running. */
function widgetVersion(source) {
  const m = /var WIDGET_VERSION = '([^']+)'/.exec(source);
  if (!m) throw new Error('widget.js: WIDGET_VERSION not found — the build cannot report which version it shipped');
  return m[1];
}

// ── cdn ───────────────────────────────────────────────────────────
function buildCdn() {
  const app = path.join(ROOT, 'apps', 'cdn');
  const src = path.join(app, 'assets');
  const dist = path.join(app, 'dist');
  rmrf(dist);

  const widget = fill(fs.readFileSync(path.join(src, 'widget.js'), 'utf8'));
  const version = widgetVersion(widget);

  // Everything but widget.js; the block below places that itself.
  copyTree(src, dist, { skip: (name) => name === 'widget.js' });

  // /v1/ is a self-contained bundle root, fonts included. The widget
  // derives ASSET_BASE from its own <script src>, so a tenant loading
  // /v1/widget.js asks for /v1/fonts/… — put the font anywhere else and
  // it 404s, and a discarded font fails silently: the widget renders in
  // the fallback face on every customer site while looking correct on
  // ours.
  const at = path.join(dist, WIDGET_MAJOR);
  fs.mkdirSync(at, { recursive: true });
  fs.writeFileSync(path.join(at, 'widget.js'), widget);
  copyTree(path.join(BRAND, 'fonts'), path.join(at, 'fonts'));

  copyTree(path.join(BRAND, 'brand'), path.join(dist, 'brand'));

  console.log(`cdn   → apps/cdn/dist   widget ${version} at /${WIDGET_MAJOR}/widget.js`);
}

// ── site ──────────────────────────────────────────────────────────
function buildSite() {
  const app = path.join(ROOT, 'apps', 'site');
  const dist = path.join(app, 'dist');
  rmrf(dist);
  copyTree(path.join(app, 'assets'), dist);
  copyTree(path.join(BRAND, 'brand'), path.join(dist, 'brand'));
  copyTree(path.join(BRAND, 'fonts'), path.join(dist, 'fonts'));
  console.log('site  → apps/site/dist');
}

const target = process.argv[2] ?? 'all';
if (!['cdn', 'site', 'all'].includes(target)) {
  console.error(`Unknown target '${target}'. Expected: cdn | site | all`);
  process.exit(1);
}
if (target === 'cdn' || target === 'all') buildCdn();
if (target === 'site' || target === 'all') buildSite();
