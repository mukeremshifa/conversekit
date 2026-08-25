// Runtime half of the landing page's motion policy. check-landing.mjs reads
// the source and enforces the rules that are true by construction — opacity
// and transform only, one perpetual animation, the reveal gated on .js and
// released under reduced motion. Those are the ones worth failing a build
// over, because they are deterministic.
//
// This script checks the half that only exists once a browser runs the page:
// that every reveal actually fires, that none of them shift layout, and that
// the two escape hatches (reduced motion, no JS) really do leave a fully
// visible page rather than a blank one. A reveal that never fires is invisible
// content, and it fails silently — the section is simply not there, and only
// for the visitor whose viewport or browser hit the case.
//
// It also *reports* frame pacing and blocking time under CPU throttling. Those
// are printed, not asserted. On a developer machine the round-to-round spread
// swamps the difference between this page with reveals and the same page with
// every reveal stripped out — measured, it moved from "reveals are clearly
// worse" to "the control is worse" depending on what else the machine was
// doing. A gate on a number that noisy fails honest work and passes real
// regressions, so the numbers are here to be looked at, not to vote.
//
// Needs Chrome (or Edge) on the box, like scripts/shoot.mjs. Run it with
// `npm run check:motion`.
import http from 'http';
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-core';

// The BUILT landing page: the source holds `__CK_*__` tokens rather
// than hostnames, so `npm run build:assets -- site` has to have run.
const ROOT = 'apps/site/dist';
const PORT = 8799;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chrome = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
if (!chrome) {
  console.error('No Chrome found. Set CHROME_PATH to the executable.\nLooked in:\n  '
    + CHROME_CANDIDATES.join('\n  '));
  process.exit(1);
}

// The page is buildless and every asset is same-origin, so a twenty-line
// static server is the whole harness. file:// will not do: the shots and the
// font are absolute paths.
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.webp': 'image/webp', '.avif': 'image/avif', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json', '.txt': 'text/plain',
};
if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error(`No landing page at ${ROOT}/index.html — run \`npm run build:assets -- site\` first.`);
  process.exit(1);
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(path.resolve(ROOT)) && !file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(PORT, r));
const URL_ = `http://127.0.0.1:${PORT}/`;

let fail = 0;
const ok = (m) => console.log('  ok   ' + m);
const bad = (m) => { console.log('  FAIL ' + m); fail++; };

const browser = await puppeteer.launch({ executablePath: chrome, args: ['--no-sandbox'] });

// The live widget is a separate product with its own budget; loading it here
// would put its parse time inside every number below.
async function open({ reduced = false, js = true, width = 1280, height = 900, mobile = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
  await page.setRequestInterception(true);
  page.on('request', (r) => (r.url().endsWith('/widget.js') ? r.abort() : r.continue()));
  if (!js) await page.setJavaScriptEnabled(false);
  if (reduced) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await page.goto(URL_, { waitUntil: 'networkidle2' });
  return page;
}

const state = (page) => page.evaluate(() =>
  [...document.querySelectorAll('[data-reveal]')].map((el) => ({
    id: (el.closest('section')?.id || el.closest('section')?.className || '?') + ' .'
      + String(el.className).replace(' is-in', '').replace(/\s+/g, '.'),
    op: +getComputedStyle(el).opacity,
    inView: el.getBoundingClientRect().top < innerHeight * 0.88,
    is: el.classList.contains('is-in'),
  })));

// One pass down the page, then long enough for the slowest reveal to finish:
// 0.5s of transition behind up to 0.18s of stagger delay, plus slack. Get this
// wrong and the run fails on its own stopwatch rather than on the page.
const scrollThrough = (page) => page.evaluate(async () => {
  for (let y = 0; y < document.body.scrollHeight; y += 400) {
    scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 80));
  }
  scrollTo(0, document.body.scrollHeight);
  await new Promise((r) => setTimeout(r, 1200));
});

console.log('\n── reveals fire, at every viewport ──');
// Three viewports because the observer's -12% bottom inset is a percentage of
// the viewport, and the elements nearest the end of the document are the ones
// that can be stranded behind it: if the footer is shorter than that inset,
// whatever sits above it can never scroll high enough to cross. Short and tall
// desktop plus a phone is enough to catch that.
for (const vp of [
  { label: '1280x900', width: 1280, height: 900 },
  { label: '1280x1400', width: 1280, height: 1400 },
  { label: '390x844 phone', width: 390, height: 844, mobile: true },
]) {
  const page = await open(vp);
  const at0 = await state(page);
  at0.length >= 10
    ? ok(`${vp.label}: ${at0.length} reveal targets`)
    : bad(`${vp.label}: only ${at0.length} reveal targets`);

  const below = at0.filter((t) => !t.inView);
  const leaked = below.find((t) => t.op !== 0);
  leaked ? bad(`${vp.label}: below-fold target already visible — ${leaked.id}`)
         : ok(`${vp.label}: ${below.length} below-fold targets start hidden`);

  await scrollThrough(page);
  const missed = (await state(page)).filter((t) => !t.is || t.op !== 1);
  missed.length === 0
    ? ok(`${vp.label}: every target revealed and fully opaque`)
    : bad(`${vp.label}: never revealed — ` + missed.map((t) => `${t.id} (is-in:${t.is}, opacity:${t.op})`).join(', '));

  // The reveal is one-way by design: the observer drops each element once it
  // has crossed in. If anything re-hides on the way up, something is still
  // observing, and the page has grown a second perpetual animation.
  await page.evaluate(async () => { scrollTo(0, 0); await new Promise((r) => setTimeout(r, 700)); });
  (await state(page)).every((t) => t.op === 1)
    ? ok(`${vp.label}: nothing re-hides on the way back up`)
    : bad(`${vp.label}: a target re-hid on scroll up — the observer is still attached`);
  await page.close();
}

console.log('\n── the entrance costs no layout ──');
{
  // The whole reason the reveal is opacity and transform: both composite, so
  // an element occupies its final box from first paint and crossing in cannot
  // move anything around it. A non-zero number here means something in the
  // reveal path started animating a layout property.
  const page = await open();
  await page.evaluate(() => {
    window.__cls = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await scrollThrough(page);
  const cls = await page.evaluate(() => window.__cls);
  cls < 0.01
    ? ok(`CLS across a full scroll: ${cls.toFixed(4)} (budget 0.01, Core Web Vitals "good" is 0.1)`)
    : bad(`CLS ${cls.toFixed(4)} — the reveal is moving layout, not just compositing`);
  await page.close();
}

console.log('\n── one perpetual animation ──');
{
  const page = await open();
  const anims = await page.evaluate(() =>
    document.getAnimations()
      .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity)
      .map((a) => a.animationName || String(a.effect.target.className)));
  anims.length && anims.every((a) => String(a).includes('orbit-turn'))
    ? ok(`${anims.length} running forever, all orbit (the ring and ${anims.length - 1} counter-turning chips)`)
    : bad(`something other than the orbit runs forever: ${[...new Set(anims)].join(', ')}`);
  await page.close();
}

console.log('\n── the escape hatches leave a readable page ──');
{
  // Both of these fail blank, and neither fails on the machine of whoever
  // broke it: reduced motion is an OS setting and no-JS is somebody else's
  // browser. The failure mode is a visitor scrolling past empty sections.
  const page = await open({ reduced: true });
  const t = await state(page);
  const dark = t.filter((x) => x.op !== 1);
  dark.length === 0
    ? ok(`reduced motion: all ${t.length} targets visible without scrolling a pixel`)
    : bad(`reduced motion leaves ${dark.length} target(s) invisible — ${dark[0].id}`);
  const running = await page.evaluate(() =>
    document.getAnimations().filter((a) => a.playState === 'running').length);
  running === 0 ? ok('reduced motion: nothing is animating, including the orbit')
                : bad(`reduced motion: ${running} animation(s) still running`);
  await page.close();
}
{
  const page = await open({ js: false });
  const hidden = await page.evaluate(() =>
    [...document.querySelectorAll('[data-reveal]')].filter((el) => +getComputedStyle(el).opacity === 0).length);
  hidden === 0 ? ok('no JS: every target renders visible (the .js gate holds)')
               : bad(`no JS: ${hidden} target(s) invisible — the hidden state escaped its .js scope`);
  await page.close();
}

console.log('\n── reported, not asserted: cost on a throttled phone ──');
{
  // 4x CPU throttling on a 390x844 phone at DPR 2. Read the trend across runs,
  // not one number: see the header for why none of this is a gate.
  const page = await open({ width: 390, height: 844, mobile: true });
  await page.emulateCPUThrottling(4);
  const m = await page.evaluate(async () => {
    let tbt = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) tbt += Math.max(0, e.duration - 50);
    }).observe({ type: 'longtask' });
    const ts = [];
    let stop = false;
    (function tick(t) { ts.push(t); if (!stop) requestAnimationFrame(tick); })(performance.now());
    const max = document.body.scrollHeight - innerHeight;
    const t0 = performance.now();
    while (performance.now() - t0 < 8000) {       // a reading pace, not a fling
      scrollTo(0, ((performance.now() - t0) / 8000) * max);
      await new Promise((r) => requestAnimationFrame(r));
    }
    stop = true;
    await new Promise((r) => setTimeout(r, 200));
    const g = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
    return {
      p50: +g[Math.floor(g.length * 0.5)].toFixed(1),
      p95: +g[Math.floor(g.length * 0.95)].toFixed(1),
      dropped: +(100 * g.filter((x) => x > 32).length / g.length).toFixed(1),
      tbt: Math.round(tbt),
    };
  });
  console.log(`       frame gap p50 ${m.p50}ms / p95 ${m.p95}ms, ${m.dropped}% over 32ms, `
    + `total blocking time ${m.tbt}ms during an 8s scroll`);
  console.log('       (blocking time is the one to watch: the reveal is meant to cost the');
  console.log('        compositor, not the main thread, so this should stay near the same');
  console.log('        figure as a run with every data-reveal attribute stripped out.)');
  await page.close();
}

await browser.close();
server.close();
console.log(fail ? `\n${fail} FAILURE(S)` : '\nMotion behaves in a real browser.');
process.exit(fail ? 1 : 0);
