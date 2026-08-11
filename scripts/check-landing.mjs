// Static checks for the buildless landing page. There is no bundler to
// catch a bad path or an unclosed tag here, so this stands in for one.
import fs from 'fs';
import path from 'path';

const ROOT = 'public';
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
const foreign = refs.filter((u) => /^https?:\/\//.test(u) && !/^https:\/\/conversekit-widget\.pages\.dev/.test(u));
foreign.length ? bad('external host: ' + foreign.join(', ')) : ok('no external asset hosts');
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
for (const tag of ['div', 'section', 'header', 'footer', 'main', 'nav', 'pre', 'svg', 'button', 'p', 'a', 'span', 'h2', 'h3', 'h4', 'mask']) {
  const o = (markup.match(new RegExp('<' + tag + '(?=[\\s>])', 'g')) || []).length;
  const c = (markup.match(new RegExp('</' + tag + '\\s*>', 'g')) || []).length;
  o === c ? ok(`<${tag}> balanced (${o})`) : bad(`<${tag}> open ${o} / close ${c}`);
}

// ── ids the inline script depends on ──
for (const id of ['copy-hero', 'snippet-hero', 'copy-install', 'snippet-install', 'try-it']) {
  html.includes(`id="${id}"`) ? ok(`#${id} present`) : bad(`#${id} referenced but absent`);
}

// A duplicate mask id silently drops the notch from one of the marks.
const ids = [...markup.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
const dupes = [...new Set(ids.filter((v, i) => ids.indexOf(v) !== i))];
dupes.length ? bad('duplicate ids: ' + dupes.join(', ')) : ok(`all ${ids.length} ids unique`);

// ── social + widget ──
const og = (html.match(/property="og:image" content="([^"]+)"/) || [])[1];
/^https:\/\//.test(og) ? ok('og:image absolute') : bad('og:image not absolute: ' + og);

/<script src="\/widget\.js" data-bot-id="[0-9a-f-]{36}" defer ?>/.test(html)
  ? ok('widget tag present with uuid bot id')
  : bad('widget script tag missing or malformed');

// ── the snippet users copy must be the real deployed URL ──
html.includes('https://conversekit-widget.pages.dev/widget.js')
  ? ok('install snippet points at the deployed widget')
  : bad('install snippet has the wrong widget URL');

console.log(fail ? `\n${fail} FAILURE(S)` : '\nAll landing-page checks passed.');
process.exit(fail ? 1 : 0);
