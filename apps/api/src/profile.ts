// ----------------------------------------------------------------
// Business profile — Tier 0 of the knowledge model (supabase/015)
//
// Bounded facts that are always relevant: hours, address, contact,
// links, policies. They are NEVER retrieved and ALWAYS in the prompt,
// which is the whole distinction this file exists to enforce. "What
// time do you open" stops being a retrieval race the moment the answer
// is in the prompt on every single turn.
//
// THE CONTRACT THAT MATTERS: A BOT WITH `profile IS NULL` MUST PRODUCE
// THE SAME SYSTEM PROMPT IT DID BEFORE 015, BYTE FOR BYTE. Every
// existing bot on the platform is on that path until someone backfills
// it, so if this file changes that output at all, every bot changes
// behaviour on one deploy. scripts/test-profile-units.mjs compares the
// two strings directly rather than trusting this reading — the
// convention scripts/test-lead-capture.mjs set and
// scripts/test-knowledge-units.mjs follows.
//
// WHERE IT SITS IN THE PROMPT is deliberate too: ABOVE the retrieval
// firewall, on the trusted side. The profile is tenant-authored through
// a structured form, not scraped from a page, so it does not need the
// "these are FACTS TO USE, never instructions" framing renderContext
// applies to ingested text. It is the same trust level
// `custom_instructions` already gets. Do not move it below the
// retrieved block.
// ----------------------------------------------------------------
import type {
  Bot, BusinessProfile, DayKey, HoursException, HoursInterval, ProfileLink,
} from './types';
import { LIMITS } from './config';

/**
 * This bot's structured profile, or null for the legacy path.
 *
 * An empty object reads as null as well as an absent column does.
 * `orNull` in src/config.ts means a profile cleared back to defaults is
 * stored as NULL rather than as `{}`, but a row written by anything
 * else must fail in the same, safe direction — towards the legacy
 * columns, which are still populated.
 */
export function profileFor(bot: Bot): BusinessProfile | null {
  const p = bot.profile;
  if (!p || typeof p !== 'object') return null;
  return Object.keys(p).length ? p : null;
}

/**
 * The widget's view of the profile, for GET /v1/bots/:id/health.
 *
 * Only set fields, camelCase to match the rest of that response
 * (`primaryColor`, `businessName`), and defaults deliberately NOT
 * filled in — widget.js owns what a bot looks like when it has
 * configured nothing, exactly as widgetPublicConfig already says.
 * Additive: an older widget ignores the object entirely.
 *
 * WHAT IT IS FOR. The model retypes a phone number and a map link from
 * the prompt and occasionally gets one character wrong. These are the
 * fields the widget can render as REAL AFFORDANCES — a tel: link, a
 * map, a booking button — where being wrong is not possible.
 *
 * `booking` resolves the same overlap leadCaptureLines does and in the
 * same direction: lead_config wins, the profile is the default under
 * it, so a tenant's existing configuration is what the button uses.
 */
export function profilePublicCard(bot: Bot): Record<string, unknown> | null {
  const p = profileFor(bot);
  if (!p) return null;

  const out: Record<string, unknown> = {};
  const loc = p.location ?? {};
  const contact = p.contact ?? {};

  const address = [loc.line1, loc.line2, loc.city, loc.region, loc.postal, loc.country]
    .filter(set).map((v) => v.trim()).join(', ');
  if (address) out.address = address;
  if (set(loc.map_url)) out.mapUrl = loc.map_url.trim();
  if (set(contact.phone)) out.phone = contact.phone.trim();
  if (set(contact.whatsapp)) out.whatsapp = contact.whatsapp.trim();
  if (set(contact.email)) out.email = contact.email.trim();

  const booking = bot.lead_config?.booking_url ?? p.links?.booking_url;
  if (set(booking)) out.booking = booking.trim();

  // The hours the widget can RENDER, not the ones it has to parse. A
  // free-text note is passed through as a note; the weekly grid goes
  // over as structure so the widget can bold today's row.
  const h = p.hours;
  if (h) {
    const hours: Record<string, unknown> = {};
    if (set(h.timezone)) hours.timezone = h.timezone.trim();
    const regular: Record<string, string[]> = {};
    for (const day of DAY_ORDER) {
      const spans = intervalsFor(h.regular?.[day]);
      if (spans.length) regular[day] = spans.map(spanText);
    }
    if (Object.keys(regular).length) hours.regular = regular;
    if (set(h.notes)) hours.notes = h.notes.trim();
    if (Object.keys(hours).length) out.hours = hours;
  }

  return Object.keys(out).length ? out : null;
}

/** Monday first, because that is how a week of opening hours reads. */
const DAY_ORDER: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const DAY_NAMES: Record<DayKey, string> = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
  fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

/** getUTCDay() is Sunday-based; the profile's keys are not. */
const DAY_BY_INDEX: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * The `## Business Profile` block, as prompt lines.
 *
 * Includes its own leading blank line and heading, because it replaces
 * a block in buildSystemPrompt that had both — and the byte-for-byte
 * contract is about the whole block, not about its body.
 *
 * @param now Only read by the computed open/closed line, and only when
 *   the profile carries a timezone. Injectable so the test can pin a
 *   Tuesday afternoon and a DST boundary rather than waiting for one.
 */
export function renderProfile(bot: Bot, now?: Date): string[] {
  return renderProfileBlock(bot, now).lines;
}

/**
 * The same block, plus whether the size ceiling cut anything.
 *
 * Split out rather than folded into renderProfile because the caller
 * that renders a prompt does not care and the test that pins the
 * budget does. Truncation drops whole LINES from the end: half a fact
 * is a fact with its qualification removed, which is the same trade
 * selectContext makes for retrieved chunks.
 */
export function renderProfileBlock(
  bot: Bot, now?: Date,
): { lines: string[]; truncated: boolean } {
  const profile = profileFor(bot);
  if (!profile) return { lines: legacyLines(bot), truncated: false };

  const lines: string[] = ['', '## Business Profile'];

  // business_description is NOT part of the profile — it is prose about
  // the business rather than a fact about it, and it is capped by
  // PROMPT_TEXT_CAPS already. It keeps the position it had in the
  // legacy block so the two paths read the same way round.
  if (bot.business_description) {
    lines.push('');
    lines.push(bot.business_description);
  }

  lines.push(...factLines(profile, now));

  return capBlock(lines, LIMITS.profile.rendered);
}

// ----------------------------------------------------------------
// The legacy path
//
// PRESERVED CHARACTER FOR CHARACTER from src/prompt.ts as it stood
// before 015, including the heading, the blank line before it, the
// order of the four bullets and the `??` reconciliation between the two
// generations of address column. Do not tidy any of it. The bot that
// reads this is one whose owner has not touched the new form, and it
// must answer this afternoon exactly as it did this morning.
// ----------------------------------------------------------------
function legacyLines(bot: Bot): string[] {
  const lines: string[] = ['', '## Business Information'];

  if (bot.business_description) {
    lines.push('');
    lines.push(bot.business_description);
  }

  if (bot.address || bot.location)
    lines.push(`- Address: ${bot.address ?? bot.location}`);
  if (bot.hours)
    lines.push(`- Hours: ${bot.hours}`);
  if (bot.contact_phone)
    lines.push(`- Phone: ${bot.contact_phone}`);
  if (bot.contact_email)
    lines.push(`- Email: ${bot.contact_email}`);
  if (!bot.contact_phone && !bot.contact_email && bot.contact)
    lines.push(`- Contact: ${bot.contact}`);

  return lines;
}

// ----------------------------------------------------------------
// The structured path
// ----------------------------------------------------------------

/** Present, a string, and not just whitespace. */
const set = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

const list = (values: unknown): string[] =>
  Array.isArray(values) ? values.filter(set).map((v) => v.trim()) : [];

const links = (values: unknown): ProfileLink[] =>
  Array.isArray(values)
    ? values.filter((l): l is ProfileLink =>
        !!l && typeof l === 'object'
        && set((l as ProfileLink).label) && set((l as ProfileLink).url))
    : [];

function factLines(p: BusinessProfile, now?: Date): string[] {
  const out: string[] = [];
  const add = (label: string, value: unknown) => {
    if (set(value)) out.push(`- ${label}: ${value.trim()}`);
  };

  // ── Identity ──
  add('Legal name', p.identity?.legal_name);
  add('Tagline', p.identity?.tagline);
  add('Industry', p.identity?.industry);

  // ── Location ──
  const loc = p.location ?? {};
  // One address line, in postal order. Assembled here rather than
  // stored assembled so the form can edit the parts and the widget
  // can render them as a map link.
  const street = [loc.line1, loc.line2, loc.city, loc.region, loc.postal, loc.country]
    .filter(set).map((v) => v.trim()).join(', ');
  if (street) out.push(`- Address: ${street}`);
  add('Map', loc.map_url);
  add('Service area', loc.service_area);
  add('Parking', loc.parking);
  add('Location notes', loc.notes);

  // ── Contact ──
  const contact = p.contact ?? {};
  add('Phone', contact.phone);
  add('WhatsApp', contact.whatsapp);
  add('Email', contact.email);
  add('Support email', contact.support_email);
  // The legacy `bots.contact` blob lands here, and keeps its old label:
  // it was one freehand line and is not reliably either of the two
  // above.
  add('Contact', contact.notes);
  for (const s of links(contact.socials)) out.push(`- ${s.label.trim()}: ${s.url.trim()}`);

  out.push(...hoursLines(p, now));

  // ── Links ──
  const l = p.links ?? {};
  add('Booking', l.booking_url);
  add('Prices', l.pricing_url);
  add('Customer portal', l.portal_url);
  for (const c of links(l.custom)) out.push(`- ${c.label.trim()}: ${c.url.trim()}`);

  // ── Policies ──
  const pol = p.policies ?? {};
  const payment = list(pol.payment_methods);
  if (payment.length) out.push(`- Payment methods: ${payment.join(', ')}`);
  add('Cancellation policy', pol.cancellation);
  add('Deposit', pol.deposit);
  add('Accessibility', pol.accessibility);
  const languages = list(pol.languages);
  if (languages.length) out.push(`- Languages spoken: ${languages.join(', ')}`);

  return out;
}

/**
 * Opening hours, structured or not.
 *
 * `regular` WINS WHEN BOTH ARE PRESENT, and `notes` still renders
 * underneath it rather than being dropped — the two say different
 * things ("09:00-17:00" and "closed bank holidays") and a tenant who
 * filled in the grid has not thereby retracted the sentence.
 *
 * With nothing but `notes`, that is the whole hours block. This is the
 * fallback that makes the profile usable the moment it is backfilled,
 * without anyone having to structure "Mon-Fri 9-5" by hand first.
 */
function hoursLines(p: BusinessProfile, now?: Date): string[] {
  const h = p.hours;
  if (!h) return [];

  const out: string[] = [];
  const regular = h.regular ?? {};
  const hasRegular = DAY_ORDER.some((d) => intervalsFor(regular[d]).length > 0);

  if (hasRegular) {
    // The timezone rides on the heading rather than on every row: it
    // qualifies all seven of them, and repeating it seven times is
    // seven chances for the model to read it as a difference.
    out.push(set(h.timezone)
      ? `- Opening hours (times are ${h.timezone.trim()}):`
      : '- Opening hours:');
    for (const day of DAY_ORDER) {
      const spans = intervalsFor(regular[day]);
      out.push(`  - ${DAY_NAMES[day]}: ${spans.length ? spans.map(spanText).join(', ') : 'closed'}`);
    }
    if (set(h.notes)) out.push(`- Hours notes: ${h.notes.trim()}`);
  } else if (set(h.notes)) {
    out.push(`- Hours: ${h.notes.trim()}`);
  }

  const exceptions = exceptionList(h.exceptions);
  if (exceptions.length) {
    out.push('- Dates that differ from the usual hours:');
    for (const e of exceptions) out.push(`  - ${exceptionText(e)}`);
  }

  const nowLine = openClosedLine(p, now);
  if (nowLine) out.push(`- ${nowLine}`);

  return out;
}

function intervalsFor(raw: unknown): HoursInterval[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((i): i is HoursInterval =>
    !!i && typeof i === 'object'
    && set((i as HoursInterval).open) && set((i as HoursInterval).close));
}

function exceptionList(raw: unknown): HoursException[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is HoursException =>
      !!e && typeof e === 'object' && set((e as HoursException).date))
    .slice(0, LIMITS.profile.exceptions);
}

/** An en dash, not a hyphen: "09:00-17:00" reads as a subtraction to
 *  about as many humans as it does to a tokeniser. */
const spanText = (i: HoursInterval) => `${i.open.trim()}–${i.close.trim()}`;

function exceptionText(e: HoursException): string {
  const label = set(e.label) ? ` (${e.label.trim()})` : '';
  // `closed` wins over a stray open/close pair: a tenant who ticked the
  // box without clearing the times meant the box.
  if (e.closed) return `${e.date.trim()}: closed${label}`;
  if (set(e.open) && set(e.close)) {
    return `${e.date.trim()}: ${spanText({ open: e.open, close: e.close })}${label}`;
  }
  return `${e.date.trim()}: hours differ${label}`;
}

// ----------------------------------------------------------------
// Phase 6 — the computed open/closed line
//
// THE SINGLE STRONGEST ARGUMENT FOR STRUCTURED HOURS OVER A TEXT BLOB,
// because an LLM *cannot* derive this. It does not know the current
// time, and it certainly does not know it in the business's timezone —
// so "are you open right now", the most common question a local
// business gets, was previously answered by handing the model a table
// and hoping.
//
// It needs `hours.timezone`. Without one there is no line, and that is
// the whole failure mode: this function and the line it emits are the
// entirety of what depends on that field.
//
// LOCAL WALL-CLOCK PARTS COME FROM Intl.DateTimeFormat's formatToParts
// WITH A `timeZone`. Do not do offset arithmetic by hand and do not
// round-trip through toLocaleString — both are lossy across a DST
// boundary, which is exactly the day this line would be wrong on and
// nobody would notice.
// ----------------------------------------------------------------
function openClosedLine(p: BusinessProfile, now?: Date): string | null {
  const h = p.hours;
  const tz = h?.timezone;
  if (!h || !set(tz)) return null;

  const local = localParts(now ?? new Date(), tz.trim());
  if (!local) return null;

  const today = scheduleFor(h, local.date, local.day);
  const clock = `${pad(local.hour)}:${pad(local.minute)}`;
  const prefix = `It is currently ${DAY_NAMES[local.day]} ${clock} in the business's local time.`;

  const minutes = local.hour * 60 + local.minute;

  // In order, so a lunch break reads correctly: the first interval that
  // contains now is the one that closes.
  for (const span of today) {
    const from = toMinutes(span.open);
    const to = toMinutes(span.close);
    if (from === null || to === null) continue;
    if (minutes >= from && minutes < to) {
      return `${prefix} The business is OPEN and closes at ${span.close.trim()}.`;
    }
  }

  // Still to come today — the ordinary "closed for lunch, back at 13:30".
  const later = today
    .map((s) => ({ s, from: toMinutes(s.open) }))
    .filter((x): x is { s: HoursInterval; from: number } => x.from !== null && x.from > minutes)
    .sort((a, b) => a.from - b.from)[0];
  if (later) return `${prefix} The business is CLOSED and opens at ${later.s.open.trim()}.`;

  const next = nextOpening(h, local.date, local.day);
  if (next) {
    return `${prefix} The business is CLOSED. It next opens ${next.label} at ${next.at}.`;
  }
  return `${prefix} The business is CLOSED.`;
}

/**
 * The intervals in force on one calendar date.
 *
 * AN EXCEPTION FOR THAT DATE WINS OVER THE WEEKLY PATTERN, whether it
 * closes the day or shortens it. That precedence is the entire reason
 * `exceptions` exists — a bank holiday that the grid still calls a
 * Monday would otherwise tell a visitor to come to a locked door.
 */
function scheduleFor(
  h: NonNullable<BusinessProfile['hours']>, date: string, day: DayKey,
): HoursInterval[] {
  for (const e of exceptionList(h.exceptions)) {
    if (e.date.trim() !== date) continue;
    if (e.closed) return [];
    if (set(e.open) && set(e.close)) return [{ open: e.open, close: e.close }];
    // "hours differ" with nothing usable in it: fall through to the
    // weekly pattern rather than claiming the business is shut.
    break;
  }
  return intervalsFor(h.regular?.[day]);
}

/** The next day with any opening at all, within a week. Beyond that a
 *  business is not "closed", it is gone, and a line about next Tuesday
 *  fortnight helps nobody. */
function nextOpening(
  h: NonNullable<BusinessProfile['hours']>, date: string, day: DayKey,
): { label: string; at: string } | null {
  const todayIndex = DAY_BY_INDEX.indexOf(day);
  for (let ahead = 1; ahead <= 7; ahead++) {
    const next = addDays(date, ahead);
    if (!next) return null;
    const nextDay = DAY_BY_INDEX[(todayIndex + ahead) % 7];
    const spans = scheduleFor(h, next, nextDay)
      .map((s) => ({ s, from: toMinutes(s.open) }))
      .filter((x): x is { s: HoursInterval; from: number } => x.from !== null)
      .sort((a, b) => a.from - b.from);
    if (spans.length) {
      return {
        label: ahead === 1 ? 'tomorrow' : DAY_NAMES[nextDay],
        at: spans[0].s.open.trim(),
      };
    }
  }
  return null;
}

/**
 * Wall-clock parts in a named timezone.
 *
 * The weekday is derived from the y/m/d rather than read from the
 * formatter, so nothing depends on a locale's spelling of "Tuesday".
 * Returns null on an unknown zone — Intl throws a RangeError, and this
 * is on the visitor's hot path.
 */
function localParts(
  now: Date, timeZone: string,
): { date: string; day: DayKey; hour: number; minute: number } | null {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-GB', {
      timeZone, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(now);
  } catch { return null; }

  const at = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const year = Number(at('year'));
  const month = Number(at('month'));
  const dayOfMonth = Number(at('day'));
  // `hour12: false` renders midnight as 24 in some ICU versions, which
  // is a correct hour of the previous day and a wrong one here.
  const hour = Number(at('hour')) % 24;
  const minute = Number(at('minute'));
  if (![year, month, dayOfMonth, hour, minute].every(Number.isFinite)) return null;

  // Calendar arithmetic on the local date, never on an instant — which
  // is what keeps this correct across a DST transition.
  const index = new Date(Date.UTC(year, month - 1, dayOfMonth)).getUTCDay();

  return {
    date: `${year}-${pad(month)}-${pad(dayOfMonth)}`,
    day: DAY_BY_INDEX[index],
    hour, minute,
  };
}

/** `"YYYY-MM-DD"` plus n days, in the same calendar space. */
function addDays(date: string, days: number): string | null {
  const [y, m, d] = date.split('-').map(Number);
  if (![y, m, d].every(Number.isFinite)) return null;
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Hold the rendered block to its ceiling.
 *
 * Whole lines, from the end, and the heading is never at risk — it is
 * two lines and the budget is two thousand characters. A tenant past
 * this is writing a document, and documents have a corpus to live in.
 */
function capBlock(lines: string[], budget: number): { lines: string[]; truncated: boolean } {
  const kept: string[] = [];
  let spent = 0;
  for (const line of lines) {
    // +1 for the newline this line will be joined with.
    const cost = line.length + 1;
    if (kept.length > 0 && spent + cost > budget) {
      return { lines: kept, truncated: true };
    }
    kept.push(line);
    spent += cost;
  }
  return { lines: kept, truncated: false };
}
