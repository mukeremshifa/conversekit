#!/usr/bin/env node
/**
 * Unit tests for Bot Configuration validation.
 *
 * These validators are the only thing checking the shape of the two
 * JSONB columns added in 009 — Postgres cannot, which is the trade-off
 * that choosing jsonb over ten scalar columns bought. So the rules they
 * encode are worth pinning down: clamp numbers, reject unknown keys,
 * and never let logo_key in from a settings form.
 *
 * The logo sniffing is here for the same reason it matters in
 * rag/files.ts — an upload's filename and content type are both
 * supplied by whoever is uploading, so the leading bytes are the only
 * honest signal.
 *
 *   npm run test:config
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = mkdtempSync(join(tmpdir(), 'ck-config-'));

await build({
  entryPoints: [join(ROOT, 'src/config.ts'), join(ROOT, 'src/logo.ts'), join(ROOT, 'src/prompt.ts')],
  outdir: OUT, format: 'esm', bundle: true, platform: 'neutral',
});
const { buildSystemPrompt } = await import(`file://${OUT}/prompt.js`);
const { validateWidgetConfig, validateBehaviorConfig, widgetPublicConfig, LIMITS } =
  await import(`file://${OUT}/config.js`);
const { detectLogoType, logoKeyFor, logoVersion, logoUrlFor, MAX_LOGO_BYTES } =
  await import(`file://${OUT}/logo.js`);

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const eq = (label, actual, expected) =>
  check(label, Object.is(actual, expected), `expected ${expected}, got ${actual}`);

const widget = (input) => validateWidgetConfig(input);
const behavior = (input) => validateBehaviorConfig(input);

console.log('\nAbsent config is not an error');
eq('null round-trips to null', widget(null).value, null);
eq('undefined round-trips to null', widget(undefined).value, null);
eq('an empty object stores NULL, not {}', widget({}).value, null);
check('behaviour agrees', behavior(null).ok && behavior(null).value === null);
check('an array is not an object', widget([]).ok === false);
check('a string is not an object', behavior('bottom-left').ok === false);

console.log('\nEnums');
eq('a known position passes', widget({ position: 'bottom-left' }).value.position, 'bottom-left');
check('an unknown position is rejected', widget({ position: 'top-left' }).ok === false);
eq('a known theme passes', widget({ theme: 'auto' }).value.theme, 'auto');
check('an unknown theme is rejected', widget({ theme: 'solarized' }).ok === false);

console.log('\nUnknown keys are rejected, not dropped');
check('a typo in a widget key fails loudly', widget({ show_typo: true }).ok === false);
check('a typo in a behaviour key fails loudly', behavior({ max_message: 10 }).ok === false);
check('the error names the key',
  /show_typo/.test(widget({ show_typo: true }).error ?? ''),
  widget({ show_typo: true }).error);

console.log('\nlogo_key belongs to the upload route');
{
  const r = widget({ logo_key: 'logos/other-org/other-bot/stolen.png' });
  check('a settings form cannot set it', r.ok === false);
  check('and is told why', /upload route/.test(r.error ?? ''), r.error);
}

console.log('\nNumbers clamp rather than fail');
eq('a delay past the cap clamps',
  widget({ greeting_delay_ms: 999_999 }).value.greeting_delay_ms, LIMITS.greetingDelayMs);
eq('a negative delay reads as unset', widget({ greeting_delay_ms: -5 }).value, null);
eq('a fractional delay rounds', widget({ greeting_delay_ms: 250.7 }).value.greeting_delay_ms, 251);
check('a non-number delay is rejected', widget({ greeting_delay_ms: '250' }).ok === false);

eq('max_messages below the floor clamps up',
  behavior({ max_messages: 1 }).value.max_messages, LIMITS.maxMessages.min);
eq('max_messages above the ceiling clamps down',
  behavior({ max_messages: 5000 }).value.max_messages, LIMITS.maxMessages.max);
eq('zero means off, and off stores nothing', behavior({ max_messages: 0 }).value, null);
eq('escalation below the floor clamps up',
  behavior({ escalate_after_misses: 1 }).value.escalate_after_misses, LIMITS.escalateAfterMisses.min);
check('NaN is not a number here', behavior({ max_messages: NaN }).ok === false);

console.log('\nText');
eq('a greeting is trimmed', widget({ greeting: '  Hi there  ' }).value.greeting, 'Hi there');
eq('an all-space greeting reads as unset', widget({ greeting: '   ' }).value, null);
eq('a long greeting is cut to the limit',
  widget({ greeting: 'x'.repeat(500) }).value.greeting.length, LIMITS.greeting);
eq('a long fallback is cut to the limit',
  behavior({ fallback_message: 'y'.repeat(500) }).value.fallback_message.length, LIMITS.fallbackMessage);
check('a non-string greeting is rejected', widget({ greeting: 42 }).ok === false);

console.log('\nBooleans');
eq('show_typing false is kept', widget({ show_typing: false }).value.show_typing, false);
eq('show_typing true is kept', widget({ show_typing: true }).value.show_typing, true);
check('a truthy string is not a boolean', widget({ show_typing: 'yes' }).ok === false);

console.log('\nThe widget only hears about what was set');
{
  const bot = { id: 'b1', widget_config: null };
  eq('an unconfigured bot sends nothing at all', widgetPublicConfig(bot, null), null);
}
{
  const bot = { id: 'b1', widget_config: { position: 'bottom-left', show_typing: true } };
  const out = widgetPublicConfig(bot, null);
  eq('a set position is sent', out.position, 'bottom-left');
  check('a default-valued toggle is not sent', !('showTyping' in out));
}
{
  const bot = { id: 'b1', widget_config: { show_typing: false, show_citations: true } };
  const out = widgetPublicConfig(bot, null);
  eq('typing off is sent, because it differs from the default', out.showTyping, false);
  eq('citations on is sent', out.showCitations, true);
}
{
  const bot = { id: 'b1', widget_config: { logo_key: 'logos/o/b/abc.png' } };
  const out = widgetPublicConfig(bot, 'https://api.example.com/v1/bots/b1/logo?v=abc');
  check('the R2 key never reaches the widget', !JSON.stringify(out).includes('logos/'));
  check('a URL does instead', out.logoUrl.endsWith('v=abc'));
}

console.log('\nLogo URLs');
{
  const bot = { id: 'b1', widget_config: { logo_key: 'logos/o1/b1/9f3c.png' } };
  eq('version is the key\'s random segment', logoVersion('logos/o1/b1/9f3c.png'), '9f3c');
  eq('URL is built from the request origin',
    logoUrlFor(bot, 'https://api.example.com'),
    'https://api.example.com/v1/bots/b1/logo?v=9f3c');
  eq('no logo, no URL', logoUrlFor({ id: 'b1', widget_config: null }, 'https://x.test'), null);
}
{
  const key = logoKeyFor('org-1', 'bot-1', 'png');
  check('keys are prefixed so they cannot be mistaken for documents', key.startsWith('logos/org-1/bot-1/'));
  check('two uploads never collide', key !== logoKeyFor('org-1', 'bot-1', 'png'));
}

console.log('\nLogo sniffing — the bytes decide, not the filename');
const head = (bytes) => new Uint8Array([...bytes, ...new Array(16).fill(0)].slice(0, 16));
const PNG  = head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = head([0xff, 0xd8, 0xff, 0xe0]);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const WEBP = head([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP')]);
const WAV  = head([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]);
const SVG  = head(ascii('<svg xmlns="h'));
const PDF  = head(ascii('%PDF-1.7'));

eq('PNG', detectLogoType(PNG).type.mime, 'image/png');
eq('JPEG', detectLogoType(JPEG).type.mime, 'image/jpeg');
eq('WebP', detectLogoType(WEBP).type.mime, 'image/webp');
check('a RIFF container that is not WebP is refused', detectLogoType(WAV).ok === false);
check('SVG is refused — it is a script container', detectLogoType(SVG).ok === false);
check('the refusal says so', /SVG is not accepted/.test(detectLogoType(SVG).error ?? ''));
check('a PDF renamed logo.png is refused', detectLogoType(PDF).ok === false);
check('empty input is refused', detectLogoType(new Uint8Array(0)).ok === false);
eq('the cap is half a megabyte', MAX_LOGO_BYTES, 512 * 1024);

console.log('\nSituational directives leave an unconfigured bot untouched');
{
  const bot = { name: 'Ada', business_name: 'Acme', contact_phone: '555' };
  const before = buildSystemPrompt(bot, '');
  eq('no directives is byte-identical to the old two-argument call',
    buildSystemPrompt(bot, '', []), before);
  check('and carries no section header', !before.includes('## This Conversation'));
}
{
  const bot = { name: 'Ada', business_name: 'Acme' };
  const out = buildSystemPrompt(bot, '', ['Offer to connect them with a person.']);
  check('a directive adds the section', out.includes('## This Conversation'));
  check('and the directive itself', out.includes('- Offer to connect them with a person.'));
  check('it tells the model to translate rather than recite',
    /in the visitor's own\s*\n?language/.test(out));
}
{
  // Ordering is load-bearing: retrieved text is explicitly framed as
  // untrusted, so platform directives must be established before it.
  const bot = { name: 'Ada', business_name: 'Acme' };
  const out = buildSystemPrompt(bot, '## Retrieved Reference Material\n\n[1] hello', ['Do the thing.']);
  check('directives come before retrieved material',
    out.indexOf('## This Conversation') < out.indexOf('## Retrieved Reference Material'));
}

rmSync(OUT, { recursive: true, force: true });
console.log(failures ? `\n${failures} failing check(s).\n` : '\nAll config unit tests passed.\n');
process.exit(failures ? 1 : 0);
