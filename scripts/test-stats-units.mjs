#!/usr/bin/env node
/**
 * Unit tests for the overview aggregates.
 *
 * Day bucketing is the reason this file exists: an off-by-one puts every
 * chart a day out, and nothing in the UI would show it. No network, no
 * database — buildStats is pure over rows the caller supplies.
 *
 *   npm run test:stats
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = mkdtempSync(join(tmpdir(), 'ck-stats-'));

await build({
  entryPoints: [join(ROOT, 'src/stats.ts')],
  outdir: OUT, format: 'esm', bundle: true, platform: 'neutral',
});
const { buildStats, buildMissReport, dayKey } = await import(`file://${OUT}/stats.js`);

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const eq = (label, actual, expected) =>
  check(label, Object.is(actual, expected), `expected ${expected}, got ${actual}`);

// A fixed "now" so the buckets are deterministic.
const NOW = new Date('2026-08-11T14:30:00.000Z');
const day = (n) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const msg = (role, content, daysAgo, session = 's1') =>
  ({ session_id: session, role, content, created_at: day(daysAgo) });

const run = (over = {}) => buildStats({
  days: 7, now: NOW, messages: [], leads: [], documents: [],
  caps: { messages: 4000, leads: 1000 }, ...over,
});

console.log('\nWindow and bucketing');
{
  const s = run();
  eq('a 7-day window is 7 buckets', s.series.length, 7);
  eq('last bucket is today', s.series[6].date, '2026-08-11');
  eq('first bucket is 6 days back, not 7', s.series[0].date, '2026-08-05');
  check('empty days are present rather than collapsed',
    s.series.every((p) => p.visitor === 0 && p.sessions === 0));
}
{
  const s = run({ days: 30 });
  eq('a 30-day window is 30 buckets', s.series.length, 30);
}
eq('dayKey trims an ISO timestamp to its date', dayKey('2026-08-11T23:59:59.999Z'), '2026-08-11');

console.log('\nCounting');
{
  const s = run({
    messages: [
      msg('user', 'How much?', 0), msg('assistant', 'It is free.', 0),
      msg('user', 'Which models?', 1, 's2'), msg('assistant', 'Eleven.', 1, 's2'),
    ],
    leads: [{ created_at: day(0), session_id: 's1' }],
  });
  eq('visitor messages counted', s.totals.visitorMessages, 2);
  eq('assistant messages counted', s.totals.assistantMessages, 2);
  eq('total messages', s.totals.messages, 4);
  eq('distinct sessions', s.totals.sessions, 2);
  eq('leads', s.totals.leads, 1);
  eq('conversion rate is leads over sessions', s.totals.conversionRate, 0.5);
  eq('turns per session', s.totals.turnsPerSession, 1);
  eq("today's bucket has today's messages", s.series[6].visitor, 1);
  eq("yesterday's bucket has yesterday's", s.series[5].visitor, 1);
}

console.log('\nSessions attach to their first day');
{
  // One session spanning two days must count once, on the earlier day.
  const s = run({
    messages: [msg('user', 'a', 2, 'sx'), msg('user', 'b', 1, 'sx'), msg('user', 'c', 0, 'sx')],
  });
  eq('counted once overall', s.totals.sessions, 1);
  eq('attributed to the first day seen', s.series[4].sessions, 1);
  eq('not double-counted on later days', s.series[5].sessions + s.series[6].sessions, 0);
}

console.log('\nThe comparison window');
{
  const s = run({
    messages: [msg('user', 'now', 0, 'a'), msg('user', 'before', 9, 'b')],
    leads: [{ created_at: day(0), session_id: 'a' }, { created_at: day(9), session_id: 'b' }],
  });
  eq('current window excludes older rows', s.totals.messages, 1);
  eq('older rows land in the previous window', s.previous.messages, 1);
  eq('current leads', s.totals.leads, 1);
  eq('previous leads', s.previous.leads, 1);
  eq('previous sessions', s.previous.sessions, 1);
}

console.log('\nTop questions');
{
  const s = run({
    messages: [
      msg('user', 'What are your hours?', 0),
      msg('user', 'what are your HOURS', 1),
      msg('user', '  What are your hours?  ', 2),
      msg('user', 'Do you ship?', 0),
      msg('assistant', 'What are your hours?', 0),   // must not be counted
      msg('user', 'ok', 0),                          // too short to be a question
    ],
  });
  eq('groups case, spacing and trailing punctuation', s.topQuestions[0].count, 3);
  check('keeps the first spelling seen', s.topQuestions[0].text === 'What are your hours?',
    `got ${JSON.stringify(s.topQuestions[0].text)}`);
  check('assistant turns are excluded', s.topQuestions.every((q) => q.count <= 3));
  eq('a distinct question is its own entry', s.topQuestions[1].count, 1);
  check('very short turns are dropped', !s.topQuestions.some((q) => q.text === 'ok'));
}

console.log('\nDocuments and edge cases');
{
  const s = run({
    documents: [
      { status: 'ready', chunk_count: 12 }, { status: 'ready', chunk_count: 8 },
      { status: 'failed', chunk_count: 0 }, { status: 'processing', chunk_count: 0 },
    ],
  });
  eq('documents counted', s.totals.documents, 4);
  eq('ready', s.totals.documentsReady, 2);
  eq('failed', s.totals.documentsFailed, 1);
  eq('pending covers pending and processing', s.totals.documentsPending, 1);
  eq('chunks summed', s.totals.chunks, 20);
}
{
  const s = run();
  eq('conversion rate is null with no sessions, not NaN', s.totals.conversionRate, null);
  eq('turns per session is null with no sessions', s.totals.turnsPerSession, null);
}
{
  const many = Array.from({ length: 10 }, (_, i) => msg('user', 'q' + i, 0, 's' + i));
  const s = run({ messages: many, caps: { messages: 10, leads: 1000 } });
  check('reports truncation when the row cap is hit', s.truncated.messages === true);
}

// ── The miss report ──────────────────────────────────────────────
//
// The report a tenant reads to find out what to write next, and the
// only continuous measurement of whether the similarity floor is in the
// right place. Both halves are aggregates over rows, which is the class
// of thing that looks right in the UI while being quietly wrong — the
// same reason buildStats is tested above.

const log = (over = {}) => ({
  query: 'What are your hours?',
  matched: true,
  channel: 'vector',
  top_score: 0.71,
  chunk_count: 3,
  min_similarity: 0.6,
  embedding_model: '@cf/baai/bge-base-en-v1.5',
  created_at: day(0),
  ...over,
});

const miss = (query, daysAgo = 0, over = {}) =>
  log({ query, matched: false, channel: null, top_score: null, chunk_count: 0, created_at: day(daysAgo), ...over });

const report = (rows, over = {}) =>
  buildMissReport({ days: 7, now: NOW, rows, cap: 4000, ...over });

console.log('\nMiss report — totals and rate');
{
  const r = report([log(), log(), miss('Do you do implants?')]);
  eq('every logged turn is a query', r.totals.queries, 3);
  eq('misses counted', r.totals.misses, 1);
  eq('miss rate is misses over queries', r.totals.missRate, 1 / 3);
  eq('hits and misses share the denominator', r.channels.vector + r.channels.missed, 3);
}
{
  const r = report([]);
  eq('no traffic is an unknown rate, not zero', r.totals.missRate, null);
  eq('and no questions', r.questions.length, 0);
  eq('with no median to report', r.scores.hitMedian, null);
}
{
  // The window bound, which is the half of buildStats most likely to be
  // got wrong twice.
  const r = report([log(), miss('old one', 9)]);
  eq('rows older than the window are excluded', r.totals.queries, 1);
  eq('including from the question list', r.questions.length, 0);
}

console.log('\nMiss report — the questions');
{
  const r = report([
    miss('Do you do implants?', 0),
    miss('do you do IMPLANTS', 1),
    miss('  Do you do implants?  ', 2),
    miss('Do you take Bupa?', 1),
    log({ query: 'Do you do implants?' }),   // a HIT with the same text
    miss('no', 0),                           // too short to group
  ]);
  eq('grouped case, spacing and trailing punctuation', r.questions[0].count, 3);
  check('keeps the first spelling seen', r.questions[0].text === 'Do you do implants?',
    `got ${JSON.stringify(r.questions[0].text)}`);
  eq('the same question answered successfully is not a miss', r.totals.misses, 5);
  check('a hit never reaches the question list',
    r.questions.reduce((n, q) => n + q.count, 0) === 4,
    JSON.stringify(r.questions));
  eq('a distinct miss is its own entry', r.questions[1].count, 1);
  check('very short misses are dropped', !r.questions.some((q) => q.text === 'no'));
  eq('lastAsked is the most recent sighting', r.questions[0].lastAsked, day(0));
}
{
  // Order must not depend on the order rows arrive in — the query sorts
  // newest-first today and nothing in the contract says it must.
  const rows = [miss('older', 3), miss('older', 0), miss('older', 1)];
  const r = report(rows);
  eq('lastAsked survives unsorted input', r.questions[0].lastAsked, day(0));
}
{
  const many = Array.from({ length: 30 }, (_, i) => miss(`question number ${i}`));
  const r = report(many);
  eq('the question list is capped', r.questions.length, 20);
  eq('but the totals are not', r.totals.misses, 30);
}

console.log('\nMiss report — channels and scores');
{
  const r = report([
    log({ top_score: 0.9 }),
    log({ top_score: 0.7 }),
    log({ channel: 'lexical', top_score: 0.08 }),
    miss('nothing here'),
  ]);
  eq('vector hits counted', r.channels.vector, 2);
  eq('lexical rescues counted', r.channels.lexical, 1);
  eq('misses counted', r.channels.missed, 1);
  // The lexical 0.08 is a ts_rank, not a cosine score. Pooling it would
  // drag the median to 0.7 and read like a measurement.
  eq('the median ignores the lexical channel entirely', r.scores.hitMedian, 0.8);
  eq('the floor those scores were tested against is reported', r.scores.floor, 0.6);
  eq('a miss with no score leaves missMax null', r.scores.missMax, null);
}
{
  const r = report([log({ top_score: 0.9 }), log({ top_score: 0.7 }), log({ top_score: 0.5 })]);
  eq('an odd count takes the middle value', r.scores.hitMedian, 0.7);
}
{
  // Chunks came back and the model was still shown nothing — a budget
  // problem rather than a retrieval one, and worth seeing as such.
  const r = report([miss('x y z', 0, { top_score: 0.82, chunk_count: 0 })]);
  eq('a scored miss is reported', r.scores.missMax, 0.82);
}
{
  const r = report([log({ min_similarity: 0.6, created_at: day(0) }),
                    log({ min_similarity: 0.3, created_at: day(3) })]);
  eq('the floor comes from the newest row that has one', r.scores.floor, 0.6);
}
{
  const r = report([log({ min_similarity: null })]);
  eq('a row with no floor recorded leaves it null', r.scores.floor, null);
}
{
  const rows = Array.from({ length: 10 }, () => miss('anything at all'));
  const r = report(rows, { cap: 10 });
  check('reports truncation when the row cap is hit', r.truncated === true);
}

rmSync(OUT, { recursive: true, force: true });
console.log(failures ? `\n${failures} failing check(s).\n` : '\nAll stats unit tests passed.\n');
process.exit(failures ? 1 : 0);
