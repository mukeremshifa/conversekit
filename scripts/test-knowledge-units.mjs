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
    join(ROOT, 'src/rag/retrieve.ts'),
    join(ROOT, 'src/rag/ingest.ts'),
    join(ROOT, 'src/providers/catalog.ts'),
    join(ROOT, 'src/prompt.ts'),
    join(ROOT, 'src/config.ts'),
  ],
  outdir: OUT, format: 'esm', bundle: true, platform: 'neutral',
});

const { chunkQA, parseFaqText } = await import(`file://${OUT}/rag/chunk.js`);
const { renderContext, selectContext, retrieve, isTooShortToRetrieve } =
  await import(`file://${OUT}/rag/retrieve.js`);
const { ragConfigFor } = await import(`file://${OUT}/rag/ingest.js`);
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
