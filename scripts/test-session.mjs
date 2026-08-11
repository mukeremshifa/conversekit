#!/usr/bin/env node
/**
 * Cross-visitor transcript isolation.
 *
 * Before signed session ids, /v1/chat trusted whatever session_id the
 * client sent, so anyone holding or guessing one could resume that
 * conversation and have its history fed back to them. These assertions
 * are the regression guard.
 *
 * This spends real model calls against a real bot, so it is NOT part of
 * the default sweep — run it deliberately.
 *
 *   WORKER_URL=… node scripts/test-session.mjs <botId>
 */
const WORKER = process.env.WORKER_URL ?? 'http://localhost:8787';
const BOT = process.argv[2];
if (!BOT) { console.error('usage: test-session.mjs <botId>'); process.exit(2); }

let bad = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { bad++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * These assertions depend on a real model reply, so a vendor rate
 * limit makes a check INCONCLUSIVE — never a silent pass. Back off and
 * retry; if it persists, say so loudly and exit non-zero.
 */
const chat = async (message, sessionId, attempt = 0) => {
  const body = { botId: BOT, message };
  if (sessionId !== undefined) body.sessionId = sessionId;
  const r = await fetch(`${WORKER}/v1/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const t = await r.text();
  const json = t ? JSON.parse(t) : null;

  if (r.status === 429 && attempt < 4) {
    const wait = 4000 * (attempt + 1);
    console.log(`       (vendor rate-limited; retrying in ${wait / 1000}s)`);
    await sleep(wait);
    return chat(message, sessionId, attempt + 1);
  }
  // Space requests out — a free-tier key will not take a burst.
  await sleep(3500);
  return { status: r.status, json };
};

let inconclusive = 0;
/** Assert a reply does NOT contain the secret, distinguishing a
 *  rate-limited call from a genuine pass. */
const checkNoLeak = (label, res, re) => {
  if (res.status === 429 || typeof res.json?.reply !== 'string') {
    inconclusive++;
    console.log(`   ??   ${label} — INCONCLUSIVE (status ${res.status}, no reply)`);
    return;
  }
  check(label, !re.test(res.json.reply), `reply: ${res.json.reply}`);
};

console.log(`\nSession integrity — ${WORKER}\n`);

console.log('Issuance');
const first = await chat('My name is Wilhelmina Featherstonehaugh. Remember it.');

// A rate limit must not read as a failure any more than it reads as a
// pass — it means we learned nothing. Bail early rather than emit a
// cascade of misleading results.
if (first.status === 429) {
  console.log('   ??   INCONCLUSIVE — the vendor is rate-limiting every call.');
  console.log('');
  console.log('Cannot exercise the end-to-end path right now.');
  console.log('The security property itself is covered by `npm run test:session-units`,');
  console.log('which tests the signing directly and needs no vendor quota.');
  console.log('');
  process.exit(1);
}

check('a request with no sessionId succeeds', first.status === 200, `status ${first.status} ${JSON.stringify(first.json)}`);
const sid = first.json?.sessionId;
check('server issues a signed session id', typeof sid === 'string' && sid.startsWith('ck1.'), `got ${sid}`);
check('id is not client-guessable', (sid?.split('.')[1]?.length ?? 0) >= 20, `got ${sid}`);

console.log('\nContinuity — the legitimate visitor keeps their history');
const second = await chat('What name did I just give you?', sid);
check('same id returns the same session', second.json?.sessionId === sid);
if (typeof second.json?.reply !== 'string') {
  inconclusive++;
  console.log(`   ??   history is remembered — INCONCLUSIVE (status ${second.status})`);
} else {
  check('history is remembered', /featherstonehaugh|wilhelmina/i.test(second.json.reply), `reply: ${second.json.reply}`);
}

console.log('\nForgery — an attacker must not resume that conversation');
for (const [label, forged] of [
  ['a made-up id',            'ck-abc123-1699999999'],
  ['a tampered signature',    sid ? `${sid.slice(0, -4)}AAAA` : 'x'],
  ['a tampered random part',  sid ? sid.replace(/\.([^.]+)\./, '.AAAAAAAAAAAAAAAAAAAAAA.') : 'x'],
  ['a wrong prefix',          sid ? sid.replace('ck1.', 'ck9.') : 'x'],
  ['an empty id',             ''],
]) {
  const r = await chat('What name did I just give you?', forged);
  checkNoLeak(`${label} gets no history`, r, /featherstonehaugh|wilhelmina/i);
  if (r.json?.sessionId) {
    check(`${label} is replaced with a fresh signed id`, r.json.sessionId !== forged && r.json.sessionId.startsWith('ck1.'));
  }
}

console.log('\nCross-bot replay');
const other = await fetch(`${WORKER}/v1/chat`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ botId: '00000000-0000-0000-0000-000000000000', message: 'hi', sessionId: sid }),
});
check('a token for another bot is rejected at the bot lookup', other.status === 404, `status ${other.status}`);


// An inconclusive check is not a pass. A vendor rate limit must never
// be able to make this suite look green.
if (inconclusive) {
  console.log(`\n${inconclusive} check(s) INCONCLUSIVE — the vendor rate-limited us.`);
  console.log('Re-run when quota recovers; do not read this as a pass.');
}
console.log(
  bad ? `\n${bad} failure(s).\n`
  : inconclusive ? '\nNo failures, but coverage was incomplete.\n'
  : '\nSession integrity verified.\n',
);
process.exit(bad === 0 && inconclusive === 0 ? 0 : 1);
