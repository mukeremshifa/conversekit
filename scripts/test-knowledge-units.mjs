#!/usr/bin/env node
/**
 * Unit tests for the knowledge pipeline (supabase/011).
 *
 * Four things are pinned here, and each of them is something that
 * cannot be caught by reading the code:
 *
 *   1. THE PROMPT CONTRACT. A bot whose knowledge_migrated_at is NULL
 *      must produce the same system prompt it did before 011, byte for
 *      byte. That is the entire mitigation for the largest risk in the
 *      change, so it is compared as a string rather than reasoned
 *      about — the convention scripts/test-lead-capture.mjs set.
 *
 *   2. THE Q&A CHUNKER. One item is one chunk, and a long answer
 *      carries its question into every piece. That second property is
 *      the whole reason a separate chunker exists, and it is invisible
 *      until an answer is long enough to split.
 *
 *   3. THE LEGACY PARSER. bots.faq was a freehand textarea for two
 *      years. Nothing it contains may be dropped on the floor.
 *
 *   4. THE CONTEXT BUDGET. Retrieved chunks compete with conversation
 *      history for the window, and until 011 nothing bounded them.
 *
 * No network, no database.
 *
 *   npm run test:knowledge
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = mkdtempSync(join(tmpdir(), 'ck-knowledge-'));

await build({
  entryPoints: [
    join(ROOT, 'src/rag/chunk.ts'),
    join(ROOT, 'src/rag/retrieve.ts'),
    join(ROOT, 'src/prompt.ts'),
    join(ROOT, 'src/config.ts'),
  ],
  outdir: OUT, format: 'esm', bundle: true, platform: 'neutral',
});

const { chunkQA, parseFaqText } = await import(`file://${OUT}/rag/chunk.js`);
const { renderContext } = await import(`file://${OUT}/rag/retrieve.js`);
const { buildSystemPrompt } = await import(`file://${OUT}/prompt.js`);
const { capPromptText, validateFaqItem, LIMITS } = await import(`file://${OUT}/config.js`);

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const eq = (label, actual, expected) =>
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// ── The prompt contract ──────────────────────────────────────────
//
// The seed content from 002_phase1.sql, because that is the shape the
// bots this migration has to not break are actually holding.
const SEED_FAQ = [
  'Q: Do I need an appointment?',
  'A: Walk-ins are welcome but appointments are prioritised. Book online or call us.',
  '',
  'Q: Do you accept insurance?',
  'A: Yes, we work with most major insurance providers. Please bring your card.',
  '',
  'Q: How long does a general consultation take?',
  'A: Typically 20-30 minutes.',
  '',
  'Q: Do you offer home visits?',
  'A: Not currently, but we offer teleconsultation by phone or video.',
].join('\n');

const BOT = {
  id: 'b1', org_id: 'o1',
  name: 'Ada', business_name: 'Northgate Dental',
  business_description: 'A family dental practice in central Leeds.',
  hours: 'Mon to Fri, 8am to 6pm',
  address: '12 Northgate, Leeds',
  contact_phone: '0113 555 0100',
  contact_email: 'hello@northgate.example',
  location: null, contact: null,
  services: 'Checkups\nWhitening\nImplants',
  faq: SEED_FAQ,
  custom_instructions: 'Never quote a price without saying it is an estimate.',
  primary_color: '#2563EB', allowed_origin: null, created_at: '2026-01-01T00:00:00Z',
};

console.log('\nPrompt contract — an unmigrated bot is byte-identical');
{
  const before = buildSystemPrompt({ ...BOT, knowledge_migrated_at: null });
  const after  = buildSystemPrompt({ ...BOT, knowledge_migrated_at: '2026-08-18T10:00:00Z' });

  // Reconstructing the pre-011 output from the post-011 one, rather
  // than pasting a literal: a literal drifts silently the first time
  // an unrelated line of the prompt changes, and then this test is
  // asserting history instead of the contract.
  const spliced = after.replace(
    '\n\n## Additional Instructions',
    `\n\n## Services\n${BOT.services}`
    + `\n\n## Frequently Asked Questions\n${BOT.faq}`
    + '\n\n## Additional Instructions',
  );

  check('NULL flag reproduces the pre-011 prompt exactly', before === spliced,
        before === spliced ? '' : `\n--- got ---\n${before}\n--- expected ---\n${spliced}`);
  check('the sections sit between Business Information and Additional Instructions',
        before.indexOf('## Services') > before.indexOf('## Business Information')
        && before.indexOf('## Services') < before.indexOf('## Additional Instructions'));

  check('a migrated bot drops ## Services', !after.includes('## Services'));
  check('a migrated bot drops ## Frequently Asked Questions', !after.includes('## Frequently Asked Questions'));

  // The identity card is the deliberate exception: a bot must know its
  // own opening hours without a vector search rolling the dice.
  check('a migrated bot keeps its hours', after.includes('- Hours: Mon to Fri, 8am to 6pm'));
  check('a migrated bot keeps its address', after.includes('- Address: 12 Northgate, Leeds'));
  check('a migrated bot keeps its business description',
        after.includes('A family dental practice in central Leeds.'));

  // custom_instructions can never move to the corpus: renderContext
  // frames everything it emits as data to be obeyed by nobody.
  check('a migrated bot keeps its custom instructions',
        after.includes('## Additional Instructions')
        && after.includes('Never quote a price without saying it is an estimate.'));

  check('the conversation rules are untouched either way',
        after.includes('1. STAY ON TOPIC.') && before.includes('1. STAY ON TOPIC.'));
}
{
  const bare = { ...BOT, services: null, faq: null };
  check('a bot with neither column is identical migrated or not',
        buildSystemPrompt({ ...bare, knowledge_migrated_at: null })
        === buildSystemPrompt({ ...bare, knowledge_migrated_at: '2026-08-18T10:00:00Z' }));
}
{
  // A Worker running ahead of the migration reads the column as
  // undefined, not null. It must behave as "not migrated".
  const legacy = { ...BOT };
  delete legacy.knowledge_migrated_at;
  check('an absent column reads as not-yet-migrated',
        buildSystemPrompt(legacy).includes('## Frequently Asked Questions'));
}

// ── The Q&A chunker ──────────────────────────────────────────────
console.log('\nQ&A chunking');
{
  const out = chunkQA('Do you accept insurance?', 'Yes, we work with most major providers.');
  eq('a short pair is exactly one chunk', out.length, 1);
  eq('rendered as a pair', out[0],
     'Q: Do you accept insurance?\nA: Yes, we work with most major providers.');
}
{
  const answer = 'The clinic offers a full range of preventative dental care. '.repeat(120);
  const out = chunkQA('What do you offer?', answer, { size: 800 });
  check('a long answer splits', out.length > 3, `got ${out.length}`);
  check('EVERY piece carries the question',
        out.every((c) => c.startsWith('Q: What do you offer?\nA: ')),
        JSON.stringify(out.map((c) => c.slice(0, 30))));
  check('no piece exceeds the budget', out.every((c) => c.length <= 800),
        JSON.stringify(out.map((c) => c.length)));
  const rejoined = out.map((c) => c.replace(/^Q: [^\n]*\nA: /, '')).join(' ');
  check('splitting loses no words of the answer',
        rejoined.replace(/\s+/g, ' ').trim() === answer.replace(/\s+/g, ' ').trim());
}
{
  // Two items must never share a chunk. Bundling unrelated questions
  // into one embedding is the specific failure the character splitter
  // produces on an FAQ, and the reason this function exists.
  const a = chunkQA('Are you open on Sunday?', 'No.');
  const b = chunkQA('Do you do implants?', 'Yes.');
  check('items never merge', a.length === 1 && b.length === 1 && a[0] !== b[0]);
  check('each chunk holds exactly one question',
        a[0].split('Q: ').length === 2 && b[0].split('Q: ').length === 2);
}
eq('an empty question yields nothing', chunkQA('  ', 'An answer.').length, 0);
eq('an empty answer yields nothing', chunkQA('A question?', '   ').length, 0);
{
  // A 300-character question against a small chunk_size must still
  // leave room for an answer rather than producing all header.
  const out = chunkQA('x'.repeat(300), 'y'.repeat(900), { size: 200 });
  check('a long question still leaves the answer room',
        out.every((c) => c.split('\nA: ')[1].length > 0), JSON.stringify(out.map((c) => c.length)));
}

// ── The legacy parser ────────────────────────────────────────────
console.log('\nParsing the legacy bots.faq blob');
{
  const { items, unparsed } = parseFaqText(SEED_FAQ);
  eq('the 002 seed yields four items', items.length, 4);
  eq('nothing is left over', unparsed, '');
  eq('the first question', items[0].question, 'Do I need an appointment?');
  eq('the first answer', items[0].answer,
     'Walk-ins are welcome but appointments are prioritised. Book online or call us.');
  eq('the last question', items[3].question, 'Do you offer home visits?');
}
{
  // The same pairs with no blank lines between them.
  const packed = SEED_FAQ.split('\n').filter(Boolean).join('\n');
  eq('pairs run together still parse', parseFaqText(packed).items.length, 4);
}
{
  const multi = 'Q: What are your hours?\nA: We open at eight.\nOn Saturdays we open at nine.\nWe are closed on Sunday.';
  const { items } = parseFaqText(multi);
  eq('a multi-line answer is one item', items.length, 1);
  check('and keeps all of its lines',
        items[0].answer === 'We open at eight.\nOn Saturdays we open at nine.\nWe are closed on Sunday.',
        JSON.stringify(items[0].answer));
}
{
  const { items } = parseFaqText('Question: Do you park?\nAnswer: There is a car park behind the building.');
  eq('the long marker spellings parse', items.length, 1);
  eq('and the question is clean', items[0].question, 'Do you park?');
}
{
  const prose = 'We are open every weekday and most Saturdays. Call ahead for a slot.';
  const { items, unparsed } = parseFaqText(prose);
  eq('unparseable prose yields no items', items.length, 0);
  eq('and is returned intact rather than discarded', unparsed, prose);
}
{
  const mixed = 'Some notes about the clinic.\n\nQ: Are you open Sunday?\nA: No.';
  const { items, unparsed } = parseFaqText(mixed);
  eq('a preamble does not stop the pairs parsing', items.length, 1);
  eq('and the preamble survives', unparsed, 'Some notes about the clinic.');
}
{
  // The failure that makes a blob format unworkable in the first place.
  const { items } = parseFaqText('Q: How do I ask?\nA: Write it as Q: something, then answer it.');
  eq('a marker inside an answer stays inside the answer', items.length, 1);
  check('and the answer is not truncated at it',
        items[0].answer === 'Write it as Q: something, then answer it.', items[0]?.answer);
}
eq('empty input parses to nothing', parseFaqText('   \n\n ').items.length, 0);

// ── The context budget ───────────────────────────────────────────
console.log('\nRetrieval context budget');
const chunk = (i, len) => ({
  id: `c${i}`, document_id: 'd1', ordinal: i,
  content: `${i}`.padEnd(len, 'x'), similarity: 1 - i / 100,
});
{
  const chunks = Array.from({ length: 40 }, (_, i) => chunk(i, 500));
  const out = renderContext(chunks, 6000);
  check('the rendered section stays near the budget', out.length < 6000 + 500,
        `${out.length} characters`);
  check('it trims from the TAIL, keeping the best-ranked', out.includes('[1] 0x'),
        out.slice(0, 400));
  check('the worst-ranked chunk is dropped', !out.includes('39x'));
}
{
  const chunks = [chunk(0, 300), chunk(1, 300), chunk(2, 300)];
  const out = renderContext(chunks, 10_000);
  check('an ample budget keeps everything',
        out.includes('[1] ') && out.includes('[2] ') && out.includes('[3] '));
}
{
  // Never a partial chunk: half an excerpt is a fact with its
  // qualification removed.
  const chunks = [chunk(0, 400), chunk(1, 400)];
  const out = renderContext(chunks, 1000);
  const bodies = out.match(/^\[\d\] .*/gm) ?? [];
  check('a chunk that does not fit is dropped whole, not cut',
        bodies.every((line) => line.length === 404), JSON.stringify(bodies.map((b) => b.length)));
}
{
  // The one case where the budget yields: returning nothing would say
  // "retrieval found nothing", which the escalation logic believes.
  const out = renderContext([chunk(0, 9000)], 1000);
  check('the top chunk survives a budget it alone exceeds', out.includes('[1] 0x'));
}
eq('no chunks renders nothing', renderContext([], 6000), '');
eq('a whitespace-only chunk renders nothing',
   renderContext([{ ...chunk(0, 1), content: ' \n\t ' }], 6000), '');

// ── Caps ─────────────────────────────────────────────────────────
console.log('\nPrompt-resident text caps');
{
  const payload = { business_description: 'b'.repeat(100_000), custom_instructions: 'c'.repeat(100_000) };
  const truncated = capPromptText(payload);
  eq('business_description is capped', payload.business_description.length, LIMITS.businessDescription);
  eq('custom_instructions is capped', payload.custom_instructions.length, LIMITS.customInstructions);
  check('both are reported as truncated',
        truncated.includes('business_description') && truncated.includes('custom_instructions'));
}
{
  const payload = { business_description: '  A short one.  ', name: 'Ada' };
  const truncated = capPromptText(payload);
  eq('a value under the cap is trimmed, not cut', payload.business_description, 'A short one.');
  eq('nothing is reported', truncated.length, 0);
  eq('an unrelated field is untouched', payload.name, 'Ada');
}
{
  // A partial update must never blank a column it did not mention.
  const payload = { name: 'Ada' };
  capPromptText(payload);
  check('an absent field stays absent', !('custom_instructions' in payload));
}

console.log('\nFAQ item validation');
{
  const ok = validateFaqItem({ question: ' Do you park? ', answer: ' Yes. ' });
  check('a valid item passes', ok.ok);
  eq('and is trimmed', ok.value.question, 'Do you park?');
}
check('an empty question is rejected', validateFaqItem({ question: '  ', answer: 'x' }).ok === false);
check('an empty answer is rejected', validateFaqItem({ question: 'x', answer: '' }).ok === false);
check('a missing answer is rejected on create', validateFaqItem({ question: 'x' }).ok === false);
check('but not on a patch', validateFaqItem({ question: 'x' }, { partial: true }).ok === true);
check('an over-long question is rejected, not silently cut',
      validateFaqItem({ question: 'q'.repeat(LIMITS.faqQuestion + 1), answer: 'a' }).ok === false);
check('an over-long answer likewise',
      validateFaqItem({ question: 'q', answer: 'a'.repeat(LIMITS.faqAnswer + 1) }).ok === false);
check('an unknown field fails loudly', validateFaqItem({ question: 'q', answer: 'a', colour: 'red' }).ok === false);
check('the error names the field',
      /colour/.test(validateFaqItem({ question: 'q', answer: 'a', colour: 'red' }).error ?? ''));

rmSync(OUT, { recursive: true, force: true });

console.log(failures === 0
  ? '\nAll knowledge pipeline unit tests passed.'
  : `\n${failures} knowledge pipeline test(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
