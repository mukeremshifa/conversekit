#!/usr/bin/env node
// ----------------------------------------------------------------
// The landing page's product shots.
//
// Seven screens x two themes = fourteen images, each encoded as AVIF
// and WebP at two widths and written to apps/site/assets/shots/ under a
// content-hashed name. Nobody takes these by hand: fourteen images that
// have to agree with each other about one fictional clinic, and that
// have to be retaken every time a screen changes, is a job for a script
// or it is a job that stops being done.
//
//   npm run shots:shoot                 build the harness, take all 14
//   npm run shots:shoot -- --only=hero  one slot, both themes
//   npm run shots:shoot -- --no-build   reuse the last harness build
//   npm run shots:shoot -- --keep-png   leave the raw captures on disk
//
// WHAT MAKES A RE-SHOOT REPRODUCIBLE. Identical input has to produce
// identical bytes, or every run rewrites fourteen content hashes and
// the git diff is noise. Four things would otherwise drift, and each is
// pinned below: the wall clock (frozen — see SHOT_NOW_ISO), the
// timezone and locale (the clinic's own, en-US), animation (reduced
// motion, which the dashboard's stylesheet already honours by killing
// every keyframe), and the colour profile (sRGB).
//
// The harness itself is apps/app/src/shot.tsx and
// apps/app/src/shot-widget.ts; it mounts the real app and the real
// widget over stubbed fetches, so these are photographs of the product
// rather than pictures of a mock-up.
// ----------------------------------------------------------------
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import sharp from 'sharp';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'apps', 'app');
const BUILD_DIR = path.join(APP_DIR, '.shots-build');
// The widget harness loads the REAL widget, which is a ck-cdn artifact
// now. Serving the CDN's build alongside the harness is what lets it,
// without either side knowing about the other.
const CDN_DIR = path.join(ROOT, 'apps', 'cdn', 'dist');
// Shots are landing-page source, not build output: they are committed,
// and gen-shots.mjs writes their <picture> markup into the page here.
const OUT_DIR = path.join(ROOT, 'apps', 'site', 'assets', 'shots');
const PNG_DIR = path.join(BUILD_DIR, 'png');

/**
 * The instant every page is frozen at.
 *
 * MUST MATCH `SHOT_NOW_ISO` in apps/app/src/fixtures/fernbrook.ts —
 * the fixtures date their leads and transcripts relative to it, and the
 * widget bolds whichever row of opening hours is "today". The harness
 * reports its own copy back as `window.__ckShotNow` and this script
 * refuses to shoot if the two have drifted, so the duplication is
 * checked rather than hoped for.
 */
const SHOT_NOW_ISO = '2026-08-18T15:20:00.000Z';

/** The clinic's own zone and an explicit locale. Every date on these
 *  screens is rendered by `toLocaleDateString(undefined, …)`, which
 *  means "whatever this browser is set to" — unpinned, the same shoot
 *  produces different pixels on two machines. */
const TIMEZONE = 'America/Los_Angeles';
const LOCALE = 'en-US';

/** Retina capture, downsampled to the delivered widths. Supersampling
 *  a 2x capture to 1x is visibly crisper than capturing at 1x, and it
 *  costs nothing at delivery. */
const SCALE = 2;

/** A slot may buy more, and one does: see `scale` on the widget slot. */
const scaleOf = (slot) => slot.scale ?? SCALE;

// ── The slots ────────────────────────────────────────────────────
//
// `widths` are the delivered widths, largest first; the first is the
// one the budget applies to and the one a wide viewport downloads.
// None may exceed width x SCALE — everything here is a downsample of
// the capture, never an upscale of it.
//
// `expect` is text that only appears once THAT SCREEN's own data has
// landed. It is not redundant with the harness's readiness flag: the
// app's me/bots requests settle before a screen has even mounted, so
// without this a shot can be taken in the window between the two.
//
// `scrollTo` names a card to bring to the top of the frame, for the one
// screen whose subject is not the first thing on it. The alternative
// was to reorder the real screen for the benefit of a screenshot, which
// is the tail wagging the dog.
//
// `crop` trims the capture, in CSS pixels, before it is downsampled.
// The workflow tabs show one screen each and the app's sidebar is the
// same 240px column in all three of them: repeated three times down the
// page it reads as the chrome the shots have in common rather than as
// the thing each one is of. Cropping here rather than with CSS in the
// page keeps the delivered bytes down to what is actually shown, and
// the manifest reports the cropped size so the <img> gets the right
// intrinsic ratio.

/** The dashboard sidebar: `w-60` (240px) plus its right border. What
 *  the workflow tabs crop off. */
const SIDEBAR = 241;

/** And 100px off the foot of the same three. The panel pins its prose
 *  to the top and bottom of whatever the screen beside it is tall, so
 *  the shot's aspect ratio is what sets the gap between the title and
 *  the sentence: at the full 720 it opens to a quarter of the card. */
const TAIL = 100;

const SLOTS = [
  {
    id: 'hero',
    harness: 'shot',
    route: 'overview',
    width: 1440,
    height: 900,
    widths: [1440, 720],
    budget: { avif: 120, webp: 180 },
    expect: 'Top questions',
    alt: 'The ConverseKit dashboard overview: conversations, messages, leads and lead conversion over thirty days, with the questions visitors asked most.',
  },
  {
    id: 'widget',
    harness: 'widget',
    // A desktop viewport, not a phone. Under 481px widget.js drops the
    // panel to calc(100vw - 32px), so a 390-wide capture is a 358px
    // panel wearing 16px of page margin down each side — which is why
    // the bento tile read as padded whatever width it was given. Above
    // that breakpoint the panel is its own 380px and cropFromPage trims
    // the empty desktop page from around it.
    //
    // The height sets both the shape and where the transcript is cut.
    // The replay ends scrolled to the bottom and the conversation is
    // ~549px of content, so this number decides what the panel header
    // crops through — something is always above the fold.
    //
    // 575 lands it in the 8px gap between the business-profile card and
    // the visitor's first question: the card scrolls out whole and the
    // exchange below it starts clean, four pixels down. The obvious
    // alternative, folding above the card instead, needs a transcript
    // ~440px tall — and widget.js caps that at 420 once the viewport
    // passes 700px high, so the window for it does not exist. Off by
    // twenty either way and the shot slices a line of the clinic's
    // address in half, which reads as a broken render rather than as a
    // scrolled chat. Re-time it against the element boxes in
    // #aicb-messages if the scripted turns ever change.
    width: 900,
    height: 575,
    cropFromPage: true,
    // 3x, alone among the slots: the crop keeps only ~426 of the 900
    // CSS pixels, and at the shared 2x that is not enough to serve the
    // tile's own display width twice over.
    scale: 3,
    widths: [1024, 512],
    budget: { avif: 70, webp: 80 },
    alt: 'The chat widget open on a website, answering a question about the clinic and then asking the visitor for their contact details.',
  },
  {
    id: 'leads',
    harness: 'shot',
    route: 'leads',
    width: 1120,
    height: 720,
    widths: [1120, 560],
    budget: { avif: 70, webp: 70 },
    expect: 'Talia Hallowell',
    alt: 'The Leads screen: ten leads captured from chat, each with the name, email, phone and what they asked about.',
  },
  {
    id: 'knowledge',
    harness: 'shot',
    route: 'knowledge',
    width: 1120,
    height: 720,
    widths: [1120, 560],
    budget: { avif: 70, webp: 70 },
    expect: 'Vaccination schedules 2026',
    // "Add a source" comes first on the real screen, and it should:
    // the empty knowledge base is the state that needs the affordance.
    // The shot is about the six sources, which sit under it.
    scrollTo: 'Indexed sources',
    alt: 'The Knowledge Base: six sources (a web page, a PDF, markdown, plain text and a written FAQ), with one still being indexed.',
  },
  {
    id: 'profile',
    harness: 'shot',
    route: 'profile',
    width: 1120,
    height: 720,
    crop: { left: SIDEBAR, bottom: TAIL },
    widths: [1120, 560],
    budget: { avif: 70, webp: 70 },
    expect: 'Opening hours',
    alt: 'The Business Profile screen, where the clinic\u2019s name, address and opening hours are filled in.',
  },
  {
    id: 'install',
    harness: 'shot',
    route: 'install',
    width: 1120,
    height: 720,
    crop: { left: SIDEBAR, bottom: TAIL },
    widths: [1120, 560],
    budget: { avif: 70, webp: 70 },
    expect: 'Embed snippet',
    alt: 'The Install screen showing the one script tag that has to be pasted into a site.',
  },
  {
    id: 'conversations',
    harness: 'shot',
    route: 'conversations',
    width: 1120,
    height: 720,
    crop: { left: SIDEBAR, bottom: TAIL },
    widths: [1120, 560],
    budget: { avif: 70, webp: 70 },
    expect: 'Do you see rabbits?',
    alt: 'The Conversations screen: visitor transcripts grouped by session, showing what the bot was asked and how it answered.',
  },
];

const THEMES = ['light', 'dark'];

// ── Encoder settings ─────────────────────────────────────────────
//
// 4:4:4 on both, which is the setting that matters here: these are
// screenshots of text and one-pixel borders, and chroma subsampling
// turns a hairline table rule into a smear. The qualities are the
// lowest that stay clean on the densest shot (the Leads table) while
// leaving room under the budgets in docs/landing-redesign.md §6.
const AVIF = { quality: 58, effort: 6, chromaSubsampling: '4:4:4' };
const WEBP = { quality: 78, effort: 6, smartSubsample: false };

// ── Chrome ───────────────────────────────────────────────────────
//
// puppeteer-core drives the browser that is already installed rather
// than downloading a second one. If none of these exist, CHROME_PATH
// says where it is.
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) {
    throw new Error(
      'No Chrome found. Set CHROME_PATH to the executable, or install Chrome.\nLooked in:\n  '
      + CHROME_CANDIDATES.join('\n  '),
    );
  }
  return found;
}

/**
 * Freezes the wall clock, in every page, before a line of page script
 * runs.
 *
 * A Proxy rather than a subclass because both call shapes have to keep
 * working: `new Date()` is what the widget's "which day is it" check
 * uses, and a bare `Date()` throws if the binding is a class. Every
 * other form — `new Date(iso)`, `Date.parse`, `instanceof Date` — goes
 * through to the real constructor untouched, so only "now" is pinned.
 *
 * Note that performance.now() is deliberately left alone: React
 * schedules against it, and anything measuring elapsed time against a
 * frozen clock waits forever.
 */
function freezeClock(fixedMs) {
  const RealDate = Date;
  const proxy = new Proxy(RealDate, {
    construct: (target, args) => (args.length ? new target(...args) : new target(fixedMs)),
    apply: (target, _this, args) => (args.length ? target(...args) : new target(fixedMs).toString()),
    get: (target, prop, receiver) => (prop === 'now' ? () => fixedMs : Reflect.get(target, prop, receiver)),
  });
  globalThis.Date = proxy;
}

// ── A static server over the harness and the CDN build ───────────
//
// Two roots, checked in order: the built harness, then apps/cdn/dist —
// which is where widget.js and its font live.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function serve(roots) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).replace(/^\/+/, '');
    for (const root of roots) {
      const file = path.resolve(root, rel);
      // Path traversal is not a threat on a localhost server that lives
      // for ninety seconds, but a request escaping into the repo would
      // be a confusing bug rather than a security one, and it costs a
      // line to rule out.
      if (!file.startsWith(path.resolve(root))) continue;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
        return;
      }
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`not found: /${rel}`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ── Capture ──────────────────────────────────────────────────────

async function capture(browser, base, slot, theme) {
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console: ${msg.text()}`);
  });
  // The console line for a failed request says only "404 (Not Found)",
  // with no URL on it. This is the half that says which one.
  page.on('response', (res) => {
    if (res.status() >= 400) problems.push(`${res.status()} ${res.url()}`);
  });

  await page.setViewport({ width: slot.width, height: slot.height, deviceScaleFactor: scaleOf(slot) });
  await page.emulateTimezone(TIMEZONE);
  await page.emulateMediaFeatures([
    // The dashboard's stylesheet turns every keyframe off under this,
    // so the stagger, the chart wipe and the widget's pop are all
    // finished before the first frame rather than mid-flight.
    { name: 'prefers-reduced-motion', value: 'reduce' },
    { name: 'prefers-color-scheme', value: theme },
  ]);
  await page.evaluateOnNewDocument(freezeClock, Date.parse(SHOT_NOW_ISO));

  const url = `${base}/${slot.harness === 'widget' ? 'shot-widget' : 'shot'}.html`
    + `?theme=${theme}${slot.route ? `&screen=${slot.route}` : ''}`;
  await page.goto(url, { waitUntil: 'load' });

  // Screen data first, then the harness's own all-clear. In that order:
  // the flag can go up between the app's account requests and the
  // screen's, and this is the check that closes that window.
  if (slot.expect) {
    await page.waitForFunction(
      (needle) => document.body.innerText.includes(needle),
      { timeout: 30_000 },
      slot.expect,
    );
  }
  await page.waitForSelector('html[data-shot="ready"]', { timeout: 30_000 });

  const now = await page.evaluate(() => window.__ckShotNow);
  if (now !== SHOT_NOW_ISO) {
    throw new Error(
      `clock drift: the harness is dated ${now}, this script freezes at ${SHOT_NOW_ISO}.\n`
      + '  Bring SHOT_NOW_ISO in scripts/shoot.mjs and apps/app/src/fixtures/fernbrook.ts back into step.',
    );
  }

  const misses = await page.evaluate(() => window.__ckShotMisses ?? []);
  if (misses.length) {
    throw new Error(`the harness could not answer:\n  ${misses.join('\n  ')}`);
  }
  if (problems.length) throw new Error(`the page reported:\n  ${problems.join('\n  ')}`);

  if (slot.scrollTo) {
    await page.evaluate((title, pad) => {
      // <main> is the scroll container: the Shell pins the page to the
      // viewport and scrolls the content column, so scrolling `window`
      // here would move nothing at all.
      const scroller = document.querySelector('main');
      const heading = [...document.querySelectorAll('h2')].find((h) => h.textContent.trim() === title);
      if (!scroller || !heading) throw new Error(`no card titled "${title}" to scroll to`);
      const card = heading.closest('.rounded-xl') ?? heading;
      scroller.scrollTop += card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - pad;
    }, slot.scrollTo, 24);
    // Two frames: one for the scroll to apply, one for it to paint.
    await page.evaluate(() => new Promise((done) => {
      requestAnimationFrame(() => requestAnimationFrame(done));
    }));
  }

  // One slot's frame is not a constant: the widget's is its panel's
  // box, which only the harness can measure. See __ckShotCrop in
  // apps/app/src/shot-widget.ts. The two themes must agree — the
  // manifest carries one size per slot, not one per theme — so the
  // second capture checks the first rather than quietly overwriting it.
  if (slot.cropFromPage) {
    const crop = await page.evaluate(() => window.__ckShotCrop);
    if (!crop) throw new Error('cropFromPage: the harness reported no __ckShotCrop');
    if (slot.crop && JSON.stringify(slot.crop) !== JSON.stringify(crop)) {
      throw new Error(
        `cropFromPage: the themes framed differently — ${JSON.stringify(slot.crop)} vs ${JSON.stringify(crop)}`,
      );
    }
    slot.crop = crop;
  }

  const png = await page.screenshot({ type: 'png', captureBeyondViewport: false });
  await page.close();
  return Buffer.from(png);
}

// ── Encode and write ─────────────────────────────────────────────

const hash8 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 8);

/**
 * Drop older hashes of the same image. Content-hashed names mean a
 * re-encode lands beside its predecessor rather than replacing it, and
 * apps/site/assets/shots/ would otherwise grow a copy per shoot.
 *
 * The extension is part of the match, not just the prefix: an AVIF and
 * its WebP fallback share every part of the name except the hash and
 * the suffix, so a prefix-only sweep deletes the sibling that was
 * written a moment earlier and leaves half the set on disk.
 */
function pruneOlder(prefix, ext, keep) {
  const mine = new RegExp(`^${prefix}\\.[0-9a-f]{8}\\.${ext}$`);
  for (const file of fs.readdirSync(OUT_DIR)) {
    if (file !== keep && mine.test(file)) fs.unlinkSync(path.join(OUT_DIR, file));
  }
}

/**
 * The slot's delivered size in CSS pixels, after `crop`. What the
 * manifest reports and what the page's <img> uses for its ratio.
 */
function framed(slot) {
  const { left = 0, top = 0, right = 0, bottom = 0 } = slot.crop ?? {};
  return { width: slot.width - left - right, height: slot.height - top - bottom };
}

/** The same rectangle in captured pixels, for sharp. */
function extract(slot) {
  if (!slot.crop) return null;
  const { left = 0, top = 0 } = slot.crop;
  const { width, height } = framed(slot);
  const scale = scaleOf(slot);
  return {
    left: left * scale, top: top * scale, width: width * scale, height: height * scale,
  };
}

async function encode(png, slot, theme) {
  const written = [];
  const region = extract(slot);
  for (const width of slot.widths) {
    for (const [ext, options] of [['avif', AVIF], ['webp', WEBP]]) {
      const pipeline = sharp(png);
      if (region) pipeline.extract(region);
      const body = await pipeline
        .resize({ width, withoutEnlargement: true })
        [ext](options)
        .toBuffer();

      const prefix = `${slot.id}-${theme}-${width}`;
      const name = `${prefix}.${hash8(body)}.${ext}`;
      fs.writeFileSync(path.join(OUT_DIR, name), body);
      pruneOlder(prefix, ext, name);

      written.push({
        width,
        format: ext,
        file: `/shots/${name}`,
        bytes: body.length,
        // Only the delivered width the budget is written against; the
        // narrow cut is always smaller and never the binding one.
        overBudget: width === slot.widths[0] && body.length > slot.budget[ext] * 1024,
      });
    }
  }
  return written;
}

// ── Main ─────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const only = (argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);
const skipBuild = argv.includes('--no-build');
const keepPng = argv.includes('--keep-png');

const slots = only ? SLOTS.filter((s) => s.id === only) : SLOTS;
if (!slots.length) {
  console.error(`No slot named "${only}". Known: ${SLOTS.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

if (!skipBuild) {
  console.log('Building the harness…');
  // Vite's own entry point under this Node, not the `vite` shim in
  // .bin: on Windows that shim is a .cmd, and Node refuses to spawn a
  // .cmd without a shell — which fails with an empty stdout and looks
  // exactly like a build that produced no output.
  // npm workspaces hoists shared deps to the root, so vite lands in
  // either place depending on what else is installed.
  const vite = [
    path.join(APP_DIR, 'node_modules', 'vite', 'bin', 'vite.js'),
    path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
  ].find((p) => fs.existsSync(p));
  if (!vite) throw new Error('vite not installed — run `npm install` at the repo root');
  const built = spawnSync(
    process.execPath,
    [vite, 'build', '--config', 'vite.shot.config.ts'],
    { cwd: APP_DIR, stdio: 'inherit' },
  );
  if (built.error) throw built.error;
  if (built.status !== 0) process.exit(built.status ?? 1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
if (keepPng) fs.mkdirSync(PNG_DIR, { recursive: true });

const { server, port } = await serve([BUILD_DIR, CDN_DIR]);
const base = `http://127.0.0.1:${port}`;

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: [
    // sRGB, so the encoded bytes do not depend on the colour profile of
    // whatever monitor is attached to the machine running this.
    '--force-color-profile=srgb',
    `--lang=${LOCALE}`,
    '--hide-scrollbars',
    '--disable-dev-shm-usage',
  ],
});

const results = [];
let failed = 0;

try {
  for (const slot of slots) {
    for (const theme of THEMES) {
      process.stdout.write(`  ${slot.id}-${theme} … `);
      try {
        const png = await capture(browser, base, slot, theme);
        if (keepPng) fs.writeFileSync(path.join(PNG_DIR, `${slot.id}-${theme}.png`), png);
        const written = await encode(png, slot, theme);
        results.push({ slot, theme, written });
        console.log('ok');
      } catch (err) {
        failed++;
        console.log('FAILED');
        console.error(`\n    ${String(err.message ?? err).split('\n').join('\n    ')}\n`);
      }
    }
  }
} finally {
  await browser.close();
  server.close();
}

// ── The manifest ─────────────────────────────────────────────────
//
// Phase F builds the <picture> markup from this rather than pasting
// eight hashes per image into the page by hand. Deliberately carries no
// timestamp: a generated file that changes on every run is a file that
// shows up in every diff saying nothing.
if (!only && !failed) {
  const manifest = {};
  for (const { slot, theme, written } of results) {
    manifest[slot.id] ??= {
      capture: { ...framed(slot), scale: scaleOf(slot) },
      alt: slot.alt,
      themes: {},
    };
    manifest[slot.id].themes[theme] = written.map(({ width, format, file, bytes }) =>
      ({ width, format, file, bytes }));
  }
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

// ── The table ────────────────────────────────────────────────────
//
// Printed every run, because a budget nobody can see is a budget that
// is already broken.
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
let over = 0;
let total = 0;

console.log('\n  slot            theme  width  format     size   budget');
console.log('  ' + '─'.repeat(56));
for (const { slot, theme, written } of results) {
  for (const w of written) {
    total += w.bytes;
    if (w.overBudget) over++;
    const budget = w.width === slot.widths[0] ? `${slot.budget[w.format]} KB` : '';
    console.log(
      `  ${slot.id.padEnd(15)} ${theme.padEnd(6)} ${String(w.width).padStart(5)}`
      + `  ${w.format.padEnd(6)} ${kb(w.bytes).padStart(8)}   ${budget}${w.overBudget ? '  OVER' : ''}`,
    );
  }
}
console.log('  ' + '─'.repeat(56));
console.log(`  ${results.length} shots, ${results.reduce((n, r) => n + r.written.length, 0)} files, ${kb(total)} on disk\n`);

if (failed) {
  console.error(`${failed} shot(s) failed.\n`);
  process.exit(1);
}
if (over) {
  console.error(`${over} image(s) over budget — see docs/landing-redesign.md §6.\n`);
  process.exit(1);
}
console.log('All shots inside budget.\n');
