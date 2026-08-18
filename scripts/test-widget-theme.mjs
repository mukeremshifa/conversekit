#!/usr/bin/env node
/**
 * Tests the widget's colour maths against both panel surfaces.
 *
 * This file exists because of one bug class. `inkVariant` picks the
 * readable version of a tenant's brand colour by walking its lightness
 * until it clears 4.5:1 — and it used to walk in one direction only,
 * because the panel was always white. Dark mode makes that search run
 * the wrong way, and the failure is silent: near-black text on a
 * near-black panel, in a widget on someone else's site.
 *
 * So every assertion here is really the same assertion: whatever colour
 * a tenant picks, and whichever theme resolves, the result is readable.
 *
 *   npm run test:widget-theme
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(ROOT, 'public/widget.js'), 'utf8');

// Same trick as test-widget-markdown.mjs: the colour block is pure, so
// it evaluates standalone without a DOM.
const start = src.indexOf("  var INK = '#0A0A0C';");
const end = src.indexOf('  function applyColor(root)');
if (start < 0 || end < 0) {
  console.error('Could not locate the colour block in widget.js');
  process.exit(2);
}
const lifted = new Function(
  `${src.slice(start, end)}\nreturn { inkVariant, onColor, luminance, hexToRgb, ratio, SURFACE_LUM };`,
)();
const { inkVariant, onColor, luminance, hexToRgb, ratio, SURFACE_LUM } = lifted;

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};

const contrast = (hex, surfaceLum) => ratio(luminance(hexToRgb(hex)), surfaceLum);

/** Brand colours worth covering: a light one, a dark one, a saturated
 *  mid, and the two extremes that break naive implementations. */
const BRANDS = [
  ['ConverseKit gold', '#EEBA2B'],
  ['a mid blue',       '#2563EB'],
  ['near-black',       '#111111'],
  ['near-white',       '#FAFAFA'],
  ['pure yellow',      '#FFFF00'],
  ['pure red',         '#FF0000'],
  ['deep navy',        '#001133'],
];

console.log('\nSurfaces');
check('light surface is white', SURFACE_LUM.light === 1);
check('dark surface is the panel colour, not black',
  SURFACE_LUM.dark > 0 && SURFACE_LUM.dark < 0.05,
  `got ${SURFACE_LUM.dark}`);

console.log('\ninkVariant clears 4.5:1 on the light panel');
for (const [label, hex] of BRANDS) {
  const out = inkVariant(hex, SURFACE_LUM.light);
  check(label, contrast(out, SURFACE_LUM.light) >= 4.5,
    `${hex} -> ${out} = ${contrast(out, SURFACE_LUM.light).toFixed(2)}:1`);
}

console.log('\ninkVariant clears 4.5:1 on the dark panel');
for (const [label, hex] of BRANDS) {
  const out = inkVariant(hex, SURFACE_LUM.dark);
  check(label, contrast(out, SURFACE_LUM.dark) >= 4.5,
    `${hex} -> ${out} = ${contrast(out, SURFACE_LUM.dark).toFixed(2)}:1`);
}

console.log('\nThe two surfaces disagree, which is the whole point');
{
  // The regression this file was written for: a dark brand colour that
  // is already readable on white must NOT be handed back unchanged for
  // a dark panel.
  const onLight = inkVariant('#111111', SURFACE_LUM.light);
  const onDark  = inkVariant('#111111', SURFACE_LUM.dark);
  check('near-black is kept on white', onLight === '#111111');
  check('near-black is lightened for the dark panel', onDark !== '#111111', `got ${onDark}`);
  check('and the lightened result is readable',
    contrast(onDark, SURFACE_LUM.dark) >= 4.5);
}
{
  const onDark = inkVariant('#FAFAFA', SURFACE_LUM.dark);
  check('near-white is kept on the dark panel', onDark === '#FAFAFA');
  check('near-white is darkened for the light panel',
    inkVariant('#FAFAFA', SURFACE_LUM.light) !== '#FAFAFA');
}

console.log('\nHue is preserved where there is room for it');
{
  // Not a hard guarantee — a fully saturated hue can run out of
  // lightness before it clears the ratio, and then a neutral is
  // correct. But a mid blue has plenty of room.
  const out = inkVariant('#2563EB', SURFACE_LUM.dark);
  check('a mid blue stays blue on the dark panel',
    /^#[0-9a-f]{2}/i.test(out) && hexToRgb(out)[2] > hexToRgb(out)[0],
    `got ${out}`);
}

console.log('\nGarbage in, readable out');
for (const bad of [null, undefined, '', 'rebeccapurple', '#12', 'not a colour']) {
  check(`${JSON.stringify(bad)} falls back readably on light`,
    contrast(inkVariant(bad, SURFACE_LUM.light), SURFACE_LUM.light) >= 4.5);
  check(`${JSON.stringify(bad)} falls back readably on dark`,
    contrast(inkVariant(bad, SURFACE_LUM.dark), SURFACE_LUM.dark) >= 4.5);
}

console.log('\nonColor picks a foreground that reads on the brand colour');
for (const [label, hex] of BRANDS) {
  const fg = onColor(hex);
  const c = ratio(luminance(hexToRgb(fg)), luminance(hexToRgb(hex)));
  // 4.5 is not always reachable against an arbitrary mid-tone; 3:1 is
  // the large-text threshold, and this text is 15px+ bold on a button.
  check(`${label} -> ${fg}`, c >= 3, `${c.toFixed(2)}:1`);
}

console.log(failures ? `\n${failures} failing check(s).\n` : '\nAll widget theme tests passed.\n');
process.exit(failures ? 1 : 0);
