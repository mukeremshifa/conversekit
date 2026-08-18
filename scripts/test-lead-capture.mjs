#!/usr/bin/env node
/**
 * Unit tests for lead capture (supabase/010).
 *
 * Three things here are worth more than the rest put together:
 *
 *   1. THE BYTE-IDENTITY CHECK. Every bot on the platform has a null
 *      lead_config, so if the generated prompt differs from the block
 *      that was hardcoded before 010 — by a comma, by a number, by a
 *      space — the migration silently changed how every existing bot
 *      behaves. The old text is pasted in below verbatim and compared
 *      directly, because reading the generator and agreeing with it is
 *      exactly the thing that does not catch this.
 *
 *   2. THE WEBHOOK URL RULES. The URL is a credential and the Worker
 *      fetches whatever it is given, so both halves matter: an
 *      internal address must not be storable, and a save that does not
 *      mention the webhook must not destroy the stored one.
 *
 *   3. THE BODY SHAPES. Slack, Teams and a customer's CRM cannot be
 *      stood up in CI, so the only honest test of the payloads is to
 *      build them and assert on their structure.
 *
 *   npm run test:leads
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = mkdtempSync(join(tmpdir(), 'ck-leads-'));

await build({
  entryPoints: [
    join(ROOT, 'src/config.ts'),
    join(ROOT, 'src/prompt.ts'),
    join(ROOT, 'src/leads.ts'),
    join(ROOT, 'src/notify.ts'),
  ],
  outdir: OUT, format: 'esm', bundle: true, platform: 'neutral',
});

const { validateLeadConfig, validateUrl, leadCaptureEnabled, LIMITS } =
  await import(`file://${OUT}/config.js`);
const { buildSystemPrompt } = await import(`file://${OUT}/prompt.js`);
const { extractLead } = await import(`file://${OUT}/leads.js`);
const { webhookBody, webhookHost } = await import(`file://${OUT}/notify.js`);

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const eq = (label, actual, expected) =>
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const lead = (input) => validateLeadConfig(input);
const botWith = (lead_config) => ({ name: 'Ada', business_name: 'Acme', lead_config });

// ================================================================
// 1. The block that shipped before 010, character for character.
// ================================================================
const PRE_010_BLOCK = [
  '',
  '## Lead Capture',
  'When a visitor expresses intent to book, get a quote, request a consultation, or contact the business:',
  '1. Acknowledge their request warmly.',
  '2. Collect name, email, and optionally phone — ask naturally, one detail at a time.',
  '3. Ask what their inquiry is about in one short sentence.',
  '4. Once you have at least name + email, confirm their details have been passed to the team.',
  '5. At the very end of that message, after your visible reply, append this on its own line:',
  '   [[LEAD:{"name":"...","email":"...","phone":"...","inquiry":"..."}]]',
  '   Use null for any field the visitor did not provide.',
  '   This marker is processed automatically — it must NEVER appear in the visible reply.',
  '   Only emit it once per conversation.',
].join('\n');

console.log('\nAn unconfigured bot gets exactly the pre-010 prompt');
{
  const out = buildSystemPrompt(botWith(null));
  check('the whole block is reproduced byte for byte', out.includes(PRE_010_BLOCK),
    `generated:\n${out.slice(out.indexOf('## Lead Capture') - 1)}`);
  eq('an empty config is the same as no config',
    buildSystemPrompt(botWith({})).includes(PRE_010_BLOCK), true);
  eq('so is a config that only sets enabled: true',
    buildSystemPrompt(botWith({ enabled: true })).includes(PRE_010_BLOCK), true);
}

console.log('\nDisabling removes the section rather than negating it');
{
  const out = buildSystemPrompt(botWith({ enabled: false }));
  check('no Lead Capture heading', !out.includes('## Lead Capture'));
  check('no marker instructions anywhere', !out.includes('[[LEAD:'));
  check('the rest of the prompt is untouched', out.includes('## Conversation Rules'));
  // The prompt must not merely tell the model to decline — a bot with
  // capture off should be indistinguishable from one that never had it.
  const off = buildSystemPrompt(botWith({ enabled: false }));
  // PRE_010_BLOCK opens with the blank line that separates it from the
  // rules above, so the separator ahead of it has to come out too —
  // otherwise this compares against a prompt with a stray trailing
  // newline and fails for a reason that has nothing to do with leads.
  const never = buildSystemPrompt({ name: 'Ada', business_name: 'Acme' })
    .replace(`\n${PRE_010_BLOCK}`, '');
  eq('identical to a bot with the feature stripped out', off, never);
  eq('leadCaptureEnabled agrees', leadCaptureEnabled(botWith({ enabled: false })), false);
  eq('and defaults to on', leadCaptureEnabled(botWith(null)), true);
}

console.log('\nConfigured fields reshape both the prose and the marker');
{
  const out = buildSystemPrompt(botWith({ fields: { phone: 'off', company: 'off' } }));
  check('phone off drops it from the collect line', out.includes('Collect name and email —'));
  check('and from the marker', out.includes('[[LEAD:{"name":"...","email":"...","inquiry":"..."}]]'));

  const req = buildSystemPrompt(botWith({ fields: { phone: 'required', company: 'required' } }));
  check('required fields move into the required list',
    req.includes('Collect name, email, phone and company —'));
  check('and into the "at least" clause',
    req.includes('at least name + email + phone + company,'));

  const co = buildSystemPrompt(botWith({ fields: { company: 'optional' } }));
  check('two optional fields read naturally',
    co.includes('Collect name, email, and optionally phone and company —'));
  check('marker key order is fixed regardless of config order',
    co.includes('[[LEAD:{"name":"...","email":"...","phone":"...","company":"...","inquiry":"..."}]]'));

  const noInq = buildSystemPrompt(botWith({ fields: { inquiry: 'off' } }));
  check('inquiry off removes its whole step', !noInq.includes('what their inquiry is about'));
  check('and renumbers the steps that follow',
    noInq.includes('3. Once you have at least name + email,'));
}

console.log('\nConsent, success message and booking link');
{
  const out = buildSystemPrompt(botWith({
    consent_text: 'Mind if I take your details?',
    success_message: 'Got it — the team will be in touch.',
    booking_url: 'https://cal.com/acme',
  }));
  check('consent becomes step 1', out.includes('1. Before you ask for any contact details'));
  check('the wording is quoted for the model to translate',
    out.includes('"Mind if I take your details?"'));
  check('declining is handled', out.includes('If they decline, do not ask again'));
  check('the success message replaces the default line',
    out.includes('convey this, adapted to their language: "Got it — the team will be in touch."'));
  check('the default confirmation is gone',
    !out.includes('confirm their details have been passed to the team'));
  check('the booking link is offered', out.includes('https://cal.com/acme'));
  check('and only once', out.includes('Share it once.'));
}

console.log('\nTriggers');
{
  const always = buildSystemPrompt(botWith({ trigger: 'always' }));
  check('always changes the opening line',
    always.includes("Once you have answered the visitor's first question"));
  const after = buildSystemPrompt(botWith({ trigger: 'after_messages', trigger_after_messages: 6 }));
  // after_messages fires through the situational channel in preflight,
  // so the standing block keeps the intent wording.
  check('after_messages leaves the standing block on intent wording',
    after.includes('When a visitor expresses intent to book'));
}

// ================================================================
// 2. Validation
// ================================================================
console.log('\nAbsent config is not an error');
eq('null round-trips to null', lead(null).value, null);
eq('an empty object stores NULL, not {}', lead({}).value, null);
check('an array is not an object', lead([]).ok === false);

console.log('\nUnknown keys are rejected, not dropped');
check('a typo fails loudly', lead({ succes_message: 'hi' }).ok === false);
check('the error names the key', /succes_message/.test(lead({ succes_message: 'hi' }).error ?? ''));
check('an unknown lead field fails', lead({ fields: { budget: 'required' } }).ok === false);
check('name cannot be configured', lead({ fields: { name: 'optional' } }).ok === false);
check('nor can email', lead({ fields: { email: 'off' } }).ok === false);
check('the refusal explains why',
  /always required/.test(lead({ fields: { email: 'off' } }).error ?? ''));
check('an unknown field mode is rejected', lead({ fields: { phone: 'maybe' } }).ok === false);

console.log('\nThe display-only fields the form round-trips are dropped, not rejected');
{
  const r = lead({ tag: 'Web', has_webhook: true, webhook_host: 'hooks.slack.com' });
  check('the save succeeds', r.ok === true);
  eq('has_webhook is not stored', r.value.has_webhook, undefined);
  eq('webhook_host is not stored', r.value.webhook_host, undefined);
  eq('the real setting survives', r.value.tag, 'Web');
}

console.log('\nNumbers clamp, strings truncate — as everywhere else');
{
  eq('a trigger count below the floor clamps up',
    lead({ trigger_after_messages: 1 }).value.trigger_after_messages,
    LIMITS.triggerAfterMessages.min);
  eq('and above the ceiling clamps down',
    lead({ trigger_after_messages: 9999 }).value.trigger_after_messages,
    LIMITS.triggerAfterMessages.max);
  eq('zero means off, so the key is dropped',
    lead({ trigger_after_messages: 0 }).value, null);
  eq('an over-long tag is truncated',
    lead({ tag: 'x'.repeat(200) }).value.tag.length, LIMITS.leadTag);
  eq('a blank string is "unset", not ""', lead({ tag: '   ' }).value, null);
}

console.log('\nWebhook URLs — the SSRF boundary');
{
  const bad = (url) => validateUrl(url, 'webhook_url', { secure: true }).ok === false;
  check('http is refused for a PII sink', bad('http://example.com/hook'));
  check('localhost is refused', bad('https://localhost/hook'));
  check('a .localhost suffix is refused', bad('https://evil.localhost/hook'));
  check('an IPv4 literal is refused', bad('https://169.254.169.254/latest/meta-data'));
  check('a loopback literal is refused', bad('https://127.0.0.1/hook'));
  check('an IPv6 literal is refused', bad('https://[::1]/hook'));
  check('a single-label intranet host is refused', bad('https://intranet/hook'));
  check('an .local mDNS name is refused', bad('https://printer.local/hook'));
  check('embedded credentials are refused', bad('https://user:pw@example.com/hook'));
  check('a URL past the length cap is refused, not truncated',
    bad(`https://example.com/${'x'.repeat(LIMITS.url)}`));
  check('nonsense is refused', bad('not a url'));
  eq('a real Slack webhook passes',
    validateUrl('https://hooks.slack.com/services/T0/B0/xyz', 'webhook_url', { secure: true }).value,
    'https://hooks.slack.com/services/T0/B0/xyz');

  // booking_url is a link the bot reads out, not a destination this
  // Worker posts to, so http is tolerable there.
  check('a booking link may be http',
    validateUrl('http://example.com/book', 'booking_url', { secure: false }).ok === true);
  check('but still not an internal address',
    validateUrl('http://192.168.0.5/book', 'booking_url', { secure: false }).ok === false);
}

console.log('\nClearing a webhook is expressible, but only deliberately');
{
  eq('an explicit null is preserved as a clear signal',
    lead({ webhook_url: null }).value.webhook_url, null);
  eq('an empty string is "not sent", not "delete it"',
    lead({ webhook_url: '' }).value, null);
  eq('and an omitted key stores nothing at all',
    lead({ tag: 'Web' }).value.webhook_url, undefined);
}

console.log('\nEmail recipients');
{
  const r = (v) => lead({ email_recipients: v });
  check('a plain address passes', r(['sales@acme.com']).value.email_recipients.length === 1);
  check('a bad one is rejected', r(['not-an-email']).ok === false);
  check('so is one with a space', r(['a b@acme.com']).ok === false);
  check(`past ${LIMITS.emailRecipients} is rejected`,
    r(Array(LIMITS.emailRecipients + 1).fill('a@b.com')).ok === false);
  eq('duplicates collapse, case-insensitively',
    r(['A@acme.com', 'a@acme.com']).value.email_recipients.length, 1);
  eq('an empty list stores nothing', r([]).value, null);
  check('a non-array is rejected', r('sales@acme.com').ok === false);
}

console.log('\nwebhookHost survives a malformed stored value');
eq('a good URL yields its host', webhookHost('https://hooks.slack.com/x'), 'hooks.slack.com');
eq('a broken one yields null, not a throw', webhookHost('garbage'), null);
eq('so does an absent one', webhookHost(undefined), null);

// ================================================================
// 3. Extraction
// ================================================================
console.log('\nExtraction still guards name + email');
{
  const marker = (o) => `Thanks!\n[[LEAD:${JSON.stringify(o)}]]`;
  eq('a lead without an email is refused',
    extractLead(marker({ name: 'Ada', email: null })).lead, null);
  eq('an email without an @ is refused',
    extractLead(marker({ name: 'Ada', email: 'nope' })).lead, null);
  eq('malformed JSON is refused rather than thrown',
    extractLead('hi [[LEAD:{oops}]]').lead, null);
  eq('the visible reply is still cleaned when the lead is refused',
    extractLead('Thanks! [[LEAD:{oops}]]').cleanReply, 'Thanks!');
}

console.log('\nExtraction honours the configured field set');
{
  const raw = `Done.\n[[LEAD:${JSON.stringify({
    name: 'Ada', email: 'ada@acme.com', phone: '555', company: 'Acme', inquiry: 'pricing',
  })}]]`;

  const dflt = extractLead(raw).lead;
  eq('company is dropped by default', dflt.company, null);
  eq('phone is kept by default', dflt.phone, '555');
  eq('inquiry is kept by default', dflt.inquiry, 'pricing');

  const on = extractLead(raw, { company: 'optional' }).lead;
  eq('company is kept once switched on', on.company, 'Acme');

  const off = extractLead(raw, { phone: 'off', inquiry: 'off' }).lead;
  eq('a field switched off is discarded even if the model sends it', off.phone, null);
  eq('same for inquiry', off.inquiry, null);
  eq('name survives regardless', off.name, 'Ada');

  // Required is a prompt instruction, not an extraction gate: throwing
  // away a lead with a valid name and email because one extra field is
  // missing loses the thing the feature exists to capture.
  const missing = extractLead(`x\n[[LEAD:${JSON.stringify({ name: 'Ada', email: 'a@b.c' })}]]`,
    { phone: 'required' }).lead;
  check('a missing required field does not discard the lead', missing !== null);
  eq('it is simply absent', missing.phone, null);
}

// ================================================================
// 4. Webhook bodies
// ================================================================
const NOTE = {
  botName: 'Ada', businessName: 'Acme Ltd',
  lead: { name: 'Bo <Smith>', email: 'bo@acme.com', phone: '555', inquiry: 'pricing & terms', company: null },
  sessionId: 'sess_1', tag: 'Website chat', consentGiven: true,
  bookingUrl: 'https://cal.com/acme', capturedAt: '2026-08-18T10:00:00.000Z',
};

console.log('\nGeneric JSON body');
{
  const b = webhookBody('json', NOTE);
  eq('is versioned by event name', b.event, 'lead.created');
  eq('carries the email', b.lead.email, 'bo@acme.com');
  eq('carries the tag', b.lead.tag, 'Website chat');
  eq('carries the session id so a transcript can be found', b.lead.session_id, 'sess_1');
  eq('reports an uncollected field as null rather than omitting it', b.lead.company, null);
  eq('names the consent flag the same as the column', b.lead.consent_given, true);
  check('does not leak the webhook URL back to the receiver',
    !JSON.stringify(b).includes('hooks.slack.com'));
}

console.log('\nSlack body');
{
  const b = webhookBody('slack', NOTE);
  check('has a text fallback for clients that ignore blocks', typeof b.text === 'string');
  const rendered = JSON.stringify(b);
  check('escapes the three characters Slack reserves', rendered.includes('Bo &lt;Smith&gt;'));
  check('escapes ampersands too', rendered.includes('pricing &amp; terms'));
  check('omits a field the visitor did not give', !rendered.includes('Company'));
  check('includes the booking link', rendered.includes('https://cal.com/acme'));
}

console.log('\nTeams body');
{
  const b = webhookBody('teams', NOTE);
  eq('uses the Workflows envelope', b.type, 'message');
  eq('and an Adaptive Card, not a retired MessageCard',
    b.attachments[0].content.type, 'AdaptiveCard');
  check('is not a MessageCard', !JSON.stringify(b).includes('MessageCard'));
  const facts = b.attachments[0].content.body.find((x) => x.type === 'FactSet').facts;
  eq('renders facts as title/value pairs', facts[0].title, 'Name');
  eq('with the value alongside', facts[1].value, 'bo@acme.com');
}

rmSync(OUT, { recursive: true, force: true });
console.log(failures ? `\n${failures} failing check(s).\n` : '\nAll lead capture unit tests passed.\n');
process.exit(failures ? 1 : 0);
