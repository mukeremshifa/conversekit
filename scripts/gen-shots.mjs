// ----------------------------------------------------------------
// Landing-page product shots.
//
// scripts/shoot.mjs writes apps/site/assets/shots/manifest.json: every slot, its
// capture size, its alt text, and each file with a content hash in the
// name. Fourteen images x two widths x two formats is fifty-six hashed
// filenames, and a re-shoot changes every one of them, so the page reads
// them from the manifest rather than carrying them by hand.
//
// This writes a <picture> pair per slot into apps/site/assets/index.html between
// generated markers, the same arrangement as the icon sprite:
//
//   <!-- generated:shot hero --> ... <!-- /generated:shot hero -->
//
// A pair, not one <picture>, because every shot ships light and dark and
// the header toggle overrides the OS: <source media> cannot see an
// attribute, so CSS does the choosing. See the .shot rules in the page.
//
//   node scripts/gen-shots.mjs          # rewrite every block
//   node scripts/gen-shots.mjs --check  # fail if any block is stale
//
// --check compares with whitespace collapsed, so reformatting the page
// (an editor running prettier on save, say) is not a stale block.
// ----------------------------------------------------------------
import fs from 'fs';

const PAGE = 'apps/site/assets/index.html';
const MANIFEST = 'apps/site/assets/shots/manifest.json';

// ── Per-slot presentation ────────────────────────────────────────
// The manifest owns what the file is; this owns how the page asks for
// it. `sizes` has to describe the slot's real layout width or the
// browser picks the wrong source — it is the only number here that a
// layout change invalidates, so it is written next to the width it
// mirrors in the stylesheet.
//
// Only the hero pair is eager. It sits at the fold and is the first
// thing a visitor sees of the product; every other shot is far enough
// down that lazy costs nothing. Both members of a lazy pair stay
// unfetched while hidden, which is the point — the wrong-theme copy of
// eleven images is not payload anyone should pay for. The theme toggle
// warms them on hover; see warmShots() in the page.
const SHOTS = [
  { id: 'hero', sizes: '(max-width: 1168px) calc(100vw - 48px), 1120px', eager: true },
  { id: 'widget', sizes: '(max-width: 760px) 88vw, 512px' }, //        bento tile A
  { id: 'leads', sizes: '(max-width: 760px) 90vw, 500px' }, //         bento tile B
  { id: 'knowledge', sizes: '(max-width: 760px) 90vw, 500px' }, //     bento tile C
  { id: 'profile', sizes: '(max-width: 900px) 86vw, 580px' }, //       workflow tab 1
  { id: 'install', sizes: '(max-width: 900px) 86vw, 580px' }, //       workflow tab 2
  { id: 'conversations', sizes: '(max-width: 900px) 86vw, 580px' }, // workflow tab 3
];

const THEMES = [
  ['light', 'shot-l'],
  ['dark', 'shot-d'],
];

/** `&` and `"` are the two that break an attribute; alt text is prose. */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function pictures(slot, entry, pad) {
  const { capture, alt, themes } = entry;
  const lines = [];

  for (const [theme, cls] of THEMES) {
    const files = themes[theme];
    if (!files || !files.length) throw new Error(`${slot.id}: manifest has no ${theme} files`);
    const cut = (fmt) => files.filter((f) => f.format === fmt).sort((a, b) => a.width - b.width);
    const srcset = (fmt) => cut(fmt).map((f) => `${f.file} ${f.width}w`).join(', ');

    // The <img> is the last resort, so it carries the widest webp: no
    // browser without AVIF and webp both reaches this page's other
    // requirements either, but a broken <img> is a hole and a large
    // one is only bytes.
    const webp = cut('webp');
    const fallback = webp[webp.length - 1].file;

    lines.push(
      `<picture class="${cls}">`,
      `  <source type="image/avif" srcset="${srcset('avif')}" sizes="${slot.sizes}" />`,
      `  <source type="image/webp" srcset="${srcset('webp')}" sizes="${slot.sizes}" />`,
      `  <img`,
      `    src="${fallback}"`,
      `    width="${capture.width}"`,
      `    height="${capture.height}"`,
      `    loading="${slot.eager ? 'eager' : 'lazy'}"`,
      ...(slot.eager ? ['    fetchpriority="high"'] : []),
      `    decoding="async"`,
      `    alt="${esc(alt)}"`,
      `  />`,
      `</picture>`
    );
  }

  return lines.map((l) => pad + l).join('\n');
}

// ── Rewrite ──────────────────────────────────────────────────────
const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const check = process.argv.includes('--check');
let page = fs.readFileSync(PAGE, 'utf8');
const before = page;

for (const slot of SHOTS) {
  const entry = manifest[slot.id];
  if (!entry) {
    console.error(`\n  No "${slot.id}" in ${MANIFEST}. Run \`npm run shots:shoot\`.\n`);
    process.exit(1);
  }

  // The indent of the opening marker is the indent the block gets, so
  // the generated markup sits at whatever depth the section nests it.
  const re = new RegExp(
    `([ ]*)<!-- generated:shot ${slot.id} -->[^]*?<!-- /generated:shot ${slot.id} -->`
  );
  const m = re.exec(page);
  if (!m) {
    console.error(`\n  ${PAGE} has no <!-- generated:shot ${slot.id} --> marker pair.\n`);
    process.exit(1);
  }

  const pad = m[1];
  const block = [
    `${pad}<!-- generated:shot ${slot.id} -->`,
    pictures(slot, entry, pad),
    `${pad}<!-- /generated:shot ${slot.id} -->`,
  ].join('\n');

  page = page.slice(0, m.index) + block + page.slice(m.index + m[0].length);
}

const flat = (s) => s.replace(/\s+/g, ' ');

if (check) {
  if (flat(page) === flat(before)) {
    console.log(`  ok   shot markup matches ${MANIFEST} (${SHOTS.length} slots)`);
    process.exit(0);
  }
  console.error('\n  Shot markup is stale — run `npm run gen:shots`.');
  console.error('  (A re-shoot rewrites every content hash in the manifest.)\n');
  process.exit(1);
}

if (page === before) {
  console.log(`Shot markup already current (${SHOTS.length} slots).`);
} else {
  fs.writeFileSync(PAGE, page);
  console.log(`Wrote ${SHOTS.length} shot blocks into ${PAGE}.`);
}

const total = SHOTS.reduce(
  (n, s) => n + Object.values(manifest[s.id].themes).flat().reduce((b, f) => b + f.bytes, 0),
  0
);
console.log(`${SHOTS.length} slots, ${(total / 1024).toFixed(0)} KB across every source (both themes, both widths).`);
