// Static checks for the buildless landing page. There is no bundler to
// catch a bad path or an unclosed tag here, so this stands in for one.
import fs from 'fs';
import path from 'path';
import { ORIGINS, installSrc } from '../config/origins.js';

// The BUILT page, not the source. The source carries `__CK_CDN__`-style
// tokens where hostnames go, so half these assertions — every URL one —
// can only be made against the output of scripts/build-assets.mjs.
const ROOT = 'apps/site/dist';
if (!fs.existsSync(path.join(ROOT, 'index.html'))) {
  console.error(`No landing page at ${ROOT}/index.html — run \`npm run build:assets -- site\` first.`);
  process.exit(1);
}
const raw = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
// A formatter may split attributes across lines; collapse whitespace inside
// tags so the checks match structure rather than formatting.
const html = raw.replace(/<([a-zA-Z][^>]*?)>/gs, (m) => m.replace(/\s+/g, ' '));

// Tag counting must ignore <script>/<style> bodies: a "<pre>" inside a
// JS comment is prose, not markup.
const markup = html
  .replace(/<script[\s\S]*?<\/script>/gi, '<script></script>')
  .replace(/<style[\s\S]*?<\/style>/gi, '<style></style>')
  .replace(/<!--[\s\S]*?-->/g, '');

let fail = 0;
const bad = (m) => { console.log('  FAIL ' + m); fail++; };
const ok = (m) => console.log('  ok   ' + m);

// ── local assets resolve on disk ──
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
for (const r of new Set(refs.filter((r) => r.startsWith('/')))) {
  const p = path.join(ROOT, r.replace(/^\//, ''));
  const target = r.endsWith('/') ? path.join(p, 'index.html') : p;
  fs.existsSync(target) ? ok(`resolves  ${r}`) : bad(`missing   ${r}`);
}

// ── nothing loads from another host ──
// Only things the browser fetches count: src= anywhere, plus href= on
// <link>. An <a href> to another site is an outbound link, not a load,
// and the footer has four of them.
const assets = [
  ...[...html.matchAll(/\ssrc="([^"]+)"/g)].map((m) => m[1]),
  ...[...html.matchAll(/<link[^>]*\shref="([^"]+)"/g)].map((m) => m[1]),
];
// Our own hosts only. The widget now comes off cdn. rather than from
// this origin — that is deliberate, so the page exercises the same
// install path a tenant does — but anything beyond these two is a third
// party the page has quietly taken a dependency on.
const OURS = [ORIGINS.site, ORIGINS.cdn];
const foreign = assets.filter((u) => /^https?:\/\//.test(u) && !OURS.some((o) => u.startsWith(o + '/')));
foreign.length ? bad('external host: ' + foreign.join(', ')) : ok('no external asset hosts');

// A token that survived the build is a hostname that never got filled
// in: the page renders, the link is dead, and nothing else notices.
const leftover = [...new Set([...raw.matchAll(/__CK_[A-Z_]+__/g)].map((m) => m[0]))];
leftover.length ? bad('unsubstituted token: ' + leftover.join(', ')) : ok('every __CK_*__ token substituted');
/@import\s+url\(|fonts\.googleapis|unpkg|jsdelivr/.test(html) ? bad('CDN import found') : ok('no CDN imports');

// ── markup ──
const h1 = (markup.match(/<h1[\s>]/g) || []).length;
h1 === 1 ? ok('exactly one <h1>') : bad(`expected 1 <h1>, found ${h1}`);

const imgs = [...markup.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
const noAlt = imgs.filter((t) => !/\salt=/.test(t));
noAlt.length ? bad(`${noAlt.length} <img> without alt`) : ok(`all <img> have alt (${imgs.length})`);

// Prettier's whitespace-sensitive reflow emits `</span\n>` and `<b>x</b\n>`,
// which is valid HTML, so both open and close patterns must tolerate
// newlines before the closing bracket.
for (const tag of ['div', 'section', 'header', 'footer', 'main', 'nav', 'pre', 'svg', 'button', 'p', 'a', 'span', 'h2', 'h3', 'h4', 'h5', 'mask', 'symbol']) {
  const o = (markup.match(new RegExp('<' + tag + '(?=[\\s>])', 'g')) || []).length;
  const c = (markup.match(new RegExp('</' + tag + '\\s*>', 'g')) || []).length;
  o === c ? ok(`<${tag}> balanced (${o})`) : bad(`<${tag}> open ${o} / close ${c}`);
}

// ── ids the inline script depends on ──
// The snippet used to appear three times — hero, bento, install. It
// survives once, as the bento's fourth tile: the hero quotes the tag in
// its eyebrow and the install section closes on the CTAs instead.
for (const id of ['copy-bento', 'snippet-bento', 'try-it']) {
  html.includes(`id="${id}"`) ? ok(`#${id} present`) : bad(`#${id} referenced but absent`);
}

// A duplicate mask id silently drops the notch from one of the marks.
const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const dupes = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
dupes.length ? bad('duplicate ids: ' + dupes.join(', ')) : ok(`all ${ids.length} ids unique`);

// ── theme ──
// The page follows the OS; there is no toggle on it. The pre-paint
// script stays because /admin/ still writes ck_theme and a visitor who
// chose dark there must not get a white flash coming back here. Lose
// one of the two dark blocks and either the OS or that replayed choice
// stops working, but not both, so it looks fine until someone tries the
// other one.
/<script>[\s\S]{0,400}?localStorage\.getItem\(\s*["']ck_theme["']\s*\)[\s\S]{0,400}?<\/script>/.test(raw)
  ? ok('pre-paint theme script reads ck_theme')
  : bad('pre-paint theme script missing (dark users will flash white)');

raw.indexOf('<style') > raw.indexOf('ck_theme')
  ? ok('pre-paint script runs before the stylesheet')
  : bad('pre-paint script must come before <style> or it cannot beat first paint');

for (const [label, re] of [
  ['light palette on bare :root', /:root\s*\{[^}]*--bg:\s*#fcfcfd/i],
  ['dark palette under prefers-color-scheme', /@media \(prefers-color-scheme: dark\)\s*\{\s*:root:not\(\[data-theme="light"\]\)/],
  ['dark palette under [data-theme="dark"]', /:root\[data-theme="dark"\]\s*\{/],
]) {
  re.test(raw) ? ok(label) : bad(label + ' missing');
}

!/data-theme-set=|role="radiogroup"/.test(html)
  ? ok('no theme toggle: the page follows the OS')
  : bad('theme toggle markup is back — the page is meant to follow the OS');

const themeColors = [...html.matchAll(/<meta name="theme-color"[^>]*>/g)].map((m) => m[0]);
themeColors.length === 2 && themeColors.every((t) => /data-scheme="(light|dark)"/.test(t) && /media=/.test(t))
  ? ok('two theme-color tags, one per scheme')
  : bad(`expected 2 theme-color tags with media + data-scheme, found ${themeColors.length}`);
/<meta name="color-scheme" content="light dark"/.test(html)
  ? ok('color-scheme is "light dark"')
  : bad('color-scheme must be "light dark" now that the page is theme-aware');

// ── icon sprite ──
// scripts/gen-vendor-sprite.mjs owns the block between these markers. The
// interesting failure is not a missing sprite, which is obvious on sight,
// but a <use> pointing at a symbol that was renamed or pruned out of the
// manifest: SVG renders nothing at all for that, silently, leaving a hole
// where a logo was.
const sprite = /<!-- generated:sprite -->([\s\S]*?)<!-- \/generated:sprite -->/.exec(raw);
if (!sprite) {
  bad('sprite markers missing — run `npm run gen:sprite`');
} else {
  const symbols = new Set([...sprite[1].matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));
  symbols.size ? ok(`sprite holds ${symbols.size} symbols`) : bad('sprite block is empty');

  const uses = [...html.matchAll(/<use href="#([^"]+)"/g)].map((m) => m[1]);
  const dangling = [...new Set(uses.filter((u) => !symbols.has(u)))];
  dangling.length
    ? bad('<use> with no symbol: ' + dangling.join(', '))
    : ok(`all ${uses.length} <use> references resolve`);
}

// ── hero orbit ──
// The signature device, and the "eleven vendors, one interface" claim
// told as a picture. It is easy to half-break: drop the counter-rotating
// chip and every logo tumbles, drop the is-outer class and a phone gets
// eleven chips instead of five.
const orbit = /<div class="orbit"[\s\S]*?<\/div>\s*<\/div>/.exec(html);
if (!orbit) {
  bad('hero orbit missing');
} else {
  const chips = [...orbit[0].matchAll(/<use href="#(v-[^"]+)"/g)].map((m) => m[1]);
  chips.length === 11
    ? ok('orbit carries all 11 vendor marks')
    : bad(`orbit carries ${chips.length} vendor marks, expected 11`);
  const outer = (orbit[0].match(/orbit-slot is-outer/g) || []).length;
  outer === 6
    ? ok('orbit drops 6 chips to two rings under 720px')
    : bad(`expected 6 is-outer slots for the mobile fallback, found ${outer}`);
  (orbit[0].match(/orbit-chip/g) || []).length === chips.length
    ? ok('every orbit logo sits on a counter-rotating chip')
    : bad('an orbit logo is missing its chip and will tumble as the ring turns');
}

// ── motion ──
// The page's motion budget, written down as a test because it is the kind
// of rule that erodes one plausible addition at a time. Three clauses:
// one thing loops, everything else is a one-off entrance, and all of it
// is opacity and transform so it composites instead of relayouting.

// 1. One perpetual animation, and it is the orbit. `infinite` is the tell:
// the ring turns and every chip counter-turns, so two is the whole budget.
// A third is a second thing moving forever, whatever it is called.
const loops = [...raw.matchAll(/animation:[^;]*\binfinite\b[^;]*;/g)].map((m) => m[0]);
loops.length === 2 && loops.every((d) => /orbit-turn/.test(d))
  ? ok('one perpetual animation (the orbit, ring + counter-turning chips)')
  : bad(`${loops.length} infinite animations, expected 2 orbit ones: ${loops.join(' | ')}`);

// 2. Every keyframe animates opacity/transform only. Anything else —
// height, top, margin, filter, box-shadow — drops the animation off the
// compositor and onto the main thread, where it costs layout or paint on
// every frame and shows up as jank on a cheap phone. Brace-matched rather
// than regexed out, because a keyframes body has nested blocks.
const MOTION_OK = new Set(['opacity', 'transform', 'animation-timing-function', 'will-change']);
for (const m of raw.matchAll(/@keyframes\s+([\w-]+)\s*\{/g)) {
  let depth = 0, i = m.index + m[0].length - 1;
  for (; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}' && --depth === 0) break;
  }
  const body = raw.slice(m.index + m[0].length, i);
  const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]);
  const offenders = [...new Set(props.filter((p) => !MOTION_OK.has(p)))];
  offenders.length
    ? bad(`@keyframes ${m[1]} animates ${offenders.join(', ')} — compositor-safe properties only`)
    : ok(`@keyframes ${m[1]}: opacity/transform only`);
}

// 3. The reveal transition, same rule. It is declared once, on
// `.js [data-reveal]`, and it is the only transition on the page that runs
// against scroll position rather than a pointer.
const revealRule = /\.js \[data-reveal\] \{([^}]*)\}/.exec(raw);
if (!revealRule) {
  bad('.js [data-reveal] resting state missing — scroll reveals are not wired');
} else {
  const timed = [...revealRule[1].matchAll(/(?::|,)\s*([a-z-]+)\s+[\d.]+m?s/g)].map((m) => m[1]);
  timed.length && timed.every((p) => p === 'opacity' || p === 'transform')
    ? ok(`reveal transitions ${timed.join(' + ')} only`)
    : bad(`reveal transitions ${timed.join(', ') || 'nothing'} — opacity/transform only`);
  /opacity:\s*0/.test(revealRule[1]) && /\.js \[data-reveal\]\.is-in/.test(raw)
    ? ok('reveal has a hidden resting state and an .is-in end state')
    : bad('reveal needs opacity:0 at rest and an .is-in rule to arrive at');
}

// The two escape hatches, both of which fail silently and invisibly to
// whoever broke them — you only find out from a visitor who sees a page
// of blank sections.
//
// No JS: the hidden state is scoped to `.js`, and the class is set by a
// script that runs before the stylesheet paints. Lose the gate and a
// no-JS visitor gets nothing below the hero; lose the pre-paint position
// and everyone watches the content get hidden after it has appeared.
const jsGate = /\.js \[data-reveal\]/.test(raw);
const jsMark = /<script>\s*document\.documentElement\.classList\.add\("js"\);?\s*<\/script>/.test(raw);
jsGate && jsMark
  ? ok('reveal gated on .js, set pre-paint (no-JS renders fully visible)')
  : bad(jsGate ? 'nothing adds the .js class — every reveal target stays invisible'
               : 'reveal styles are not scoped to .js — a no-JS visitor gets blank sections');
jsMark && raw.indexOf('classList.add("js")') < raw.indexOf('<style')
  ? ok('.js class is set before the stylesheet')
  : bad('the .js script must come before <style>, or content flashes then hides');

// Reduced motion: the global block nulls animation and transition, which
// stops the movement but leaves opacity:0 exactly where it was. The
// reveal therefore needs its own override inside that block.
const rm = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n      \}/.exec(raw);
rm && /\[data-reveal\][^}]*opacity:\s*1\s*!important/.test(rm[1])
  ? ok('reduced motion un-hides reveals (not just stops them)')
  : bad('prefers-reduced-motion must reset [data-reveal] to opacity:1, or the page stays blank');

// The observer drops each element after its one entrance. Without that,
// every target keeps a live callback for the session and the reveal can
// re-run on the way back down — ambient motion by accident.
/io\.unobserve\(/.test(raw)
  ? ok('reveal observer unobserves after the entrance (one-way, once)')
  : bad('the reveal observer must unobserve, or elements animate more than once');
/IntersectionObserver" in window/.test(raw)
  ? ok('reveal has a no-IntersectionObserver fallback')
  : bad('no IntersectionObserver feature check — old browsers would stay blank');

// The targets themselves. Every value must have a delay rule behind it,
// or a stagger step silently becomes a plain reveal.
const revealAttrs = [...markup.matchAll(/data-reveal(?:="([^"]*)")?/g)].map((m) => m[1] ?? '');
revealAttrs.length >= 10
  ? ok(`${revealAttrs.length} reveal targets`)
  : bad(`only ${revealAttrs.length} reveal targets — the section entrances are being stripped`);
const orphan = [...new Set(revealAttrs.filter((v) => v !== '' && !raw.includes(`.js [data-reveal="${v}"]`)))];
orphan.length
  ? bad('data-reveal value with no delay rule: ' + orphan.join(', '))
  : ok('every stagger step has a transition-delay rule');

// The shotband is the LCP candidate. An element at opacity 0 is not an
// LCP candidate at all, so revealing it would push the metric out by
// however long the entrance takes, for an effect at the top of the page
// that nobody had to scroll to reach.
const band = /<section class="shotband">([\s\S]*?)<\/section>/.exec(html);
band && !band[1].includes('data-reveal')
  ? ok('shotband is not revealed (it holds the LCP image)')
  : bad('the shotband screenshot must not carry data-reveal — it is the LCP element');

// ── product shots ──
// Seven slots, each shipping a <picture> per theme, all of it written by
// scripts/gen-shots.mjs out of apps/site/assets/shots/manifest.json. Two failures
// are invisible on the page you happen to be looking at: a slot that
// ships only one theme is a hole for everyone using the other one, and a
// content hash that no longer exists on disk is a hole for everyone,
// after the next re-shoot rewrote it. Neither shows up in the theme you
// developed in.
const shots = [
  ...raw.matchAll(/<!-- generated:shot ([a-z]+) -->([^]*?)<!-- \/generated:shot \1 -->/g),
];
shots.length
  ? ok(`${shots.length} generated shot blocks`)
  : bad('no generated:shot blocks — run `npm run gen:shots`');

for (const [, slot, body] of shots) {
  const flat = body.replace(/\s+/g, ' ');
  const light = (flat.match(/class="shot-l"/g) || []).length;
  const dark = (flat.match(/class="shot-d"/g) || []).length;
  light === 1 && dark === 1
    ? ok(`shot ${slot}: light and dark`)
    : bad(`shot ${slot}: ${light} light / ${dark} dark <picture>, expected 1 of each`);

  // A <picture> whose <img> has no intrinsic size reserves no box, and
  // the whole section below it jumps when the image lands.
  const sized = [...flat.matchAll(/<img [^>]*>/g)].every((m) => /width="\d+"/.test(m[0]) && /height="\d+"/.test(m[0]));
  sized ? ok(`shot ${slot}: both <img> sized (no shift)`) : bad(`shot ${slot}: an <img> is missing width/height`);

  const files = [...flat.matchAll(/srcset="([^"]+)"/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim().split(/\s+/)[0]));
  const gone = files.filter((f) => !fs.existsSync(path.join(ROOT, f.replace(/^\//, ''))));
  gone.length
    ? bad(`shot ${slot}: ${gone.length} srcset file(s) not on disk: ${gone[0]} …`)
    : ok(`shot ${slot}: all ${files.length} srcset files resolve`);
}

// The swap itself, which has exactly the shape the palette does and
// breaks the same way: lose one block and either the OS or the toggle
// stops swapping, but not both, so it looks fine until someone tries
// the other one.
for (const [label, re] of [
  ['dark shots hidden by default', /\.shot-d \{\s*display: none;/],
  ['shot swap under prefers-color-scheme', /:root:not\(\[data-theme="light"\]\) \.shot-d \{\s*display: block;/],
  ['shot swap under [data-theme="dark"]', /:root\[data-theme="dark"\] \.shot-d \{\s*display: block;/],
]) {
  re.test(raw) ? ok(label) : bad(label + ' missing');
}

// ── workflow tabs ──
// A row of buttons that looks like tabs and is not wired like them is
// worse than the headings it replaced: a screen reader announces three
// buttons and no relationship, and the panels are unreachable.
const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
if (!tabs.length) {
  bad('no [role="tab"] found — the How-it-works tabs are missing');
} else {
  const panels = [...html.matchAll(/<div[^>]*role="tabpanel"[^>]*>/g)].map((m) => m[0]);
  tabs.length === panels.length
    ? ok(`${tabs.length} tabs, ${panels.length} panels`)
    : bad(`${tabs.length} tabs but ${panels.length} panels`);

  const controls = tabs.map((t) => (t.match(/aria-controls="([^"]+)"/) || [])[1]);
  const unlinked = controls.filter((id) => !id || !panels.some((p) => p.includes(`id="${id}"`)));
  unlinked.length
    ? bad('tab(s) with no panel: ' + unlinked.join(', '))
    : ok('every tab points at a panel');

  const selected = tabs.filter((t) => /aria-selected="true"/.test(t)).length;
  selected === 1 ? ok('exactly one tab starts selected') : bad(`${selected} tabs start selected, expected 1`);

  const open = panels.filter((p) => !/\shidden(\s|>)/.test(p)).length;
  open === 1 ? ok('exactly one panel starts open') : bad(`${open} panels start open, expected 1`);

  /role="tablist"/.test(html) ? ok('tabs sit in a tablist') : bad('the tabs need role="tablist"');
}

// ── typography ──
// Bricolage on this page is a ten-glyph subset covering "ConverseKit" and
// nothing else, so any other rule asking for it renders in the fallback
// face and nobody notices until a screenshot looks wrong. Two declarations
// are legitimate: the @font-face itself, and the wordmark.
const bricolage = [...raw.matchAll(/font-family:\s*"Bricolage"[^;]*;/g)].map((m) => m[0]);
bricolage.length === 2
  ? ok('Bricolage declared twice (@font-face + wordmark)')
  : bad(`Bricolage declared ${bricolage.length}x; expected 2 — the subset covers only "ConverseKit"`);
/\.brand \.wm \{[^}]*font-family:\s*"Bricolage"/.test(raw)
  ? ok('Bricolage confined to .brand .wm')
  : bad('the one Bricolage rule must be .brand .wm');
raw.includes('/fonts/bricolage-wordmark.woff2') && !raw.includes('bricolage-grotesque-latin')
  ? ok('wordmark loads the subset, not the full family')
  : bad('landing must load bricolage-wordmark.woff2, not the 41 KB latin subset');

// ── social + widget ──
const og = (html.match(/property="og:image" content="([^"]+)"/) || [])[1];
/^https:\/\//.test(og) ? ok('og:image absolute') : bad('og:image not absolute: ' + og);

// The live widget on this page loads from ck-cdn, on the same
// major-pinned path a tenant is given — so the page exercises the real
// install rather than a same-origin shortcut that could keep working
// after the CDN broke.
const WIDGET_SRC = installSrc();
new RegExp(`<script src="${WIDGET_SRC}" data-bot-id="[0-9a-f-]{36}" defer ?>`).test(html)
  ? ok('widget tag present, off the CDN, with a uuid bot id')
  : bad('widget script tag missing or malformed');

// ── the snippet users copy must be the real deployed URL ──
// Major-pinned, never floating: this string ends up in other people's
// HTML, and /widget.js would opt every one of them into breaking
// changes they never asked for.
html.includes(WIDGET_SRC)
  ? ok('install snippet points at the pinned widget path')
  : bad('install snippet has the wrong widget URL');
/[">]https:\/\/[^"<]*\/widget\.js/.test(html.split(WIDGET_SRC).join(''))
  ? bad('an unpinned /widget.js URL is on the page')
  : ok('no unpinned widget URL on the page');

console.log(fail ? `\n${fail} FAILURE(S)` : '\nAll landing-page checks passed.');
process.exit(fail ? 1 : 0);
