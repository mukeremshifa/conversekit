// ConverseKit brand asset generator.
//
// Icons are pure geometry, so they stay vector and need no font.
// Anything with type is rendered by resvg using the real font files:
// hand-rolling glyph outlines via opentype.js produced unclosed contours
// that silently cancelled under nonzero fill, dropping random letters.
import fs from 'fs';
import path from 'path';
import { Resvg } from '@resvg/resvg-js';

const OUT = 'assets';
fs.mkdirSync(OUT, { recursive: true });

// ── Palette v2 — crisp neutrals, gold is the only chroma ──
const GOLD = '#EEBA2B';   // brand. Never altered where it is on display.
const INK = '#0A0A0C';    // crisp near-black — no warm tint
const BONE = '#F7F7F8';
const MUTED_D = '#A1A1AC';
const MUTED_L = '#5B5B66';

// fontsource names its static cuts oddly; these are the real family
// strings from the TTF name tables, and resvg matches on them exactly.
const DISPLAY = 'Bricolage Grotesque 96pt ExtraBold';
const UI = 'Instrument Sans Medium';
const FONTS = ['bricolage-700.ttf', 'bricolage-400.ttf', 'instrument-500.ttf'].map((f) => path.resolve(f));

const rasterize = (svgStr, width) =>
  new Resvg(svgStr, {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: UI },
    fitTo: { mode: 'width', value: width },
  }).render().asPng();

// ── The mark ──────────────────────────────────────────────
// Frame = the host page. Gold dot = the widget, pinned bottom-right
// exactly where widget.js puts it. The frame is knocked out around the
// dot so the dot reads as sitting ON a page, not inside a picture.

/** Outline mark, no tile. `col` paints the frame. */
const markOutline = (col, gold = GOLD, uid = 'a') =>
  `<mask id="mk${uid}"><rect width="32" height="32" fill="#fff"/><circle cx="23" cy="23" r="8.25" fill="#000"/></mask>` +
  `<rect x="3.25" y="3.25" width="25.5" height="25.5" rx="7.5" fill="none" stroke="${col}" stroke-width="2.5" mask="url(#mk${uid})"/>` +
  `<circle cx="23" cy="23" r="5.25" fill="${gold}"/>`;

/** Tiled mark for icons. Heavier strokes so it survives 16px. */
const markTile = ({ tile, fg, bleed = false, inset = 5.5, uid = 'b' }) =>
  `<rect width="32" height="32" rx="${bleed ? 0 : 7}" fill="${tile}"/>` +
  `<mask id="tk${uid}"><rect width="32" height="32" fill="#fff"/><circle cx="21.5" cy="21.5" r="7.75" fill="#000"/></mask>` +
  `<rect x="${inset}" y="${inset}" width="${32 - inset * 2}" height="${32 - inset * 2}" rx="6" fill="none" stroke="${fg}" stroke-width="3.25" mask="url(#tk${uid})"/>` +
  `<circle cx="21.5" cy="21.5" r="4.5" fill="${fg}"/>`;

/** Small-size cut. Below ~48px the standard stroke greys out and the dot
 *  disappears, so the frame thickens, the dot grows and the corner radius
 *  tightens — an optical size, not a scaled-down copy. */
const markTileSmall = ({ tile, fg, uid = 's' }) =>
  `<rect width="32" height="32" rx="5" fill="${tile}"/>` +
  `<mask id="sm${uid}"><rect width="32" height="32" fill="#fff"/><circle cx="21.8" cy="21.8" r="8.6" fill="#000"/></mask>` +
  `<rect x="4" y="4" width="24" height="24" rx="6.5" fill="none" stroke="${fg}" stroke-width="4.4" mask="url(#sm${uid})"/>` +
  `<circle cx="21.8" cy="21.8" r="5.4" fill="${fg}"/>`;

const svg = (body, w = 32, h = 32) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`;

/** Wordmark: one family, split by weight. Gold cannot legally tint text
 *  on a light ground, so weight carries the split instead of colour. */
const wordmarkText = (x, y, size, strong, soft) =>
  `<text x="${x}" y="${y}" font-family="${DISPLAY}" font-weight="700" font-size="${size}" ` +
  `letter-spacing="${(-0.028 * size).toFixed(2)}" fill="${strong}">Converse` +
  `<tspan font-weight="400" fill="${soft}">Kit</tspan></text>`;

// ── 1. Vector icons (no type — safe to ship as SVG) ───────
const vectors = {
  'icon.svg': svg(markTileSmall({ tile: INK, fg: GOLD, uid: 'i' })),
  'icon-mark.svg': svg(markOutline('currentColor', GOLD, 'm')),
  'icon-maskable.svg': svg(markTile({ tile: GOLD, fg: INK, bleed: true, inset: 8.5, uid: 'k' })),
};
for (const [n, s] of Object.entries(vectors)) fs.writeFileSync(path.join(OUT, n), s);

// ── 2. Raster icons ───────────────────────────────────────
const inkTile = svg(markTile({ tile: INK, fg: GOLD, uid: 'r' }));
const inkSmall = svg(markTileSmall({ tile: INK, fg: GOLD, uid: 'r' }));
const inkFull = svg(markTile({ tile: INK, fg: GOLD, bleed: true, inset: 7, uid: 'f' }));
const goldMask = svg(markTile({ tile: GOLD, fg: INK, bleed: true, inset: 8.5, uid: 'g' }));

const bufs = {};
for (const [name, s, size] of [
  ['favicon-16.png', inkSmall, 16], ['favicon-32.png', inkSmall, 32],
  ['favicon-48.png', inkTile, 48], ['favicon-96.png', inkTile, 96],
  ['apple-touch-icon.png', inkFull, 180],
  ['icon-192.png', inkTile, 192], ['icon-512.png', inkTile, 512],
  ['icon-maskable-512.png', goldMask, 512],
]) {
  bufs[name] = rasterize(s, size);
  fs.writeFileSync(path.join(OUT, name), bufs[name]);
}

// ── 3. favicon.ico — ICONDIR + entries + PNG payloads ─────
function buildIco(entries) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(entries.length, 4);
  let offset = 6 + entries.length * 16;
  const dir = [], body = [];
  for (const { size, buf } of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(offset, 12);
    offset += buf.length; dir.push(e); body.push(buf);
  }
  return Buffer.concat([head, ...dir, ...body]);
}
fs.writeFileSync(path.join(OUT, 'favicon.ico'), buildIco([
  { size: 16, buf: bufs['favicon-16.png'] },
  { size: 32, buf: bufs['favicon-32.png'] },
  { size: 48, buf: bufs['favicon-48.png'] },
]));

// ── 4. Lockups ────────────────────────────────────────────
// Shipped as PNG: an SVG carrying <text> depends on the font being
// installed wherever it is opened. In-app the lockup is icon-mark.svg
// plus live text, which is the right approach there anyway.
function lockup(bg, frame, strong, soft) {
  const S = 40, gap = 15, W = 340, H = 60, y = (H + S * 0.5) / 2 - 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    (bg ? `<rect width="${W}" height="${H}" fill="${bg}"/>` : '') +
    `<g transform="translate(10,${(H - S) / 2}) scale(${S / 32})">${markOutline(frame, GOLD, bg ? 'ld' : 'll')}</g>` +
    wordmarkText(10 + S + gap, y, 30, strong, soft) + `</svg>`;
}
fs.writeFileSync(path.join(OUT, 'logo.png'), rasterize(lockup(null, INK, INK, MUTED_L), 680));
fs.writeFileSync(path.join(OUT, 'logo-dark.png'), rasterize(lockup(INK, BONE, BONE, MUTED_D), 680));

// ── 5. OG image ───────────────────────────────────────────
// Dark ground: link previews land in both light and dark feeds, and the
// gold only sings on dark. The disc bleeding off the bottom-right is the
// mark's idea at full scale — the widget arriving on someone's page.
const M = 84, markS = 60;
const og = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
<rect width="1200" height="630" fill="${INK}"/>
<circle cx="1168" cy="612" r="176" fill="${GOLD}"/>
<circle cx="1168" cy="612" r="272" fill="none" stroke="${GOLD}" stroke-width="2" opacity=".20"/>
<circle cx="1168" cy="612" r="364" fill="none" stroke="${GOLD}" stroke-width="2" opacity=".10"/>
<g transform="translate(${M},${M - 6}) scale(${markS / 32})">${markOutline(BONE, GOLD, 'og')}</g>
${wordmarkText(M + markS + 22, M + markS * 0.72 + 2, 30, BONE, MUTED_D)}
<rect x="${M}" y="${M + markS + 44}" width="52" height="3" rx="1.5" fill="${GOLD}"/>
<text x="${M}" y="340" font-family="${DISPLAY}" font-weight="700" font-size="78" letter-spacing="-2.73" fill="${BONE}">Drop-in AI chat</text>
<text x="${M}" y="428" font-family="${DISPLAY}" font-weight="700" font-size="78" letter-spacing="-2.73" fill="${BONE}">for any website.</text>
<text x="${M}" y="512" font-family="${UI}" font-weight="500" font-size="25" letter-spacing="-0.15" fill="${MUTED_D}">Answers from your own docs. Captures leads. One script tag.</text>
</svg>`;
fs.writeFileSync(path.join(OUT, 'og.png'), rasterize(og, 1200));

// ── 6. Manifest ───────────────────────────────────────────
fs.writeFileSync(path.join(OUT, 'site.webmanifest'), JSON.stringify({
  name: 'ConverseKit', short_name: 'ConverseKit',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  theme_color: INK, background_color: INK, display: 'standalone',
}, null, 2) + '\n');

const rows = fs.readdirSync(OUT).sort()
  .map((f) => `  ${f.padEnd(24)} ${String(fs.statSync(path.join(OUT, f)).size).padStart(7)} B`);
console.log(`Generated ${rows.length} files:\n${rows.join('\n')}`);
