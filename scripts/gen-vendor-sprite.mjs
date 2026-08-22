// ----------------------------------------------------------------
// Landing-page icon sprite.
//
// The landing page has no build step, so nothing can resolve a bare npm
// import for it the way the dashboard does. This reads the two icon
// packages out of node_modules and writes an inline <symbol> block into
// public/index.html between generated markers.
//
// Inline rather than an external sprite file on purpose: currentColor
// does not reliably cross an external <use> boundary, and half the
// vendor marks below are the mono cut precisely because they depend on
// currentColor to stay visible on both grounds. An external sprite would
// render them black-on-black in dark mode.
//
// Idempotent: run it twice and the file is byte-identical. That is the
// property that makes it safe to run in a pre-commit hook or in CI, and
// check-landing.mjs verifies the markers survive and that every
// <use href="#..."> in the page resolves to a symbol in here.
//
//   node scripts/gen-vendor-sprite.mjs          # rewrite the block
//   node scripts/gen-vendor-sprite.mjs --check  # fail if it is stale
// ----------------------------------------------------------------
import fs from 'fs';
import path from 'path';

const PAGE = 'public/index.html';
const OPEN = '<!-- generated:sprite -->';
const CLOSE = '<!-- /generated:sprite -->';

const LOBE = 'node_modules/@lobehub/icons-static-svg/icons';
const LUCIDE = 'node_modules/lucide-static/icons';

// ── The manifest is the source of truth ──────────────────────────
// Adding an icon to the page means adding it here and re-running, not
// pasting a path into the markup. Anything not listed is not in the
// sprite, and a <use> pointing at it fails the checker.
//
// Which cut per vendor is a contrast decision, not a taste one: colour
// where the mark carries colour that survives on both a light and a dark
// ground, mono + currentColor where the mark is essentially black.
// A black logo on the dark palette is invisible, and the mono cut is
// what that case exists for.
const VENDORS = [
  { id: 'v-openai', file: 'openai.svg', title: 'OpenAI' }, //            mono: black mark
  { id: 'v-anthropic', file: 'claude-color.svg', title: 'Anthropic Claude' },
  { id: 'v-google', file: 'gemini-color.svg', title: 'Google Gemini' },
  { id: 'v-groq', file: 'groq.svg', title: 'Groq' }, //                  mono: black mark
  { id: 'v-openrouter', file: 'openrouter-color.svg', title: 'OpenRouter' },
  { id: 'v-mistral', file: 'mistral-color.svg', title: 'Mistral' },
  { id: 'v-deepseek', file: 'deepseek-color.svg', title: 'DeepSeek' },
  { id: 'v-together', file: 'together-color.svg', title: 'Together AI' },
  { id: 'v-workers-ai', file: 'cloudflare-color.svg', title: 'Cloudflare Workers AI' },
  { id: 'v-ollama', file: 'ollama.svg', title: 'Ollama' }, //            mono: black mark
  { id: 'v-lmstudio', file: 'lmstudio.svg', title: 'LM Studio' }, //     mono: black mark
];

// ── Social marks ─────────────────────────────────────────────────
// The four outbound links in the footer. Solid silhouettes on purpose:
// GitHub only ships as a fill, and a stroked envelope next to three
// filled marks reads as a different icon set at 15px.
//
// GitHub comes out of the lobe package. X and LinkedIn are in neither
// dependency, and the envelope has no brand owner at all, so those three
// carry their path data here rather than pulling in a third icon package
// for one glyph each. X and LinkedIn are simple-icons (CC0); the
// envelope is drawn to their 24-grid.
const SOCIAL_PKG = [{ id: 's-github', file: 'github.svg', title: 'GitHub' }];

const SOCIAL_INLINE = [
  {
    id: 's-x',
    title: 'X',
    d: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z',
  },
  {
    id: 's-linkedin',
    title: 'LinkedIn',
    d: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 110-4.125 2.062 2.062 0 010 4.125zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z',
  },
  {
    id: 's-email',
    title: 'Email',
    d: 'M2.25 6.75A2.25 2.25 0 014.5 4.5h15a2.25 2.25 0 012.25 2.25v.4l-9.38 5.21a.75.75 0 01-.74 0L2.25 7.15v-.4zm0 2.12v8.38A2.25 2.25 0 004.5 19.5h15a2.25 2.25 0 002.25-2.25V8.87l-8.65 4.81a2.25 2.25 0 01-2.2 0L2.25 8.87z',
  },
];

// The same glyph set the dashboard draws through lucide-react, so the
// landing page and the app share an icon language for free. Grouped by
// what asks for them; add here rather than hand-inlining a path.
const GLYPHS = [
  'arrow-right', //                              the "read more" links
  'sliders-horizontal', //                       retrieval
  'key-round', 'zap', //                        the two provider claims
];

// The same idea again, cut duotone: closed shapes filled with a
// translucent currentColor so the silhouette reads as a tint under the
// line. Lucide ships no duotone set, so duotone() below makes one.
// Only the three closing pillars use it — the one place on the page
// where an icon is a picture rather than a label.
const DUOTONE = ['shield-check', 'settings-2', 'zap'];

// ── SVG surgery ──────────────────────────────────────────────────

/** Splits `<svg ...>inner</svg>` into its root attributes and its body. */
function openSvg(src, from) {
  const m = /<svg\b([\s\S]*?)>([\s\S]*)<\/svg>/.exec(src);
  if (!m) throw new Error(`${from}: no <svg> root found`);
  const attrs = {};
  for (const a of m[1].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
  return { attrs, inner: m[2] };
}

/**
 * Rewrites every id defined inside one icon to a symbol-scoped one, and
 * follows the url(#x) / href="#x" references that point at them.
 *
 * Only Gemini currently ships internal ids (three gradients), and they
 * happen to be namespaced already — but a package bump adding a gradient
 * named "a" to two marks would otherwise collide silently, with one
 * icon quietly painting itself in the other's colours.
 */
function scopeIds(inner, symbolId) {
  const ids = [...inner.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  for (const id of new Set(ids)) {
    const scoped = `${symbolId}-${id}`;
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    inner = inner
      .replace(new RegExp(`id="${esc}"`, 'g'), `id="${scoped}"`)
      .replace(new RegExp(`url\\(#${esc}\\)`, 'g'), `url(#${scoped})`)
      .replace(new RegExp(`href="#${esc}"`, 'g'), `href="#${scoped}"`);
  }
  return inner;
}

/**
 * Fills every closed shape in a glyph with a translucent currentColor:
 * a <path> whose data ends in a z, plus the primitive shapes, which are
 * closed by definition. Open paths — a check mark, a slider rail — stay
 * strokes, and that split is the whole of the duotone effect. Anything
 * the source already fills (lucide's solid dots) is left alone.
 */
function duotone(inner) {
  const tint = ' fill="currentColor" fill-opacity=".16"';
  return inner
    .replace(/<path\b([^>]*?)\bd="([^"]*[zZ])"([^>]*?)\s*\/>/g, (m, a, d, b) =>
      /fill=/.test(m) ? m : `<path${a}d="${d}"${b}${tint} />`)
    .replace(/<(circle|rect|ellipse|polygon)\b([^>]*?)\s*\/>/g, (m, tag, a) =>
      /fill=/.test(m) ? m : `<${tag}${a}${tint} />`);
}

/**
 * One <symbol>, with the root's presentation attributes moved onto a
 * wrapping <g>.
 *
 * They cannot simply be dropped: the lucide glyphs are strokes with no
 * fill and the mono vendor marks are fills with no stroke, and each
 * relies on attributes that live on the <svg> root in the source file.
 * A <g> rather than the <symbol> itself because a symbol's presentation
 * attributes are the easiest thing for a later CSS rule to outrank by
 * accident.
 */
function symbolFrom(src, { id, title, duo }, from) {
  const { attrs, inner } = openSvg(src, from);
  const carry = ['fill', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin'];
  const g = carry.filter((k) => attrs[k] !== undefined).map((k) => `${k}="${attrs[k]}"`).join(' ');

  // The source <title> is the icon's own; ours names the symbol for a
  // <use> that is not aria-hidden, so it replaces rather than joins it.
  let body = scopeIds(inner.replace(/<title>[\s\S]*?<\/title>/g, ''), id).trim();
  if (duo) body = duotone(body);

  return [
    `      <symbol id="${id}" viewBox="${attrs.viewBox || '0 0 24 24'}">`,
    `        <title>${title}</title>`,
    `        <g${g ? ' ' + g : ''}>${body}</g>`,
    '      </symbol>',
  ].join('\n');
}

// ── Build ────────────────────────────────────────────────────────
function read(dir, file, label) {
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) {
    console.error(`\n  ${label} "${file}" is not in ${dir}.`);
    console.error('  Run `npm install` first, or the package renamed it after a bump.\n');
    process.exit(1);
  }
  return fs.readFileSync(p, 'utf8');
}

function glyph(name, id, duo) {
  const title = name.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
  return symbolFrom(read(LUCIDE, `${name}.svg`, 'lucide glyph'), { id, title, duo }, `${name}.svg`);
}

/** A one-path solid mark whose data lives in the manifest above. */
function inlineMark({ id, title, d }) {
  return [
    `      <symbol id="${id}" viewBox="0 0 24 24">`,
    `        <title>${title}</title>`,
    '        <g fill="currentColor" fill-rule="evenodd">' + `<path d="${d}"></path></g>`,
    '      </symbol>',
  ].join('\n');
}

const symbols = [
  ...VENDORS.map((v) => symbolFrom(read(LOBE, v.file, 'vendor mark'), v, v.file)),
  ...GLYPHS.map((name) => glyph(name, `i-${name}`)),
  ...DUOTONE.map((name) => glyph(name, `i-${name}-duo`, true)),
  ...SOCIAL_PKG.map((v) => symbolFrom(read(LOBE, v.file, 'social mark'), v, v.file)),
  ...SOCIAL_INLINE.map(inlineMark),
];

const block = [
  OPEN,
  '    <!-- Written by scripts/gen-vendor-sprite.mjs. Do not hand-edit:',
  '         the next run overwrites it. Add icons to the manifest in that',
  '         script instead, then re-run `npm run gen:sprite`. -->',
  '    <svg',
  '      xmlns="http://www.w3.org/2000/svg"',
  '      style="position: absolute; width: 0; height: 0; overflow: hidden"',
  '      aria-hidden="true"',
  '      focusable="false"',
  '    >',
  ...symbols,
  '    </svg>',
  `    ${CLOSE}`,
].join('\n');

const html = fs.readFileSync(PAGE, 'utf8');
const start = html.indexOf(OPEN);
const end = html.indexOf(CLOSE);
if (start === -1 || end === -1 || end < start) {
  console.error(`\n  ${PAGE} has no ${OPEN} ... ${CLOSE} pair.`);
  console.error('  Add the markers where the sprite should live (just inside <body>).\n');
  process.exit(1);
}
const next = html.slice(0, start) + block + html.slice(end + CLOSE.length);

// A <use> pointing at a symbol nobody defined is a checker failure; a
// symbol nobody uses is only dead weight, so it is reported rather than
// enforced. Phases D and G fill these in; phase H prunes what is left.
const used = new Set([...next.matchAll(/<use\s+href="#([^"]+)"/g)].map((m) => m[1]));
const unused = symbols
  .map((s) => /id="([^"]+)"/.exec(s)[1])
  .filter((id) => !used.has(id));

if (process.argv.includes('--check')) {
  if (next !== html) {
    console.error('\n  The sprite in public/index.html is stale.');
    console.error('  Run `npm run gen:sprite` and commit the result.\n');
    process.exit(1);
  }
  console.log(`sprite up to date — ${symbols.length} symbols`);
} else {
  fs.writeFileSync(PAGE, next);
  const bytes = Buffer.byteLength(block, 'utf8');
  console.log(
    `${symbols.length} symbols (${VENDORS.length} vendor marks,` +
      ` ${GLYPHS.length} lucide glyphs, ${DUOTONE.length} duotone,` +
      ` ${SOCIAL_PKG.length + SOCIAL_INLINE.length} social)` +
      ` — ${(bytes / 1024).toFixed(1)} KB inline`,
  );
  if (unused.length) console.log(`not referenced yet: ${unused.join(', ')}`);
}
