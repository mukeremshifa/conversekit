#!/usr/bin/env node
/**
 * Retrieval quality harness.
 *
 * WHY THIS EXISTS. Every threshold in ragConfigFor used to be a guess,
 * and nothing measured whether a change to the pipeline made retrieval
 * better or worse. That is how the similarity floor sat below the
 * embedding model's noise floor for four months: with the floor unable
 * to reject anything, retrieval never reported a miss, so it always
 * looked like it was working. See docs/rag-hardening.md, B1 and M2.
 *
 * WHAT IT DOES. Builds a disposable tenant, ingests a small committed
 * corpus, and runs a golden set of questions through the REAL retrieval
 * path — POST /v1/admin/bots/:id/retrieve-preview, the same endpoint
 * the dashboard's inspector uses, which in turn calls retrieve(). It
 * reimplements nothing: a harness that only approximately reproduces
 * production would measure the harness.
 *
 * NEGATIVES ARE THE ASSERTION THAT MATTERS. Recall@k rewards a floor of
 * zero. Off-topic questions returning nothing is what proves the floor
 * discriminates, and it is the check that fails on the pre-B1 default.
 *
 *   npm run eval:rag
 *   npm run eval:rag -- --vendor=google
 *   npm run eval:rag -- --sweep=0.3,0.4,0.5,0.55,0.6,0.65,0.7
 *
 * Needs a running Worker and a real Supabase project — embeddings are
 * the thing under test, so there is nothing to stub.
 *
 *   SUPABASE_URL=https://xxx.supabase.co \
 *   SUPABASE_ANON_KEY=eyJ... \
 *   SUPABASE_SERVICE_ROLE_KEY=eyJ... \
 *   WORKER_URL=http://localhost:8787 \
 *   npm run eval:rag
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname } from 'node:path';
import { createHarness } from './lib/testenv.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL = join(HERE, 'eval');

const {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  WORKER_URL = 'http://localhost:8787',
} = process.env;

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY })) {
  if (!v) { console.error(`Missing ${k}`); process.exit(2); }
}

// ── Arguments ────────────────────────────────────────────────────
const args = new Map(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => { const i = a.indexOf('='); return i === -1 ? [a.slice(2), true] : [a.slice(2, i), a.slice(i + 1)]; }),
);

const VENDOR = args.get('vendor') ?? 'workers-ai';
const MODEL  = typeof args.get('model') === 'string' ? args.get('model') : undefined;
const TOP_K  = Number(args.get('top-k') ?? 5);
const KEEP   = args.has('keep');

/**
 * A floor sweep runs the queries ONCE with the floor at zero and then
 * filters the returned scores client-side for each candidate. That is
 * exactly what match_chunks does — its floor is a predicate on raw
 * similarity applied after the over-fetch — so simulating it costs one
 * pass instead of one pass per candidate, and every candidate is scored
 * against identical embeddings rather than against its own run.
 */
const SWEEP = typeof args.get('sweep') === 'string'
  ? args.get('sweep').split(',').map(Number).filter((n) => Number.isFinite(n))
  : null;

const golden = JSON.parse(readFileSync(join(EVAL, 'golden.json'), 'utf8'));

/** pricing.md becomes "Pricing", which is what golden.json's
 *  expect_doc matches against. Single-word filenames on purpose — a
 *  title-casing rule is one more thing for the fixture to disagree with
 *  the golden set about. */
function titleFor(file) {
  const name = basename(file, extname(file));
  return name[0].toUpperCase() + name.slice(1);
}

const corpus = readdirSync(join(EVAL, 'corpus'))
  .filter((f) => f.endsWith('.md'))
  .map((f) => ({ title: titleFor(f), content: readFileSync(join(EVAL, 'corpus', f), 'utf8') }));

const h = createHarness({
  supabaseUrl: SUPABASE_URL,
  anonKey: SUPABASE_ANON_KEY,
  serviceKey: SUPABASE_SERVICE_ROLE_KEY,
  workerUrl: WORKER_URL,
});

const fmt = (n) => (Number.isFinite(n) ? n.toFixed(3) : '  —  ');
const pct = (n) => `${(n * 100).toFixed(1)}%`;

function stats(values) {
  if (!values.length) return { n: 0, min: NaN, mean: NaN, max: NaN };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    min: sorted[0],
    mean: values.reduce((a, b) => a + b, 0) / values.length,
    max: sorted[sorted.length - 1],
  };
}

/** Whitespace-insensitive, because the corpus is hard-wrapped and the
 *  chunker reflows: "8am to
4pm" in the source is one phrase, and a
 *  fixture that broke on where a line happened to end would be testing
 *  the text editor. */
const flat = (s) => String(s).toLowerCase().replace(/s+/g, ' ');

/** Did this result set contain the passage the question is asking for? */
function hitIndex(chunks, expect) {
  const needle = flat(expect.expect_contains);
  return chunks.findIndex((ch) =>
    ch.document_title === expect.expect_doc && flat(ch.content).includes(needle));
}

async function main() {
  console.log(`\nRetrieval eval — Worker at ${WORKER_URL}, vendor ${VENDOR}${MODEL ? `, model ${MODEL}` : ''}`);
  if (SWEEP) console.log(`Floor sweep: ${SWEEP.join(', ')} (queries run once at floor 0)\n`);
  else console.log('');

  const tenant = await h.newTenant('eval');

  // chunk_size well below the 800 default: the committed corpus is
  // deliberately small, and at the default it yields six chunks across
  // three documents — where returning five of them scores near-perfect
  // recall without ranking anything. Twelve chunks makes recall@5 a
  // measurement rather than a formality.
  //
  // A sweep additionally needs the raw ranking, so the floor comes off
  // and top_k goes deep enough for a candidate floor to have something
  // to reject.
  const rag = {
    chunk_size: 300,
    chunk_overlap: 60,
    ...(SWEEP ? { top_k: Math.max(TOP_K, 10), min_similarity: 0 } : { top_k: TOP_K }),
  };

  const created = await h.call('/v1/admin/bots', {
    token: tenant.token, method: 'POST',
    body: {
      org_id: tenant.orgId,
      name: 'RAG eval',
      business_name: 'Marchmont Street Dental',
      embedding_config: { vendor: VENDOR, ...(MODEL ? { model: MODEL } : {}) },
      rag_config: rag,
    },
  });
  if (created.status !== 201) throw new Error(`bot create failed: ${created.status} ${created.text.slice(0, 300)}`);
  const botId = created.json.id;

  // ── Ingest ─────────────────────────────────────────────────────
  const docIds = [];
  for (const doc of corpus) {
    const r = await h.call(`/v1/admin/bots/${botId}/documents`, {
      token: tenant.token, method: 'POST',
      body: { source: 'markdown', title: doc.title, content: doc.content },
    });
    if (r.status !== 202) throw new Error(`document create failed: ${r.status} ${r.text.slice(0, 300)}`);
    docIds.push(r.json.id);
  }

  // Ingestion runs in waitUntil, so the route returned before any
  // embedding happened. Poll only the ids we created — a bot also has
  // an FAQ document, which has nothing in it and never leaves pending.
  process.stdout.write(`Indexing ${docIds.length} documents`);
  const deadline = Date.now() + 180_000;
  let ready = [];
  for (;;) {
    const list = await h.call(`/v1/admin/bots/${botId}/documents`, { token: tenant.token });
    const mine = (list.json?.documents ?? []).filter((d) => docIds.includes(d.id));
    const failed = mine.filter((d) => d.status === 'failed');
    if (failed.length) throw new Error(`ingestion failed: ${failed.map((d) => `${d.title}: ${d.error}`).join('; ')}`);
    ready = mine.filter((d) => d.status === 'ready');
    if (ready.length === docIds.length) break;
    if (Date.now() > deadline) throw new Error(`ingestion timed out — ${ready.length}/${docIds.length} ready`);
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 2000));
  }
  const chunkTotal = ready.reduce((a, d) => a + (d.chunk_count ?? 0), 0);
  console.log(` ok — ${chunkTotal} chunks\n`);

  // ── Run the golden set ─────────────────────────────────────────
  const ask = async (query) => {
    const r = await h.call(`/v1/admin/bots/${botId}/retrieve-preview`, {
      token: tenant.token, method: 'POST', body: { query },
    });
    if (r.status !== 200) throw new Error(`preview failed for "${query}": ${r.status} ${r.text.slice(0, 300)}`);
    return r.json;
  };

  const positives = [];
  for (const c of golden.positives) {
    const res = await ask(c.query);
    positives.push({ ...c, res, rank: hitIndex(res.chunks, c) });
  }

  const negatives = [];
  for (const c of golden.negatives) {
    const res = await ask(c.query);
    negatives.push({ ...c, res });
  }

  const effective = positives[0]?.res?.effective ?? null;
  if (effective) {
    console.log(`Embedder : ${effective.embedding_model}`);
    console.log(`Floor    : ${fmt(effective.min_similarity)} (source: ${effective.floor_source})`);
    if (effective.floor_source === 'default') {
      console.log('           ^ UNMEASURED fallback — this run is what replaces it');
    }
    console.log('');
  }

  let failures = 0;

  if (SWEEP) {
    failures += reportSweep(positives, negatives);
  } else {
    failures += reportRun(positives, negatives);
  }

  if (KEEP) console.log(`\n--keep: bot ${botId} left in place under org ${tenant.orgId}`);
  return failures;
}

/**
 * The straight report: did retrieval find the right passage, and did it
 * refuse the questions it has no business answering.
 */
function reportRun(positives, negatives) {
  let failures = 0;

  console.log('Positives — did the expected passage come back?');
  for (const p of positives) {
    const top = p.res.chunks[0]?.score;
    const mark = p.rank === -1 ? 'MISS' : `#${p.rank + 1}  `;
    if (p.rank === -1) failures++;
    console.log(`  ${mark} ${fmt(top)}  ${p.res.channel ?? p.res.skipped ?? 'none'}  ${p.query}`);
  }

  console.log('\nNegatives — off-topic questions must return nothing');
  for (const n of negatives) {
    const got = n.res.chunks.length;
    if (got > 0) failures++;
    const top = n.res.chunks[0]?.score;
    console.log(`  ${got === 0 ? 'ok  ' : 'LEAK'} ${fmt(top)}  ${got} chunk(s)  ${n.query}`);
  }

  const hits = positives.filter((p) => p.rank !== -1);
  const recall = hits.length / positives.length;
  const mrr = positives.reduce((a, p) => a + (p.rank === -1 ? 0 : 1 / (p.rank + 1)), 0) / positives.length;
  const rejection = negatives.filter((n) => n.res.chunks.length === 0).length / negatives.length;

  const hitScores  = hits.map((p) => p.res.chunks[p.rank].score);
  const leakScores = negatives.flatMap((n) => n.res.chunks.map((ch) => ch.score));

  const s1 = stats(hitScores);
  const s2 = stats(leakScores);

  console.log('\nScore distribution');
  console.log(`  expected passages : n=${s1.n}  min ${fmt(s1.min)}  mean ${fmt(s1.mean)}  max ${fmt(s1.max)}`);
  console.log(`  off-topic leaks   : n=${s2.n}  min ${fmt(s2.min)}  mean ${fmt(s2.mean)}  max ${fmt(s2.max)}`);
  if (s1.n && s2.n) {
    // The number a floor should sit inside. A negative gap means no
    // single threshold separates them and the problem is the model or
    // the chunking, not the floor.
    console.log(`  separation        : ${fmt(s2.max)} … ${fmt(s1.min)}${s1.min > s2.max ? '' : '   (OVERLAP — no floor separates these)'}`);
  }

  const t = golden.thresholds;
  console.log('\nSummary');
  console.log(`  recall@k           ${pct(recall)}   (threshold ${pct(t.recall_at_k)})`);
  console.log(`  MRR                ${fmt(mrr)}`);
  console.log(`  negative rejection ${pct(rejection)}   (threshold ${pct(t.negative_rejection)})`);

  let thresholdFailures = 0;
  if (recall < t.recall_at_k) { console.log('  FAIL recall below threshold'); thresholdFailures++; }
  if (rejection < t.negative_rejection) { console.log('  FAIL negative rejection below threshold'); thresholdFailures++; }

  console.log(thresholdFailures === 0
    ? `\nRetrieval eval passed. ${failures} individual case(s) off.\n`
    : `\nRetrieval eval FAILED.\n`);

  return thresholdFailures;
}

/**
 * The sweep: recall and rejection at each candidate floor, computed
 * from one set of embeddings. This is what produces the number that
 * goes into catalog.ts.
 */
function reportSweep(positives, negatives) {
  console.log('Floor    recall@k   rejection   verdict');
  const rows = [];
  for (const floor of SWEEP) {
    const kept = (chunks) => chunks.filter((ch) => ch.score >= floor);
    const recall = positives.filter((p) => {
      const c = kept(p.res.chunks);
      return hitIndex(c, p) !== -1;
    }).length / positives.length;
    const rejection = negatives.filter((n) => kept(n.res.chunks).length === 0).length / negatives.length;
    rows.push({ floor, recall, rejection });

    const ok = recall >= golden.thresholds.recall_at_k && rejection >= golden.thresholds.negative_rejection;
    console.log(`  ${fmt(floor)}   ${pct(recall).padStart(6)}     ${pct(rejection).padStart(6)}     ${ok ? 'PASSES BOTH' : ''}`);
  }

  const viable = rows.filter((r) =>
    r.recall >= golden.thresholds.recall_at_k && r.rejection >= golden.thresholds.negative_rejection);

  if (viable.length) {
    // The midpoint of the viable band, not its edge: a floor sitting on
    // the boundary is one unlucky embedding away from being wrong.
    const lo = viable[0].floor;
    const hi = viable[viable.length - 1].floor;
    console.log(`\n  Viable band: ${fmt(lo)} … ${fmt(hi)}`);
    console.log(`  Suggested similarityFloor: ${fmt((lo + hi) / 2)}`);
    console.log('  Put it in src/providers/catalog.ts — MODEL_FLOORS if the model is');
    console.log('  served by more than one vendor, the preset otherwise.\n');
    return 0;
  }

  console.log('\n  No candidate floor satisfies both thresholds. Either the corpus needs');
  console.log('  better chunking, or this embedding model cannot separate these cases.\n');
  return 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(`\n${err.message}\n`);
  code = 2;
} finally {
  if (!KEEP) await h.teardown();
}
process.exit(code === 0 ? 0 : 1);
