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
const { buildStats, dayKey } = await import(`file://${OUT}/stats.js`);

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

rmSync(OUT, { recursive: true, force: true });
console.log(failures ? `\n${failures} failing check(s).\n` : '\nAll stats unit tests passed.\n');
process.exit(failures ? 1 : 0);
