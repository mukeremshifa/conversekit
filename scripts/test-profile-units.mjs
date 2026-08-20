#!/usr/bin/env node
/**
 * Unit tests for the business profile and the retrieval router
 * (supabase/015, 016).
 *
 * Seven things are pinned here, and every one of them is something that
 * cannot be caught by reading the code:
 *
 *   1. THE PROMPT CONTRACT. A bot whose `profile` is NULL must produce
 *      the same system prompt it did before 015, byte for byte — for a
 *      bot with every legacy column set and for a bot with none. That
 *      is the entire mitigation for the largest risk in the change (R1:
 *      every existing bot renders through the legacy path until it is
 *      backfilled), so it is compared as a string rather than reasoned
 *      about. The convention scripts/test-lead-capture.mjs set.
 *
 *   2. THE RENDERER. Structured hours render; `notes` is the fallback
 *      when `regular` is absent; `regular` wins when both are present
 *      and does not silently discard the note beside it.
 *
 *   3. VALIDATION. Bad times, reversed intervals, overlapping
 *      intervals, non-day keys and oversized text are each rejected or
 *      clamped exactly as specified — and a valid profile round-trips
 *      unchanged, which is the half nobody writes and everybody needs.
 *
 *   4. orNull. A profile cleared back to defaults stores as NULL, not
 *      as `{}`. profileFor depends on it: `{}` taking the structured
 *      path would replace a bot's whole legacy fact block with an empty
 *      heading.
 *
 *   5. THE ROUTER. "thanks" skips; "thanks, but what are your hours?"
 *      does NOT; 多少钱 does not; a bare email does. This is the test
 *      that stops a skip rule from quietly eating real questions — a
 *      false skip is a wrong answer, a false retrieve is only latency.
 *
 *   6. COMPUTED HOURS. Open, closed, lunch break, exception day, day
 *      boundary, and a DST transition date — the one day of the year a
 *      hand-rolled offset calculation is wrong and nobody notices.
 *
 *   7. THE CONTEXT BUDGET. The profile is prompt-resident on every
 *      turn, so its ceiling truncates and reports.
 *
 * No network, no database.
 *
 *   npm run test:profile
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = mkdtempSync(join(tmpdir(), 'ck-profile-'));

await build({
  entryPoints: [
    join(ROOT, 'src/profile.ts'),
    join(ROOT, 'src/prompt.ts'),
    join(ROOT, 'src/config.ts'),
    join(ROOT, 'src/rag/route.ts'),
  ],
  outdir: OUT, format: 'esm', bundle: true, platform: 'neutral',
});

const { profileFor, renderProfile, renderProfileBlock, profilePublicCard } =
  await import(`file://${OUT}/profile.js`);
const { buildSystemPrompt } = await import(`file://${OUT}/prompt.js`);
const { validateProfile, LIMITS } = await import(`file://${OUT}/config.js`);
const { routeTurn } = await import(`file://${OUT}/rag/route.js`);

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};
const eq = (label, actual, expected) =>
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const deepEq = (label, actual, expected) =>
  check(label, JSON.stringify(actual) === JSON.stringify(expected),
        `expected ${JSON.stringify(expected)}\n       got      ${JSON.stringify(actual)}`);

// ================================================================
// 1. The prompt contract
// ================================================================
//
// The static header is reproduced here in full, on purpose. It is what
// makes this a POSITION test as well as a content test: the profile
// block has to be the thing that immediately follows the tone lines,
// which is where the `## Business Information` block was before 015.

const BOT = {
  id: 'b1', org_id: 'o1',
  name: 'Ada', business_name: 'Northgate Dental',
  business_description: 'A family dental practice in central Leeds.',
  hours: 'Mon to Fri, 8am to 6pm',
  address: '12 Northgate, Leeds',
  contact_phone: '0113 555 0100',
  contact_email: 'hello@northgate.example',
  location: null, contact: null,
  services: null, faq: null,
  custom_instructions: null,
  primary_color: '#2563EB', allowed_origin: null, created_at: '2026-01-01T00:00:00Z',
};

const HEAD = [
  'You are a helpful AI assistant for Northgate Dental.',
  'Your name is Ada.',
  '',
  'Your job is to help website visitors get information about this business and, when appropriate, collect their contact details so the business can follow up.',
  'Always be friendly and professional. Reply in the same language the visitor uses.',
  'Keep replies concise — 2-4 sentences unless the visitor asks for detail.',
].join('\n');

console.log('\nPrompt contract — a bot with no profile is byte-identical to pre-015');
{
  // Every legacy column set.
  const expected = [
    '',
    '## Business Information',
    '',
    'A family dental practice in central Leeds.',
    '- Address: 12 Northgate, Leeds',
    '- Hours: Mon to Fri, 8am to 6pm',
    '- Phone: 0113 555 0100',
    '- Email: hello@northgate.example',
  ].join('\n');

  const prompt = buildSystemPrompt(BOT);
  check('every legacy column set renders the pre-015 block, in the pre-015 position',
        prompt.startsWith(`${HEAD}\n${expected}\n`),
        `got:\n${JSON.stringify(prompt.slice(0, HEAD.length + expected.length + 40))}`);

  // A bot with none of them. The heading and its blank line are still
  // emitted — they were before 015 too, and a prompt that loses a
  // heading when a field is cleared is a different prompt.
  const bare = buildSystemPrompt({
    ...BOT,
    business_description: null, hours: null, address: null,
    contact_phone: null, contact_email: null,
  });
  check('no legacy columns at all still renders the bare heading',
        bare.startsWith(`${HEAD}\n\n## Business Information\n`),
        JSON.stringify(bare.slice(0, HEAD.length + 40)));

  // The `address ?? location` reconciliation and the contact fallback,
  // both of which are the reason this block could not simply be deleted.
  const older = buildSystemPrompt({
    ...BOT,
    business_description: null, address: null, contact_phone: null, contact_email: null,
    location: 'Leeds city centre', contact: 'Call 0113 555 0100',
  });
  check('legacy `location` stands in for `address`', older.includes('- Address: Leeds city centre'));
  check('legacy `contact` renders only when phone and email are both unset',
        older.includes('- Contact: Call 0113 555 0100'));
  check('`contact` is suppressed once a phone exists',
        !buildSystemPrompt({ ...BOT, contact: 'Call us' }).includes('- Contact: Call us'));

  eq('profileFor is null for an absent column', profileFor(BOT), null);
  eq('profileFor is null for an empty object', profileFor({ ...BOT, profile: {} }), null);
}

// ================================================================
// 2. The renderer
// ================================================================
const PROFILE_BOT = (profile) => ({ ...BOT, business_description: null, profile });

console.log('\nRenderer — structured hours, and the notes fallback');
{
  const structured = renderProfile(PROFILE_BOT({
    hours: { regular: { mon: [{ open: '09:00', close: '17:00' }], sat: [{ open: '10:00', close: '13:00' }] } },
  }));
  check('the heading changes to Business Profile', structured[1] === '## Business Profile');
  check('a day with hours renders its span', structured.includes('  - Monday: 09:00–17:00'));
  check('a day with none renders as closed', structured.includes('  - Sunday: closed'));
  check('all seven days are listed',
        ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
          .every((d) => structured.some((l) => l.startsWith(`  - ${d}:`))));

  const notesOnly = renderProfile(PROFILE_BOT({ hours: { notes: 'Mon to Fri, 8am to 6pm' } }));
  check('notes alone become the hours line', notesOnly.includes('- Hours: Mon to Fri, 8am to 6pm'));
  check('no weekly grid is invented from a note',
        !notesOnly.some((l) => l.startsWith('  - Monday:')));

  const both = renderProfile(PROFILE_BOT({
    hours: { regular: { mon: [{ open: '09:00', close: '17:00' }] }, notes: 'Closed on bank holidays' },
  }));
  check('regular wins over notes', both.includes('  - Monday: 09:00–17:00'));
  check('regular does not discard the note beside it',
        both.includes('- Hours notes: Closed on bank holidays'));
  check('the note is not ALSO rendered as the hours line',
        !both.includes('- Hours: Closed on bank holidays'));

  const full = renderProfile(PROFILE_BOT({
    identity: { legal_name: 'Northgate Dental Care Ltd', tagline: 'Gentle dentistry' },
    location: { line1: '12 Northgate', city: 'Leeds', postal: 'LS1 4AB', map_url: 'https://maps.example.com/x' },
    contact: { phone: '0113 555 0100', socials: [{ label: 'Instagram', url: 'https://instagram.com/x' }] },
    links: { booking_url: 'https://book.example.com' },
    policies: { payment_methods: ['Card', 'Cash'], languages: ['English', 'Polish'] },
  }));
  check('address parts are joined in postal order',
        full.includes('- Address: 12 Northgate, Leeds, LS1 4AB'));
  check('a social renders under its own label', full.includes('- Instagram: https://instagram.com/x'));
  check('payment methods are one line', full.includes('- Payment methods: Card, Cash'));
  check('languages are one line', full.includes('- Languages spoken: English, Polish'));
  check('booking is labelled', full.includes('- Booking: https://book.example.com'));

  // business_description is not part of the profile and must survive
  // the switch to the structured path.
  const withDescription = renderProfile({
    ...BOT,
    profile: { identity: { tagline: 'Gentle dentistry' } },
  });
  check('business_description still renders on the structured path',
        withDescription.includes('A family dental practice in central Leeds.'));
}

// ================================================================
// 3. Validation
// ================================================================
console.log('\nValidation');
{
  const ok = (input) => validateProfile(input);
  const err = (label, input, fragment) => {
    const r = validateProfile(input);
    check(label, r.ok === false && (!fragment || r.error.includes(fragment)),
          r.ok ? `accepted ${JSON.stringify(input)}` : `error was "${r.error}"`);
  };

  err('a non-day key is rejected', { hours: { regular: { funday: [] } } }, 'mon, tue');
  err('a malformed time is rejected', { hours: { regular: { mon: [{ open: '9am', close: '17:00' }] } } }, 'HH:MM');
  err('an out-of-range hour is rejected', { hours: { regular: { mon: [{ open: '25:00', close: '26:00' }] } } }, 'HH:MM');
  err('close before open is rejected', { hours: { regular: { mon: [{ open: '17:00', close: '09:00' }] } } }, 'is not after');
  err('close equal to open is rejected', { hours: { regular: { mon: [{ open: '09:00', close: '09:00' }] } } }, 'is not after');
  err('overlapping intervals are rejected',
      { hours: { regular: { mon: [{ open: '09:00', close: '13:00' }, { open: '12:00', close: '17:00' }] } } },
      'overlap');
  err('a bad exception date is rejected', { hours: { exceptions: [{ date: '25/12/2026', closed: true }] } }, 'YYYY-MM-DD');
  err('an exception that says nothing is rejected', { hours: { exceptions: [{ date: '2026-12-25' }] } }, 'needs either');
  err('an unknown section is rejected', { menu: {} }, 'Unknown profile field');
  err('an unknown field inside a section is rejected', { identity: { colour: 'blue' } }, 'Unknown identity field');
  err('a non-https, non-http URL is rejected', { links: { booking_url: 'ftp://example.com' } }, 'must start with');
  err('an internal hostname is rejected', { links: { booking_url: 'http://localhost/book' } }, 'public hostname');
  err('an unknown time zone is rejected', { hours: { timezone: 'Mars/Olympus' } }, 'not a known time zone');

  // Adjacent, not overlapping: a lunch break that ends exactly when the
  // afternoon starts is one continuous day, and refusing it would be
  // refusing an ordinary schedule.
  const adjacent = ok({ hours: { regular: { mon: [{ open: '09:00', close: '13:00' }, { open: '13:00', close: '17:00' }] } } });
  check('adjacent intervals are allowed', adjacent.ok === true,
        adjacent.ok ? '' : adjacent.error);

  // Intervals listed out of order are sorted rather than refused.
  const unsorted = ok({ hours: { regular: { mon: [{ open: '14:00', close: '17:00' }, { open: '09:00', close: '12:00' }] } } });
  deepEq('intervals are sorted into clock order',
         unsorted.ok && unsorted.value.hours.regular.mon,
         [{ open: '09:00', close: '12:00' }, { open: '14:00', close: '17:00' }]);

  // Text CLAMPS rather than rejecting, per the rule at the top of
  // src/config.ts: a save that fails on length loses every other edit in
  // the section beside it.
  const long = 'x'.repeat(LIMITS.profile.text + 200);
  const clamped = ok({ identity: { tagline: long } });
  eq('oversized text is clamped, not rejected',
     clamped.ok && clamped.value.identity.tagline.length, LIMITS.profile.text);

  // A URL is NOT clamped — slicing one produces a different, silently
  // broken URL.
  const longUrl = `https://example.com/${'x'.repeat(LIMITS.url)}`;
  const urlResult = ok({ links: { booking_url: longUrl } });
  check('an oversized URL is rejected rather than sliced', urlResult.ok === false);

  err('too many custom links', { links: { custom: Array.from({ length: LIMITS.profile.customLinks + 1 }, () => ({ label: 'a', url: 'https://a.example.com' })) } }, 'At most');
  err('too many exceptions', { hours: { exceptions: Array.from({ length: LIMITS.profile.exceptions + 1 }, (_, i) => ({ date: '2026-01-01', closed: true })) } }, 'At most');

  // A half-typed row is what an open "Add link" row looks like. It is
  // dropped, not rejected — the form must not refuse to save because a
  // blank row is showing.
  const halfRow = ok({ links: { custom: [{ label: 'Forms', url: '' }, { label: 'Prices', url: 'https://p.example.com' }] } });
  deepEq('a half-filled link row is dropped, not rejected',
         halfRow.ok && halfRow.value.links.custom,
         [{ label: 'Prices', url: 'https://p.example.com' }]);

  // The round trip. A valid profile in is the same profile out.
  const valid = {
    identity: { legal_name: 'Northgate Dental Care Ltd', tagline: 'Gentle dentistry', industry: 'Dental practice' },
    location: {
      line1: '12 Northgate', line2: 'Floor 2', city: 'Leeds', region: 'West Yorkshire',
      postal: 'LS1 4AB', country: 'United Kingdom', map_url: 'https://maps.example.com/x',
      service_area: 'Leeds and within 15 miles', parking: 'Free on Cardigan Street', notes: 'Ring the bell',
    },
    contact: {
      phone: '0113 555 0100', whatsapp: '+44 7700 900123', email: 'hello@northgate.example',
      support_email: 'help@northgate.example', notes: 'Ask for Priya',
      socials: [{ label: 'Instagram', url: 'https://instagram.com/x' }],
    },
    hours: {
      timezone: 'Europe/London',
      regular: {
        mon: [{ open: '09:00', close: '13:00' }, { open: '14:00', close: '18:00' }],
        sat: [{ open: '10:00', close: '13:00' }],
      },
      exceptions: [{ date: '2026-12-25', closed: true, label: 'Christmas Day' }],
      notes: 'Closed on bank holidays',
    },
    links: {
      booking_url: 'https://book.example.com', pricing_url: 'https://prices.example.com',
      portal_url: 'https://portal.example.com',
      custom: [{ label: 'Patient forms', url: 'https://forms.example.com' }],
    },
    policies: {
      payment_methods: ['Card', 'Cash', 'Bank transfer'],
      cancellation: '24 hours notice', deposit: '50 pounds on implants',
      accessibility: 'Step-free entrance', languages: ['English', 'Polish'],
    },
  };
  const round = ok(valid);
  deepEq('a valid profile round-trips unchanged', round.ok && round.value, valid);
}

// ================================================================
// 4. orNull
// ================================================================
console.log('\norNull — cleared is NULL, never {}');
{
  eq('null in, null out', validateProfile(null).value, null);
  eq('undefined in, null out', validateProfile(undefined).value, null);
  eq('an empty object stores as NULL', validateProfile({}).value, null);
  eq('sections that validate to nothing store as NULL',
     validateProfile({ identity: {}, contact: { phone: '   ' } }).value, null);
  eq('an empty day array does not resurrect the object',
     validateProfile({ hours: { regular: { mon: [] } } }).value, null);
}

// ================================================================
// 5. The router
// ================================================================
console.log('\nRouter — skip only on confidence');
{
  const on = { ...BOT, rag_config: { router: 'on' } };
  const off = { ...BOT, rag_config: { router: 'off' } };

  const route = (q, bot = on) => routeTurn(q, bot).route;

  eq('with the router off, everything retrieves', route('thanks', off), 'retrieve');
  eq('an absent rag_config is the same as off', routeTurn('thanks', BOT).route, 'retrieve');

  for (const q of ['thanks', 'Thanks!', 'THANK YOU.', 'ok', 'ok, sounds good', 'bye',
                   'gracias', 'merci beaucoup', 'danke', 'obrigado', '谢谢', 'ありがとう',
                   'شكرا', 'спасибо']) {
    eq(`"${q}" skips`, route(q), 'skip');
  }

  // THE TEST THAT MATTERS. A substring match would kill every one of
  // these, and the failure would look like the bot got worse rather
  // than like a bug.
  for (const q of ['thanks, but what are your hours?',
                   'ok so how much is a filling',
                   'thank you — do you open on Saturdays?',
                   'gracias, cuanto cuesta una limpieza',
                   'bye is a strange name for a service, what is it']) {
    eq(`"${q}" does NOT skip`, route(q), 'retrieve');
  }

  // B3's multilingual floor, not re-derived: three characters is a
  // complete question in a dense script.
  eq('多少钱 does not skip', route('多少钱'), 'retrieve');
  eq('an English fragment under four codepoints skips', route('hm'), 'skip');

  // Lead-capture replies.
  eq('a bare email skips', route('priya@example.com'), 'skip');
  eq('a bare phone number skips', route('07700 900123'), 'skip');
  eq('a bare international number skips', route('+44 113 555 0100'), 'skip');
  eq('an email inside a question does not skip',
     route('can you send the form to priya@example.com and tell me the price'), 'retrieve');
  eq('a year is not a phone number', route('is the 2026 price list out yet'), 'retrieve');

  check('the decision carries a reason', routeTurn('thanks', on).reason.length > 0);
}

// ================================================================
// 6. Computed opening hours
// ================================================================
console.log('\nComputed hours — the line an LLM cannot produce on its own');
{
  const HOURS = {
    timezone: 'Europe/London',
    regular: {
      // A lunch break, so interval ORDER is tested rather than assumed.
      tue: [{ open: '09:00', close: '13:00' }, { open: '14:00', close: '18:00' }],
      wed: [{ open: '09:00', close: '17:00' }],
      thu: [{ open: '09:00', close: '17:00' }],
      sun: [{ open: '11:00', close: '15:00' }],
    },
    exceptions: [
      { date: '2026-08-19', closed: true, label: 'Staff training' },
      { date: '2026-08-20', open: '12:00', close: '14:00', label: 'Short day' },
    ],
  };
  const bot = PROFILE_BOT({ hours: HOURS });
  const at = (iso) => renderProfile(bot, new Date(iso)).find((l) => l.includes('It is currently'));

  // 2026-08-18 is a Tuesday. 13:20 UTC is 14:20 BST.
  const open = at('2026-08-18T13:20:00Z');
  check('open: the local weekday and clock are right',
        open?.includes('It is currently Tuesday 14:20'), open);
  check('open: it closes at the end of the interval containing now',
        open?.includes('The business is OPEN and closes at 18:00.'), open);

  // 13:30 BST is inside the lunch break — closed, reopening at 14:00.
  const lunch = at('2026-08-18T12:30:00Z');
  check('lunch break: closed, with the afternoon opening named',
        lunch?.includes('The business is CLOSED and opens at 14:00.'), lunch);

  // Before opening on the same day.
  const early = at('2026-08-18T06:15:00Z');
  check('before opening: closed, opens at 09:00',
        early?.includes('The business is CLOSED and opens at 09:00.'), early);

  // After closing — the day boundary, and the two ways an exception
  // changes the answer at once. Tomorrow (Wednesday 2026-08-19) is an
  // ordinary 09:00-17:00 day in the grid but is closed by an exception,
  // so it is skipped; Thursday is an ordinary 09:00-17:00 day too, but
  // its own exception shortens it to 12:00-14:00 — so the next opening
  // is 12:00, not 09:00. Getting this from the grid alone would tell a
  // visitor to arrive at a locked door twice over.
  const late = at('2026-08-18T21:30:00Z');
  check('after closing: exceptions decide the next opening, not the weekly grid',
        late?.includes('The business is CLOSED. It next opens Thursday at 12:00.'), late);

  // The exception day itself.
  const holiday = at('2026-08-19T10:00:00Z');
  check('a closed exception overrides the weekly pattern',
        holiday?.includes('The business is CLOSED.'), holiday);
  check('a closed exception does not report an opening time today',
        !holiday?.includes('opens at 09:00.'), holiday);

  // A short-day exception replaces the weekly pattern rather than
  // adding to it: Thursday would normally be 09:00-17:00.
  const shortDay = at('2026-08-20T09:30:00Z');   // 10:30 BST, Thursday
  check('a short-day exception closes the morning the grid would open',
        shortDay?.includes('The business is CLOSED and opens at 12:00.'), shortDay);
  const shortDayOpen = at('2026-08-20T12:00:00Z'); // 13:00 BST
  check('a short-day exception is open inside its own window',
        shortDayOpen?.includes('The business is OPEN and closes at 14:00.'), shortDayOpen);

  // THE DST TRANSITION. 2026-03-29 is the Sunday the UK clocks go
  // forward: 01:00 GMT becomes 02:00 BST. An offset calculated by hand,
  // or a toLocaleString round trip, reports 01:30 here.
  const dst = at('2026-03-29T01:30:00Z');
  check('DST: the local wall clock is 02:30, not 01:30',
        dst?.includes('It is currently Sunday 02:30'), dst);
  check('DST: Sunday opens at 11:00, so it is still closed',
        dst?.includes('The business is CLOSED and opens at 11:00.'), dst);

  // No timezone, no line. This is the whole of what D1 buys, and the
  // whole of what cutting it would cost.
  const noZone = renderProfile(PROFILE_BOT({ hours: { regular: HOURS.regular } }), new Date('2026-08-18T13:20:00Z'));
  check('without a timezone there is no computed line',
        !noZone.some((l) => l.includes('It is currently')));
  check('without a timezone the grid still renders',
        noZone.includes('  - Tuesday: 09:00–13:00, 14:00–18:00'));

  // An unknown zone must not throw on the visitor's hot path.
  const badZone = renderProfile(PROFILE_BOT({ hours: { timezone: 'Mars/Olympus', regular: HOURS.regular } }), new Date());
  check('an unknown timezone degrades rather than throwing',
        !badZone.some((l) => l.includes('It is currently')));
}

// ================================================================
// 7. The context budget
// ================================================================
console.log('\nContext budget — the profile is in every prompt, so it has a ceiling');
{
  const small = renderProfileBlock(PROFILE_BOT({ identity: { tagline: 'Gentle dentistry' } }));
  eq('an ordinary profile is not truncated', small.truncated, false);

  // Every list at its cap, every text field at its cap: the largest
  // profile the validator will accept.
  const max = 'y'.repeat(LIMITS.profile.text);
  const huge = renderProfileBlock(PROFILE_BOT({
    identity: { legal_name: max, tagline: max, industry: max },
    location: { line1: max, parking: max, notes: max, service_area: max },
    contact: { phone: max, notes: max },
    policies: { cancellation: max, deposit: max, accessibility: max },
  }));
  eq('the largest acceptable profile is truncated', huge.truncated, true);
  check('and truncation holds the block under the ceiling',
        huge.lines.join('\n').length <= LIMITS.profile.rendered,
        `${huge.lines.join('\n').length} > ${LIMITS.profile.rendered}`);
  check('the heading survives truncation', huge.lines[1] === '## Business Profile');
}

// ================================================================
// The widget card
// ================================================================
console.log('\nWidget card — only set fields, and the booking overlap resolved');
{
  eq('a bot with no profile has no card', profilePublicCard(BOT), null);

  const card = profilePublicCard(PROFILE_BOT({
    location: { line1: '12 Northgate', city: 'Leeds', map_url: 'https://maps.example.com/x' },
    contact: { phone: '0113 555 0100' },
    links: { booking_url: 'https://profile.example.com/book' },
    hours: { timezone: 'Europe/London', regular: { mon: [{ open: '09:00', close: '17:00' }] } },
  }));
  eq('the address is assembled', card.address, '12 Northgate, Leeds');
  eq('the map link is camelCased', card.mapUrl, 'https://maps.example.com/x');
  eq('booking falls back to the profile', card.booking, 'https://profile.example.com/book');
  deepEq('hours go over as structure the widget can render',
         card.hours, { timezone: 'Europe/London', regular: { mon: ['09:00–17:00'] } });
  check('nothing unset is emitted', !('email' in card) && !('whatsapp' in card));

  const overridden = profilePublicCard({
    ...PROFILE_BOT({ links: { booking_url: 'https://profile.example.com/book' } }),
    lead_config: { booking_url: 'https://lead.example.com/book' },
  });
  eq('lead_config.booking_url wins, so existing configuration is what the button uses',
     overridden.booking, 'https://lead.example.com/book');

  // And the same precedence in the prompt, which is the half a tenant
  // would notice first.
  const leadLines = buildSystemPrompt({
    ...PROFILE_BOT({ links: { booking_url: 'https://profile.example.com/book' } }),
  });
  check('the profile booking link reaches the lead capture steps',
        leadLines.includes('book a time themselves: https://profile.example.com/book'));
}

rmSync(OUT, { recursive: true, force: true });

console.log(failures === 0
  ? '\nAll profile unit tests passed.\n'
  : `\n${failures} profile unit test(s) FAILED.\n`);
process.exit(failures === 0 ? 0 : 1);
