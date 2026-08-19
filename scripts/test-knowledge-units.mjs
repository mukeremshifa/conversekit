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
 *   5. THE RETRIEVAL CONTRACT (added with the B1 hardening). Which
 *      channel answered, what counts as too short to embed, and where
 *      the similarity floor came from. None of it had a test, which is
 *      how a floor below the embedder's noise floor survived four
 *      months of looking like it worked. See docs/rag-hardening.md.
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
    join(ROOT, 'src/rag/extract.ts'),
    join(ROOT, 'src/rag/retrieve.ts'),
    join(ROOT, 'src/rag/ingest.ts'),
    join(ROOT, 'src/supabase.ts'),
    join(ROOT, 'src/providers/catalog.ts'),
    join(ROOT, 'src/providers/errors.ts'),
    join(ROOT, 'src/prompt.ts'),
    join(ROOT, 'src/config.ts'),
  ],
  outdir: OUT, format: 'esm', bundle: true, platform: 'neutral',
});

const { chunkQA, chunkText, parseFaqText } = await import(`file://${OUT}/rag/chunk.js`);
const { htmlToText, markdownToText } = await import(`file://${OUT}/rag/extract.js`);
const {
  renderContext, selectContext, retrieve, isTooShortToRetrieve, retrievalLogRow,
  dedupe, shingleOverlap, fuseRRF, rerankOrder,
} = await import(`file://${OUT}/rag/retrieve.js`);
const { ragConfigFor, retryDelayMs, ingestDocument } = await import(`file://${OUT}/rag/ingest.js`);
const { claimDocument } = await import(`file://${OUT}/supabase.js`);
const { parseRetryAfter } = await import(`file://${OUT}/providers/errors.js`);
const { similarityFloorFor, resolveSimilarityFloor, DEFAULT_SIMILARITY_FLOOR } =
  await import(`file://${OUT}/providers/catalog.js`);
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

// ── Heading context (M6) ─────────────────────────────────────────
//
// The prefix is only reachable if a heading survives extraction, and
// all three extractors used to destroy headings differently. So this
// tests the whole path rather than the chunker alone — a chunkText that
// looks for `#` markers nothing produces is a feature that ships
// looking correct and does nothing.
console.log('\nHeading context');
{
  const md = markdownToText('# Pricing\n\nWhitening costs 199.\n\n## Plans\n\nMonthly or annual.');
  check('markdown extraction KEEPS the heading marker', /^# Pricing$/m.test(md), md);
  check('at its own level', /^## Plans$/m.test(md), md);
}
{
  const md = markdownToText('   ### Indented heading\n\nBody.');
  check('leading whitespace is normalised away', /^### Indented heading$/m.test(md), md);
}
{
  const html = htmlToText('<html><body><h1>Pricing</h1><p>Whitening costs 199.</p>'
                        + '<h2>Plans</h2><p>Monthly or annual.</p></body></html>');
  check('HTML extraction produces an ATX h1', /^# Pricing$/m.test(html), html);
  check('and preserves the level of an h2', /^## Plans$/m.test(html), html);
  check('the body text is still there', html.includes('Whitening costs 199.'));
}
{
  const text = '# Pricing\n\n' + 'Whitening costs one hundred and ninety nine pounds. '.repeat(30);
  const out = chunkText(text, { size: 400, overlap: 60, title: 'Clinic handbook' });
  check('the text splits into several chunks', out.length > 2, `got ${out.length}`);
  check('EVERY chunk carries the breadcrumb, not just the first',
        out.every((c) => c.startsWith('Clinic handbook › Pricing\n\n')),
        JSON.stringify(out.map((c) => c.slice(0, 40))));
  check('the marker itself is consumed, never embedded',
        out.every((c) => !c.includes('#')), JSON.stringify(out.map((c) => c.slice(0, 40))));
}
{
  // The point of the whole item: chunk N of a section, not just chunk 1,
  // has to say what section it is in.
  const text = '# Pricing\n\n' + 'x'.repeat(2000);
  const out = chunkText(text, { size: 300, overlap: 0, title: 'Handbook' });
  check('the second chunk under a heading is prefixed too',
        out[1]?.startsWith('Handbook › Pricing\n\n'), out[1]?.slice(0, 40));
}
{
  const text = '# Pricing\n\nWhitening costs 199.\n\n# Refunds\n\nWithin 14 days.';
  const out = chunkText(text, { size: 800, overlap: 0, title: 'Handbook' });
  eq('two headings produce two chunks', out.length, 2);
  check('each names its OWN section',
        out[0].startsWith('Handbook › Pricing') && out[1].startsWith('Handbook › Refunds'),
        JSON.stringify(out));
}
{
  // A heading with no body of its own must not take its words with it.
  const out = chunkText('# Pricing\n\n## Plans\n\nMonthly or annual.', { size: 800, title: 'Handbook' });
  eq('a bodyless heading folds into the trail', out.length, 1);
  check('keeping both levels', out[0].startsWith('Handbook › Pricing › Plans\n\n'), out[0]);
}
{
  const out = chunkText('# Contact us', { size: 800, title: 'Handbook' });
  check('a trailing heading with no body keeps its words',
        out.length === 1 && out[0].includes('Contact us'), JSON.stringify(out));
}
{
  // The MIN_ANSWER_BUDGET failure, reached from the other direction: a
  // long title against a small chunk_size would otherwise produce a
  // chunk that is all header.
  const long = 'The Complete Clinic Handbook, Revised Second Edition, 2026';
  const out = chunkText('# Pricing\n\nWhitening costs 199.', { size: 200, title: long });
  check('a breadcrumb that would eat the budget is dropped whole',
        !out[0].includes('›') && !out[0].startsWith(long), out[0]);
  check('and the text is still there', out[0].includes('Whitening costs 199.'), out[0]);
}
{
  // The regression net. With no headings and no title the chunker must
  // behave exactly as it did before M6 — there is one section, so
  // nothing about the split or the overlap may change.
  const text = 'Sentence one. '.repeat(200);
  const before = chunkText(text, { size: 400, overlap: 60 });
  check('no headings, no title: chunks are unprefixed',
        before.every((c) => !c.includes('›')), JSON.stringify(before.map((c) => c.slice(0, 20))));
  check('and overlap still carries between them',
        before.length > 1 && before[1].startsWith(before[0].slice(-60).trimStart().split(' ')[0]),
        JSON.stringify(before.slice(0, 2).map((c) => c.slice(0, 40))));
}
{
  // chunkQA is deliberately untouched: it already carries its own
  // header, and a second prefix would spend the budget twice.
  const out = chunkQA('Do you accept insurance?', 'Yes.', { size: 800, title: 'Handbook' });
  eq('chunkQA output is unchanged by M6', out[0],
     'Q: Do you accept insurance?\nA: Yes.');
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

// ── The short-query gate ─────────────────────────────────────────
//
// "ok" and "hi" retrieve noise and are rightly skipped. The measure
// used to be four UTF-16 code units, which is a Latin word-length
// heuristic on a platform that answers in the visitor's own language.
console.log('\nShort-query gate');
check('an empty query is skipped', isTooShortToRetrieve('   '));
check('a two-letter greeting is skipped', isTooShortToRetrieve('hi'));
check('a three-letter word is skipped', isTooShortToRetrieve('ok?'));
check('four Latin characters pass', !isTooShortToRetrieve('cost'));
check('a three-character Chinese question passes', !isTooShortToRetrieve('多少钱'));
check('a four-character Chinese question passes', !isTooShortToRetrieve('天气如何'));
check('a two-character Japanese question passes', !isTooShortToRetrieve('料金'));
check('a two-syllable Korean word passes', !isTooShortToRetrieve('가격'));
check('a two-character Thai word passes', !isTooShortToRetrieve('ราคา'));
check('a single Chinese character is still skipped', isTooShortToRetrieve('钱'));
// .length would report 2 for one astral character and let it through.
check('one emoji is counted as one character, not two', isTooShortToRetrieve('😀'));

// ── The similarity floor ─────────────────────────────────────────
//
// The headline of the B1 hardening: the floor is a property of the
// embedding MODEL, and treating it as a platform constant is what made
// retrieval unable to reject anything.
console.log('\nSimilarity floor resolution');
eq('the platform default embedder gets its measured floor',
   similarityFloorFor({ vendor: 'workers-ai', model: '@cf/baai/bge-base-en-v1.5' }), 0.60);
eq('the same model on another vendor gets the same floor',
   similarityFloorFor({ vendor: 'together', model: 'BAAI/bge-base-en-v1.5' }), 0.60);
// The case the vendor preset alone would get wrong.
eq('a bge model behind a custom endpoint still gets it',
   similarityFloorFor({ vendor: 'custom', model: 'bge-large-en-v1.5' }), 0.60);
eq('an unknown model falls back to the documented default',
   similarityFloorFor({ vendor: 'openai', model: 'text-embedding-3-small' }),
   DEFAULT_SIMILARITY_FLOOR);
eq('an unknown vendor falls back too',
   similarityFloorFor({ vendor: 'nonesuch', model: 'whatever' }), DEFAULT_SIMILARITY_FLOOR);
eq('a measured floor reports itself as measured',
   resolveSimilarityFloor({ vendor: 'workers-ai', model: '@cf/baai/bge-base-en-v1.5' }).source, 'model');
eq('an unmeasured one says so',
   resolveSimilarityFloor({ vendor: 'openai', model: 'text-embedding-3-small' }).source, 'default');

console.log('\nrag_config resolution');
{
  const bot = { rag_config: null };
  eq('with no config and no model, the default floor applies',
     ragConfigFor(bot).min_similarity, DEFAULT_SIMILARITY_FLOOR);
  eq('a model floor overrides the default', ragConfigFor(bot, 0.6).min_similarity, 0.6);
}
{
  // The contract the rollout depends on: a tenant who set this keeps it.
  const bot = { rag_config: { min_similarity: 0.42 } };
  eq('an explicit tenant floor beats the model floor',
     ragConfigFor(bot, 0.6).min_similarity, 0.42);
}
{
  const bot = { rag_config: { min_similarity: 0 } };
  eq('an explicit zero is honoured, not treated as absent',
     ragConfigFor(bot, 0.6).min_similarity, 0);
}
{
  const bot = { rag_config: { top_k: 500, min_similarity: 9, chunk_size: 10, context_chars: 5, priority_boost: 3 } };
  const cfg = ragConfigFor(bot, 0.6);
  eq('top_k is clamped', cfg.top_k, 20);
  eq('min_similarity is clamped to 1', cfg.min_similarity, 1);
  eq('chunk_size is clamped up to the floor', cfg.chunk_size, 200);
  eq('context_chars is clamped up to the floor', cfg.context_chars, 1000);
  eq('priority_boost is clamped below 1', cfg.priority_boost, 0.5);
}

// ── Which channel answered ───────────────────────────────────────
//
// Exercised through the real wiring rather than a reimplementation:
// the fetch stub answers the embeddings endpoint and both RPCs, so
// provider resolution, the floor, the RPC payloads and the fallback
// decision all run exactly as they do in the Worker.
console.log('\nRetrieval channels');

const DB = { url: 'http://db.test', headers: {} };
const ENV = {};

/** A bot whose embedder is a local OpenAI-compatible server, so the
 *  stub can answer it without a key or a binding. */
const evalBot = (rag = {}) => ({
  id: 'bot-1',
  rag_config: rag,
  embedding_config: { vendor: 'custom', model: 'stub-embed', baseUrl: 'http://embed.test/v1' },
});

const row = (i) => ({
  id: `c${i}`, document_id: 'd1', ordinal: i,
  content: `chunk ${i}`, similarity: 0.9 - i / 100, kind: 'prose', priority: 0,
});

/** Records what each endpoint was asked, and answers with whatever the
 *  case under test wants back. */
function stubFetch({ vector = [1, 2, 3], match = [], lexical = [] }) {
  const seen = { embeddings: 0, match: 0, lexical: 0, payloads: [] };
  globalThis.fetch = async (url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    const json = (data) => new Response(JSON.stringify(data), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });

    if (String(url).endsWith('/embeddings')) {
      seen.embeddings++;
      return json({ data: [{ index: 0, embedding: vector }], model: 'stub-embed' });
    }
    if (String(url).includes('/rpc/match_chunks_lexical')) {
      seen.lexical++; seen.payloads.push(body);
      return json(lexical);
    }
    if (String(url).includes('/rpc/match_chunks')) {
      seen.match++; seen.payloads.push(body);
      return json(match);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  return seen;
}

const realFetch = globalThis.fetch;

{
  const seen = stubFetch({ match: [row(0), row(1)] });
  const out = await retrieve(ENV, DB, evalBot(), 'how much does whitening cost');
  eq('a vector hit reports the vector channel', out.channel, 'vector');
  eq('and returns its rows', out.chunks.length, 2);
  eq('every chunk is stamped with the channel', out.chunks[0].channel, 'vector');
  eq('the lexical index is not consulted on the happy path', seen.lexical, 0);
}
{
  const seen = stubFetch({ match: [], lexical: [row(0)] });
  const out = await retrieve(ENV, DB, evalBot(), 'do u take insurance');
  eq('an empty vector result falls through to lexical', out.channel, 'lexical');
  eq('and returns its rows', out.chunks.length, 1);
  eq('stamped as lexical', out.chunks[0].channel, 'lexical');
  eq('the fallback cost exactly one extra query', seen.lexical, 1);
}
{
  const seen = stubFetch({ match: [], lexical: [row(0)] });
  const out = await retrieve(ENV, DB, evalBot({ lexical_fallback: false }), 'do u take insurance');
  eq('the fallback can be switched off', out.chunks.length, 0);
  eq('and then never runs', seen.lexical, 0);
  eq('with no channel to report', out.channel, undefined);
}
{
  stubFetch({ match: [], lexical: [] });
  const out = await retrieve(ENV, DB, evalBot(), 'what is the weather in Oslo');
  // The state that was unreachable before B1, and that three shipped
  // features are gated on.
  eq('both channels empty is a clean miss', out.chunks.length, 0);
  eq('reported without an error', out.error, undefined);
}
{
  const seen = stubFetch({ match: [row(0)] });
  const out = await retrieve(ENV, DB, evalBot({ enabled: false }), 'anything at all');
  eq('a disabled bot skips', out.skipped, 'disabled');
  eq('without embedding anything', seen.embeddings, 0);
}
{
  const seen = stubFetch({ match: [row(0)] });
  const out = await retrieve(ENV, DB, evalBot(), 'hi');
  eq('a too-short query skips', out.skipped, 'empty-query');
  eq('without embedding anything', seen.embeddings, 0);
}
{
  // A broken embedder must not fail the visitor's turn.
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  const out = await retrieve(ENV, DB, evalBot(), 'how much does whitening cost');
  eq('a vendor failure returns no chunks', out.chunks.length, 0);
  check('and reports the reason', typeof out.error === 'string' && out.error.length > 0, out.error);
}

console.log('\nThe floor that actually ran');
{
  const seen = stubFetch({ match: [] });
  const out = await retrieve(ENV, DB, evalBot(), 'how much does whitening cost');
  const payload = seen.payloads.find((p) => p && 'p_min_similarity' in p);
  eq('the resolved floor is what match_chunks is asked for',
     payload.p_min_similarity, out.effective.min_similarity);
  eq('the model that ran is reported', out.effective.embedding_model, 'stub-embed');
  eq('an unknown model is flagged as the unmeasured default',
     out.effective.floor_source, 'default');
}
{
  const seen = stubFetch({ match: [] });
  const bot = evalBot({ min_similarity: 0.42 });
  const out = await retrieve(ENV, DB, bot, 'how much does whitening cost');
  const payload = seen.payloads.find((p) => p && 'p_min_similarity' in p);
  eq('a tenant override reaches the RPC', payload.p_min_similarity, 0.42);
  eq('and is attributed to the tenant', out.effective.floor_source, 'tenant');
}
{
  const seen = stubFetch({ match: [] });
  const bot = evalBot();
  bot.embedding_config = { vendor: 'custom', model: 'bge-base-en-v1.5', baseUrl: 'http://embed.test/v1' };
  const out = await retrieve(ENV, DB, bot, 'how much does whitening cost');
  const payload = seen.payloads.find((p) => p && 'p_min_similarity' in p);
  eq('a known model brings its measured floor', payload.p_min_similarity, 0.60);
  eq('attributed to the model', out.effective.floor_source, 'model');
}

// ── Embedding-model drift (B2) ───────────────────────────────────
//
// Two 768-dimension models from different vendors pass every check this
// pipeline has and still occupy different embedding spaces, so a bot
// whose vendor was switched searched its own corpus with a ruler from
// another universe — silently, permanently. The gate has to fire on a
// mismatch and, just as importantly, NOT fire on an unknown stamp:
// every corpus indexed before 012 has one, and reading unknown as
// drifted would switch retrieval off across the whole platform.
console.log('\nEmbedding-model drift');
{
  const seen = stubFetch({ match: [row(0)] });
  const bot = evalBot();
  bot.embedding_model_indexed = 'text-embedding-004';
  const out = await retrieve(ENV, DB, bot, 'how much does whitening cost');
  eq('a corpus built by another model is not searched', out.skipped, 'stale-index');
  eq('and nothing is embedded to discover that', seen.embeddings, 0);
  eq('nor is the index queried', seen.match, 0);
  eq('the model that would have run is still reported',
     out.effective.embedding_model, 'stub-embed');
}
{
  const seen = stubFetch({ match: [row(0)] });
  const bot = evalBot();
  bot.embedding_model_indexed = 'stub-embed';
  const out = await retrieve(ENV, DB, bot, 'how much does whitening cost');
  eq('a matching stamp retrieves normally', out.channel, 'vector');
  eq('having embedded the query', seen.embeddings, 1);
}
{
  const seen = stubFetch({ match: [row(0)] });
  // No stamp at all — a corpus indexed before 012.
  const out = await retrieve(ENV, DB, evalBot(), 'how much does whitening cost');
  eq('an unknown stamp is not drift', out.skipped, undefined);
  eq('and retrieval proceeds', out.channel, 'vector');
  eq('embedding the query as usual', seen.embeddings, 1);
}

// ── Hybrid retrieval (M4) ────────────────────────────────────────
//
// RRF is pure, so it is tested directly rather than inferred from a
// stubbed search. The whole reason to fuse by RANK is that the two
// channels' scores are on different scales, so a test that asserted on
// scores would be testing the thing the design refuses to do.
console.log('\nReciprocal rank fusion');
{
  const c = (id) => ({ id, document_id: 'd1', ordinal: 0, content: id, similarity: 0.5 });
  // `b` is third in both channels; `a` is first in one and absent from
  // the other. Agreement has to win — that is what hybrid is for.
  const fused = fuseRRF([
    [c('a'), c('x'), c('b')],
    [c('y'), c('z'), c('b')],
  ]);
  eq('a chunk ranked mid-table by BOTH beats one ranked first by one', fused[0].id, 'b');
}
{
  const c = (id) => ({ id, document_id: 'd1', ordinal: 0, content: id, similarity: 0.5 });
  const only = [c('a'), c('b'), c('c')];
  const fused = fuseRRF([only]);
  eq('a single-channel input returns that channel unchanged',
     fused.map((x) => x.id).join(','), 'a,b,c');
}
{
  const c = (id) => ({ id, document_id: 'd1', ordinal: 0, content: id, similarity: 0.5 });
  // Two chunks each ranked first in one channel score identically.
  const fused = fuseRRF([[c('a'), c('b')], [c('b'), c('a')]]);
  eq('ties are broken by first appearance, so fusion is stable',
     fused.map((x) => x.id).join(','), 'a,b');
}
{
  const vector  = { id: 'a', document_id: 'd1', ordinal: 0, content: 'a', similarity: 0.81, channel: 'vector' };
  const lexical = { id: 'a', document_id: 'd1', ordinal: 0, content: 'a', similarity: 0.04, channel: 'lexical' };
  const fused = fuseRRF([[vector], [lexical]]);
  eq('the EARLIEST list wins the row, so a cosine survives fusion',
     fused[0].similarity, 0.81);
  eq('and the channel it came from with it', fused[0].channel, 'vector');
}
eq('fusing nothing yields nothing', fuseRRF([[], []]).length, 0);

console.log('\nHybrid mode');
{
  const seen = stubFetch({ match: [row(0), row(1)], lexical: [row(2)] });
  const out = await retrieve(ENV, DB, evalBot({ retrieval_mode: 'hybrid' }), 'how much does whitening cost');
  eq('both channels run on the same turn', `${seen.match},${seen.lexical}`, '1,1');
  eq('and the outcome reports the fused channel', out.channel, 'hybrid');
  eq('every chunk appears once', out.chunks.length, 3);
  check('each chunk still records the channel that FOUND it',
        out.chunks.every((c) => c.channel === 'vector' || c.channel === 'lexical'),
        JSON.stringify(out.chunks.map((c) => c.channel)));
}
{
  const seen = stubFetch({ match: [row(0)], lexical: [row(1)] });
  await retrieve(ENV, DB, evalBot({ retrieval_mode: 'hybrid' }), 'how much does whitening cost');
  const lex = seen.payloads.find((p) => p && 'p_query_text' in p);
  // The migration exists for this one number. At 1 the lexical channel
  // cannot reach a prose chunk, which is the entire case hybrid is for.
  eq('hybrid asks the lexical index for the WHOLE corpus', lex.p_min_priority, 0);
}
{
  const seen = stubFetch({ match: [], lexical: [row(0)] });
  await retrieve(ENV, DB, evalBot(), 'do u take insurance');
  const lex = seen.payloads.find((p) => p && 'p_query_text' in p);
  eq('the fallback still asks for curated chunks only', lex.p_min_priority, 1);
}
{
  const seen = stubFetch({ match: [], lexical: [row(0)] });
  const out = await retrieve(ENV, DB, evalBot({ retrieval_mode: 'vector' }), 'do u take insurance');
  eq('vector-only mode never consults the lexical index', seen.lexical, 0);
  eq('and a miss stays a miss', out.chunks.length, 0);
}
{
  const seen = stubFetch({ match: [], lexical: [] });
  const out = await retrieve(ENV, DB, evalBot({ retrieval_mode: 'hybrid' }), 'what is the weather in Oslo');
  // The state three shipped features are gated on. Hybrid makes it
  // rarer; it must not make it unreachable.
  eq('hybrid with nothing in either channel is still a clean miss', out.chunks.length, 0);
  eq('with no channel to report', out.channel, undefined);
  eq('and no error', out.error, undefined);
}
{
  const seen = stubFetch({ match: [row(0)], lexical: [row(1)] });
  await retrieve(ENV, DB, evalBot({ retrieval_mode: 'nonsense' }), 'how much does whitening cost');
  eq('an unrecognised mode decays to the default rather than throwing', seen.lexical, 0);
}

// ── Cross-encoder re-ranking (M5) ────────────────────────────────
//
// Two properties, and the second matters more than the first: the
// binding is a property of the DEPLOYMENT, not of the tenant, so a bot
// with rerank on may be running somewhere that cannot do it. It may
// never fail the visitor's turn.
console.log('\nRe-ranking');
{
  eq('the response is read as candidate indices, best first',
     rerankOrder({ response: [{ id: 2, score: 0.9 }, { id: 0, score: 0.4 }] }, 3).join(','), '2,0');
  eq('an out-of-range index is dropped, not thrown',
     rerankOrder({ response: [{ id: 9 }, { id: 1 }] }, 3).join(','), '1');
  eq('a repeated index is dropped, so no excerpt is duplicated',
     rerankOrder({ response: [{ id: 1 }, { id: 1 }, { id: 0 }] }, 3).join(','), '1,0');
  eq('a shape nothing recognises reads as "keep cosine order"',
     rerankOrder({ nope: true }, 3).length, 0);
  eq('and so does a non-object', rerankOrder(null, 3).length, 0);
}
{
  const seen = stubFetch({ match: [row(0), row(1), row(2)] });
  const env = { AI: { run: async () => ({ response: [{ id: 2 }, { id: 0 }, { id: 1 }] }) } };
  const out = await retrieve(env, DB, evalBot({ rerank: true }), 'how much does whitening cost');
  eq('the re-ranker decides the order', out.chunks.map((c) => c.id).join(','), 'c2,c0,c1');
  const payload = seen.payloads.find((p) => p && 'p_match_count' in p);
  // match_chunks over-fetches internally and truncates before
  // returning, so the only way to give a cross-encoder candidates is
  // to ask for more rows. Nothing in SQL changes for this.
  eq('and candidates are over-fetched to give it something to reorder',
     payload.p_match_count, 20);
}
{
  stubFetch({ match: [row(0), row(1), row(2)] });
  // No AI binding: the deployment cannot re-rank, and that is not the
  // tenant's fault and not a reason to fail the turn.
  const out = await retrieve({}, DB, evalBot({ rerank: true }), 'how much does whitening cost');
  eq('an absent binding falls back to cosine order',
     out.chunks.map((c) => c.id).join(','), 'c0,c1,c2');
  eq('without an error', out.error, undefined);
}
{
  stubFetch({ match: [row(0), row(1), row(2)] });
  const env = { AI: { run: async () => { throw new Error('model unavailable'); } } };
  const out = await retrieve(env, DB, evalBot({ rerank: true }), 'how much does whitening cost');
  eq('a re-rank that throws falls back to cosine order',
     out.chunks.map((c) => c.id).join(','), 'c0,c1,c2');
  eq('and the turn still succeeds', out.channel, 'vector');
}
{
  stubFetch({ match: [row(0), row(1), row(2)] });
  const env = { AI: { run: async () => ({ response: [{ id: 2 }, { id: 1 }] }) } };
  const out = await retrieve(env, DB, evalBot({ rerank: true, top_k: 2 }), 'how much does whitening cost');
  eq('the result is cut to top_k, never left at the over-fetch', out.chunks.length, 2);
}
{
  const seen = stubFetch({ match: [row(0)] });
  await retrieve(ENV, DB, evalBot(), 'how much does whitening cost');
  const payload = seen.payloads.find((p) => p && 'p_match_count' in p);
  eq('with re-rank off, nothing is over-fetched', payload.p_match_count, 5);
}

// ── What gets logged (M1) ────────────────────────────────────────
//
// Pure, so it is checked directly rather than through the chat handler.
// Both failure modes here corrupt the one number the report exists to
// produce: logging only misses removes the denominator, and logging
// skipped turns inflates the numerator with turns nobody expected an
// answer to.
console.log('\nRetrieval logging');
const logArgs = { botId: 'bot-1', sessionId: 's1', query: 'Do you do implants?', renderedCount: 2 };
{
  const outcome = { chunks: [row(0), row(1)], channel: 'vector', effective: { min_similarity: 0.6, embedding_model: 'stub-embed' } };
  const logged = retrievalLogRow(outcome, logArgs);
  eq('a hit is logged as matched', logged.matched, true);
  eq('with the channel that answered', logged.channel, 'vector');
  eq('and the top score retrieval returned', logged.top_score, 0.9);
  eq('the floor that ran is recorded beside it', logged.min_similarity, 0.6);
  eq('as is the model', logged.embedding_model, 'stub-embed');
  eq('the query is stored verbatim', logged.query, 'Do you do implants?');
  eq('chunk_count is what the model was shown', logged.chunk_count, 2);
}
{
  const outcome = { chunks: [], effective: { min_similarity: 0.6, embedding_model: 'stub-embed' } };
  const logged = retrievalLogRow(outcome, { ...logArgs, renderedCount: 0 });
  eq('a miss is logged too — it is the denominator', logged.matched, false);
  eq('with no channel', logged.channel, null);
  eq('and no score', logged.top_score, null);
}
for (const skipped of ['disabled', 'empty-query', 'stale-index']) {
  const logged = retrievalLogRow({ chunks: [], skipped }, logArgs);
  eq(`a '${skipped}' turn logs nothing at all`, logged, null);
}
{
  eq('and neither does a turn where retrieval never ran',
     retrievalLogRow(null, logArgs), null);
}
{
  // Chunks came back and the budget dropped every one of them. Not the
  // same failure as finding nothing, and the report tells them apart.
  const outcome = { chunks: [row(0)], channel: 'vector', effective: { min_similarity: 0.6, embedding_model: 'e' } };
  const logged = retrievalLogRow(outcome, { ...logArgs, renderedCount: 0 });
  eq('a dropped-by-budget turn is a miss', logged.matched, false);
  eq('but keeps the score that was found', logged.top_score, 0.9);
}

// ── The re-index claim (B4) ──────────────────────────────────────
//
// The stub models PostgREST's conditional PATCH rather than
// short-circuiting it, because the thing that can be wrong here is the
// URL the Worker builds — an `or=` filter that never matches would
// claim nothing and an always-matching one would claim everything, and
// both look identical from inside claimDocument.
console.log('\nThe re-index claim');

function stubDocuments(row) {
  const doc = { ...row };
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (init?.method !== 'PATCH') throw new Error(`unexpected fetch: ${path}`);

    const or = /or=\(([^)]*)\)/.exec(decodeURIComponent(path));
    // No conditional filter: an unconditional write, not a claim.
    if (!or) throw new Error(`claim without an or= filter: ${path}`);

    const cutoff = /ingest_started_at\.lt\.([^,)]+)/.exec(or[1])?.[1];
    const free = doc.ingest_started_at === null
      || (cutoff !== undefined && doc.ingest_started_at < cutoff);

    if (!free) return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });

    doc.ingest_started_at = JSON.parse(init.body).ingest_started_at;
    return new Response(JSON.stringify([{ id: doc.id }]), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  return doc;
}

const STALE_MS = 10 * 60_000;
{
  const doc = stubDocuments({ id: 'd1', ingest_started_at: null });
  eq('an unclaimed document can be claimed', await claimDocument(DB, 'd1', STALE_MS), true);
  check('and the claim is stamped', typeof doc.ingest_started_at === 'string');
  eq('a second claim inside the window is refused',
     await claimDocument(DB, 'd1', STALE_MS), false);
}
{
  // A Worker that died mid-waitUntil leaves a claim nobody will
  // release. Without a stale window the document is unindexable
  // forever, which is a worse failure than the double index.
  const old = new Date(Date.now() - 11 * 60_000).toISOString();
  stubDocuments({ id: 'd2', ingest_started_at: old });
  eq('an abandoned claim is reclaimable',
     await claimDocument(DB, 'd2', STALE_MS), true);
}

// ── Ingest retry with backoff (B5) ───────────────────────────────
//
// The schedule, the vendor's own answer, and the cap are three separate
// decisions and each can be wrong on its own — so the delay is tested
// as a pure function rather than by waiting for it.
console.log('\nIngest retry');
eq('the first retry waits a second', retryDelayMs(1, null), 1000);
eq('then two', retryDelayMs(2, null), 2000);
eq('then four', retryDelayMs(3, null), 4000);
eq("the vendor's own answer wins over the schedule", retryDelayMs(1, 5), 5000);
eq('but is still capped', retryDelayMs(1, 3600), 10_000);
eq('and so is the schedule', retryDelayMs(9, null), 10_000);
eq('a zero from the vendor is honoured, not treated as absent', retryDelayMs(2, 0), 0);

eq('Retry-After in seconds parses', parseRetryAfter('30'), 30);
eq('whitespace is tolerated', parseRetryAfter(' 30 '), 30);
eq('an absent header is absent, not zero', parseRetryAfter(null), null);
eq('and so is nonsense', parseRetryAfter('soon'), null);
check('an HTTP date parses to a positive delay',
      parseRetryAfter(new Date(Date.now() + 20_000).toUTCString()) > 15);
eq('a date in the past clamps to now',
   parseRetryAfter(new Date(Date.now() - 60_000).toUTCString()), 0);

/**
 * Run the real ingestDocument against a stubbed PostgREST and a stubbed
 * embedding vendor, and report what it did.
 *
 * Through the real function rather than a reimplementation, for the
 * reason the retrieval tests above give: the claim, the retry, the
 * release and the stamp are four things that have to happen in the
 * right order relative to each other, and a stub of the middle proves
 * nothing about the order.
 *
 * @param embedFailures Responses to serve before the successful one.
 */
async function runIngest({ embedFailures = [], claimed = false } = {}) {
  const seen = { embeddings: 0, status: [], released: false, stamped: null, error: null, threw: null };
  const failures = [...embedFailures];
  let claimHeld = claimed;

  const json = (data) => new Response(JSON.stringify(data), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  // `null` body, not '': 204 is a null-body status and undici's
  // Response constructor rejects a string one outright.
  const empty = () => new Response(null, { status: 204 });

  globalThis.fetch = async (url, init) => {
    const path = decodeURIComponent(String(url));
    const body = init?.body ? JSON.parse(init.body) : null;

    if (path.endsWith('/embeddings')) {
      seen.embeddings++;
      const fail = failures.shift();
      if (fail) {
        return new Response('vendor said no', {
          status: fail.status,
          headers: fail.retryAfter === undefined ? {} : { 'Retry-After': fail.retryAfter },
        });
      }
      return json({ data: [{ index: 0, embedding: Array(768).fill(0.1) }], model: 'stub-embed' });
    }

    // The claim, checked before the generic document PATCH below —
    // both target /documents and only the `or=` filter tells them apart.
    if (path.includes('or=(')) {
      if (claimHeld) return json([]);
      claimHeld = true;
      return json([{ id: 'd1' }]);
    }

    if (path.includes('/documents?select=*')) {
      return json([{
        id: 'd1', bot_id: 'bot-1', org_id: 'o1', source: 'text', title: 'Pricing',
        url: null, content: 'Whitening costs 250 pounds. Implants start at 1800.',
        status: 'pending', error: null, chunk_count: 0,
        embedding_model: null, embedding_dimensions: null,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        ingest_started_at: null,
      }]);
    }

    if (path.includes('/documents?id=eq.')) {
      if (body.status) seen.status.push(body.status);
      if (body.error) seen.error = body.error;
      if (body.ingest_started_at === null) seen.released = true;
      return empty();
    }

    if (path.includes('/bots?id=eq.')) { seen.stamped = body.embedding_model_indexed; return empty(); }
    if (path.includes('/chunks'))      return empty();

    throw new Error(`unexpected fetch: ${path}`);
  };

  try {
    await ingestDocument(ENV, DB, 'd1', evalBot());
  } catch (err) {
    seen.threw = err.name;
  }
  return seen;
}

// The whole path, through the real ingestDocument: claim, retry,
// release and stamp. What matters is that a transient 429 does NOT
// discard the run — the failure the file's own header claimed to
// survive and did not.
{
  const seen = await runIngest({ embedFailures: [{ status: 429, retryAfter: '0' }] });
  eq('a 429 then a 200 embeds in two attempts', seen.embeddings, 2);
  eq('and the document ends ready', seen.status.at(-1), 'ready');
  check('with the claim released', seen.released === true);
  eq('and the corpus stamped with the model that built it',
     seen.stamped, 'stub-embed');
}
{
  const seen = await runIngest({ embedFailures: [{ status: 400 }] });
  eq('a 400 fails on the first attempt', seen.embeddings, 1);
  eq('and the document is marked failed', seen.status.at(-1), 'failed');
  check('with the claim released even so', seen.released === true);
  check("the vendor's own reason survives", /HTTP 400/.test(seen.error ?? ''), seen.error);
  check('unwrapped, because it was not a retry exhaustion',
        !/attempt/.test(seen.error ?? ''), seen.error);
}
{
  const seen = await runIngest({ embedFailures: [{ status: 429, retryAfter: '0' }, { status: 429, retryAfter: '0' }, { status: 429, retryAfter: '0' }] });
  eq('three failures exhaust the attempts', seen.embeddings, 3);
  eq('and the document fails', seen.status.at(-1), 'failed');
  check('naming the batch, so "throttled" reads differently from "broken"',
        /batch 1 of 1/.test(seen.error ?? ''), seen.error);
}
{
  const seen = await runIngest({ claimed: true });
  eq('a document already claimed is refused', seen.threw, 'AlreadyIndexing');
  eq('and its status is left exactly as the other run set it', seen.status.length, 0);
}

globalThis.fetch = realFetch;

// ── Citation alignment ───────────────────────────────────────────
//
// The prompt numbers its excerpts [1] [2] [3]; the citation list has to
// name those same excerpts in that same order. Building the list from
// the full result set could name a document the budget had dropped.
console.log('\nCitation alignment');
{
  const chunks = [chunk(0, 300), chunk(1, 300), chunk(2, 300)];
  const kept = selectContext(chunks, 10_000);
  eq('an ample budget selects everything', kept.length, 3);
  check('in rank order', kept.map((c) => c.id).join(',') === 'c0,c1,c2');
}
{
  const chunks = [chunk(0, 400), chunk(1, 400), chunk(2, 400)];
  const budget = 1000;
  const kept = selectContext(chunks, budget);
  const out = renderContext(chunks, budget);
  const markers = (out.match(/^\[\d+\] /gm) ?? []).length;
  eq('selection and rendering agree on how many survive', kept.length, markers);
  check('the dropped chunk is absent from both',
        !out.includes('2x') && !kept.some((c) => c.id === 'c2'));
}
{
  // The bug B6 fixes, in miniature: a citation list built from the full
  // result set would have three entries where the prompt has two.
  const chunks = [chunk(0, 400), chunk(1, 400), chunk(2, 400)];
  const kept = selectContext(chunks, 1000);
  check('a citation list built from the selection cannot outrun the markers',
        kept.length < chunks.length, `${kept.length} of ${chunks.length}`);
}
{
  const blank = { ...chunk(1, 1), content: '   ' };
  const kept = selectContext([chunk(0, 100), blank, chunk(2, 100)], 10_000);
  eq('a whitespace-only chunk consumes no marker', kept.length, 2);
  check('and is not the one kept', !kept.some((c) => c.id === 'c1'));
}
{
  // Re-selecting an already-selected list must be a no-op, because the
  // chat path renders what it selected.
  const chunks = [chunk(0, 400), chunk(1, 400), chunk(2, 400)];
  const once = selectContext(chunks, 1000);
  const twice = selectContext(once, 1000);
  eq('selection is idempotent', twice.length, once.length);
  eq('rendering a selection re-budgets nothing',
     renderContext(once, 1000), renderContext(chunks, 1000));
}

// ── Near-duplicate suppression (M8) ──────────────────────────────
//
// THE ADJACENT-CHUNK CASE IS THE ONE THAT MATTERS. chunkText prepends
// chunk_overlap characters of the previous chunk into every chunk, so
// two consecutive chunks of one document ALWAYS share text and must
// not be deduped — they are different content. The headroom at the
// shipped defaults is comfortable, but chunk_size and chunk_overlap
// are both tenant-configurable, so the assertion is taken at the worst
// combination the clamps allow rather than at the defaults.
console.log('\nNear-duplicate suppression');
const dup = (id, content, similarity) => ({ id, document_id: 'd1', ordinal: 0, content, similarity });
const BOILERPLATE =
  'All treatments are subject to a clinical assessment and our standard terms of business, '
  + 'which are available on request from reception or from any member of our clinical team.';
{
  const out = dedupe([
    dup('a', BOILERPLATE, 0.81),
    dup('b', BOILERPLATE, 0.79),
    dup('c', 'Whitening costs one hundred and ninety nine pounds per session.', 0.77),
  ]);
  eq('the same paragraph twice survives once', out.length, 2);
  eq('and it is the HIGHER-ranked copy that is kept', out[0].id, 'a');
  eq('the distinct chunk is untouched', out[1].id, 'c');
}
{
  // The same boilerplate with a different sentence bolted on is not a
  // duplicate — it says something the first copy does not.
  const out = dedupe([
    dup('a', BOILERPLATE, 0.81),
    dup('b', `${BOILERPLATE} Emergency appointments are exempt and are seen the same day, `
           + 'with a separate out-of-hours charge that is quoted before any work begins.', 0.79),
  ]);
  eq('a longer passage that merely contains the boilerplate survives', out.length, 2);
}
{
  // A real chunkText run at the WORST tenant-configurable combination:
  // chunk_size clamped to its 200 floor, chunk_overlap clamped to
  // size/2. Every chunk after the first is then ~1/3 carried text —
  // the most overlap this platform can be configured to produce.
  //
  // THE PROSE HAS TO BE GENUINELY VARIED, and the first draft of this
  // test got that wrong: one sentence repeated makes adjacent chunks
  // real duplicates, and dedupe was right to collapse them. What is
  // being asserted is that CARRIED overlap does not read as duplication.
  const prose = Array.from({ length: 40 }, (_, i) =>
    `Section ${i} covers ${['whitening', 'implants', 'hygiene', 'orthodontics', 'emergency care'][i % 5]} `
    + `and was last reviewed in ${2000 + i} by the ${['clinical', 'reception', 'billing'][i % 3]} team, `
    + `who recorded ${i * 7} separate observations about it. `).join('');
  const pieces = chunkText(prose, { size: 200, overlap: 100 });
  check('the fixture actually produced adjacent chunks', pieces.length > 3, `got ${pieces.length}`);
  const worst = Math.max(...pieces.slice(1).map((p, i) => shingleOverlap(p, pieces[i])));
  check('adjacent chunks stay well below the threshold', worst < 0.8, `worst overlap ${worst.toFixed(3)}`);
  const kept = dedupe(pieces.map((content, i) => dup(`p${i}`, content, 1 - i / 100)));
  eq('so a real chunked document loses nothing to dedupe', kept.length, pieces.length);
}
{
  const out = dedupe([dup('a', BOILERPLATE, 0.81), dup('b', BOILERPLATE, 0.79)]);
  check('dedupe never empties a non-empty result', out.length >= 1, JSON.stringify(out));
}
eq('deduping nothing yields nothing', dedupe([]).length, 0);
eq('a single chunk is returned as-is', dedupe([dup('a', BOILERPLATE, 0.8)]).length, 1);
{
  eq('a chunk is identical to itself', shingleOverlap(BOILERPLATE, BOILERPLATE), 1);
  eq('unrelated prose overlaps not at all',
     shingleOverlap('Whitening costs 199 pounds.', 'Our car park is behind the building.'), 0);
  check('punctuation and case are not differences',
        shingleOverlap('Whitening costs one nine nine pounds', 'whitening COSTS one, nine, nine pounds!') === 1);
}
{
  // The dedupe has to happen BEFORE the budget is spent, or a dropped
  // duplicate frees its slot and not its characters.
  const long = BOILERPLATE.padEnd(900, ' filler words repeated here again and again');
  const kept = selectContext([
    dup('a', long, 0.9),
    dup('b', long, 0.85),
    dup('c', 'Whitening costs one hundred and ninety nine pounds per session.', 0.8),
  ], 1000);
  eq('a dropped duplicate frees its characters, not just its slot', kept.length, 2);
  eq('so the distinct chunk reaches the prompt', kept[1].id, 'c');
}
{
  const chunks = [dup('a', BOILERPLATE, 0.9), dup('b', BOILERPLATE, 0.85)];
  const once = selectContext(chunks, 10_000);
  eq('selection is still idempotent with dedupe in it',
     selectContext(once, 10_000).length, once.length);
}

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
