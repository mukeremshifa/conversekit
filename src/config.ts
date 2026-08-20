// ----------------------------------------------------------------
// Bot Configuration — validation and the widget's public view
//
// Two JSONB columns (supabase/009) hold everything the Bot
// Configuration screen writes. Postgres cannot check their shape, so
// this file is the authority, the same way src/origin.ts is for
// allowed_origins.
//
// Rules that hold throughout:
//   * every field is optional, and absent means "what the widget did
//     before 009" — never an error;
//   * an out-of-range number is clamped, not rejected. A slider that
//     reads 12000 is a UI bug, and failing a whole settings save over
//     one is worse than storing 10000;
//   * an unknown key IS rejected. Silently dropping one hides a typo
//     in a field name until someone wonders why the setting does
//     nothing.
// ----------------------------------------------------------------
import type {
  Bot, BehaviorConfig, WidgetConfig, WidgetPosition, WidgetTheme,
  LeadConfig, LeadFields, LeadTrigger, LeadFieldMode, WebhookFormat,
  FaqItemPayload,
  BusinessProfile, DayKey, HoursException, HoursInterval, ProfileLink,
  ProfileHours, ProfileLocation, ProfileContact, ProfileLinks,
  ProfilePolicies, ProfileIdentity,
} from './types';

export const POSITIONS: WidgetPosition[] = ['bottom-right', 'bottom-left'];
export const THEMES: WidgetTheme[] = ['light', 'dark', 'auto'];
export const TRIGGERS: LeadTrigger[] = ['intent', 'always', 'after_messages'];
export const FIELD_MODES: LeadFieldMode[] = ['off', 'optional', 'required'];
export const WEBHOOK_FORMATS: WebhookFormat[] = ['json', 'slack', 'teams'];

export const LIMITS = {
  /** Long enough for two sentences. The panel is 380px wide. */
  greeting: 300,
  /** Ten seconds. Past that a visitor has decided nothing is coming. */
  greetingDelayMs: 10_000,
  fallbackMessage: 300,
  /** Below four, a bot offers a human before it has heard the question. */
  maxMessages: { min: 4, max: 100 },
  /** Two consecutive misses is the least that can be called a pattern. */
  escalateAfterMisses: { min: 2, max: 10 },

  // ── Lead capture (010) ──
  /** Matched to fallbackMessage — both are one spoken line. */
  successMessage: 300,
  /** Said before a question, so it has to stay short enough to precede
   *  one without becoming the whole reply. */
  consentText: 200,
  /** It renders inside a Badge. */
  leadTag: 40,
  /** Long enough for a signed webhook URL with a query string. URLs are
   *  REJECTED rather than clamped past this: slicing a URL produces a
   *  different, silently broken one, which is the case the
   *  clamp-don't-reject rule at the top of this file does not cover. */
  url: 500,
  /** Below two there is nothing to have waited for. Fifty is past the
   *  point any visitor is still reading. */
  triggerAfterMessages: { min: 2, max: 50 },
  /** A distribution list's worth. Past this a tenant wants a shared
   *  inbox, not more rows in a settings form. */
  emailRecipients: 5,

  // ── Knowledge pipeline (011) ──
  //
  // These two are the ONLY tenant-authored text left in the system
  // prompt, and until now both were uncapped `text` with no limit in
  // the schema, none here, and none in the UI. A tenant who pasted
  // 40 KB shipped 40 KB on every message, forever, crowding out the
  // retrieved chunks and the conversation history alike.
  //
  // Truncated rather than rejected, per the clamp-don't-reject rule at
  // the top of this file: a settings save that fails on length loses
  // every other edit in the form along with it.
  /** Three or four sentences. Anything longer is a document, and
   *  documents belong in the corpus where they are searched. */
  businessDescription: 600,
  /** Long enough for a page of standing rules. Past that a tenant is
   *  writing knowledge, not instructions. */
  customInstructions: 2000,

  /** FAQ items per bot. Sized against MAX_CHUNKS (400 in rag/ingest.ts)
   *  so a full FAQ still leaves room for a long answer to split. */
  faqItems: 200,
  faqQuestion: 300,
  faqAnswer: 2000,

  // ── Business profile (015) ──
  //
  // The profile is PROMPT-RESIDENT ON EVERY TURN — that is the whole
  // point of Tier 0 — so unlike the corpus it has no budget to spend
  // and needs a ceiling of its own.
  //
  // Truncated rather than rejected, per the clamp-don't-reject rule at
  // the top of this file: six sections save independently against one
  // jsonb column, and a save that fails on the length of one field
  // takes every other edit in that section down with it.
  profile: {
    /** Per free-text field — tagline, notes, cancellation, parking.
     *  Matched to `consentText` and `greeting`: one or two spoken
     *  lines, not a paragraph. */
    text: 300,
    /** The whole rendered block, in characters. Past this a tenant is
     *  writing a document, and documents have a corpus to live in. */
    rendered: 2000,
    customLinks: 6,
    socials: 6,
    /** A year of bank holidays with room to spare. */
    exceptions: 20,
    /** Also the cap on `languages` — both are short lists of one-word
     *  entries and there is no reason for two numbers. */
    paymentMethods: 12,
  },

  // ── Public chat path ──
  //
  // The only cap on this list that is not about a tenant's settings
  // form, and the only one a stranger can hit. `message` was checked
  // for non-empty and nothing else, so an unbounded string reached an
  // embedding call and a provider call on the platform's shared key.
  // That is a cost hole rather than a safety one, which is exactly why
  // no moderation filter would have closed it.
  //
  // REJECTED rather than clamped, against the rule at the top of this
  // file. That rule exists so a settings save cannot lose unrelated
  // edits, and there is no form here to lose — while truncating a
  // visitor's question answers a different question than they asked.
  /** Several paragraphs. Longer than anything a visitor types into a
   *  380px panel, short enough that a script cannot bill the platform
   *  for a novel per request. Mirrored as `maxlength` in the widget,
   *  which is a courtesy to the visitor; this is the control. */
  chatMessage: 2000,
} as const;

/**
 * The prompt-resident text columns and what each is capped at.
 *
 * Named rather than inlined at the call site because the dashboard
 * mirrors these numbers and the migration's CHECK constraints repeat
 * them — three copies is already one too many, so at least the Worker's
 * two agree by construction.
 */
export const PROMPT_TEXT_CAPS: Record<string, number> = {
  business_description: LIMITS.businessDescription,
  custom_instructions:  LIMITS.customInstructions,
};

/**
 * Trim and cap the prompt-resident text fields of a bot update, in
 * place. Fields the payload does not carry are left alone — a partial
 * update must never blank a column it did not mention.
 *
 * Returns the fields it actually shortened, so the route can say so
 * rather than silently storing something other than what was sent.
 */
export function capPromptText(payload: Record<string, unknown>): string[] {
  const truncated: string[] = [];
  for (const [field, max] of Object.entries(PROMPT_TEXT_CAPS)) {
    const raw = payload[field];
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (value.length > max) {
      truncated.push(field);
      payload[field] = value.slice(0, max);
    } else {
      payload[field] = value;
    }
  }
  return truncated;
}

type Ok<T> = { ok: true; value: T };
type Err = { ok: false; error: string };

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Trim, cap, and treat an empty string as "unset" rather than as "". */
function text(raw: unknown, max: number, field: string): Ok<string | undefined> | Err {
  if (typeof raw !== 'string') return { ok: false, error: `\`${field}\` must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };
  return { ok: true, value: value.slice(0, max) };
}

/**
 * A counter where 0 means off and anything else is clamped into range.
 * Off has to be expressible as a number because that is what a form
 * posts when the tenant clears the field.
 */
function counter(raw: unknown, min: number, max: number, field: string): Ok<number | undefined> | Err {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return { ok: false, error: `\`${field}\` must be a number` };
  }
  const n = Math.round(raw);
  if (n <= 0) return { ok: true, value: 0 };
  return { ok: true, value: clamp(n, min, max) };
}

function bool(raw: unknown, field: string): Ok<boolean> | Err {
  if (typeof raw !== 'boolean') return { ok: false, error: `\`${field}\` must be true or false` };
  return { ok: true, value: raw };
}

/** An object with no keys set is stored as NULL, not as `{}` — so
 *  "never configured" and "configured back to defaults" read alike. */
function orNull<T extends object>(out: T): T | null {
  return Object.keys(out).length ? out : null;
}

// ----------------------------------------------------------------
// widget_config
// ----------------------------------------------------------------
const WIDGET_KEYS = [
  'position', 'theme', 'greeting', 'greeting_delay_ms', 'show_typing', 'show_citations',
] as const;

export function validateWidgetConfig(input: unknown): Ok<WidgetConfig | null> | Err {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '`widget_config` must be an object or null' };
  }

  const src = input as Record<string, unknown>;
  const out: WidgetConfig = {};

  for (const key of Object.keys(src)) {
    // logo_key names an R2 object. A tenant who could set it by hand
    // could name another tenant's object, so it is writable only by the
    // upload route and is carried forward server-side on every save.
    if (key === 'logo_key') {
      return { ok: false, error: '`logo_key` is set by the logo upload route, not by this field' };
    }
    if (!(WIDGET_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `Unknown widget setting '${key}'` };
    }
  }

  if (src.position !== undefined) {
    if (!POSITIONS.includes(src.position as WidgetPosition)) {
      return { ok: false, error: `\`position\` must be one of: ${POSITIONS.join(', ')}` };
    }
    out.position = src.position as WidgetPosition;
  }

  if (src.theme !== undefined) {
    if (!THEMES.includes(src.theme as WidgetTheme)) {
      return { ok: false, error: `\`theme\` must be one of: ${THEMES.join(', ')}` };
    }
    out.theme = src.theme as WidgetTheme;
  }

  if (src.greeting !== undefined) {
    const r = text(src.greeting, LIMITS.greeting, 'greeting');
    if (!r.ok) return r;
    if (r.value !== undefined) out.greeting = r.value;
  }

  if (src.greeting_delay_ms !== undefined) {
    if (typeof src.greeting_delay_ms !== 'number' || !Number.isFinite(src.greeting_delay_ms)) {
      return { ok: false, error: '`greeting_delay_ms` must be a number' };
    }
    const ms = clamp(Math.round(src.greeting_delay_ms), 0, LIMITS.greetingDelayMs);
    if (ms > 0) out.greeting_delay_ms = ms;
  }

  if (src.show_typing !== undefined) {
    const r = bool(src.show_typing, 'show_typing');
    if (!r.ok) return r;
    out.show_typing = r.value;
  }

  if (src.show_citations !== undefined) {
    const r = bool(src.show_citations, 'show_citations');
    if (!r.ok) return r;
    out.show_citations = r.value;
  }

  return { ok: true, value: orNull(out) };
}

// ----------------------------------------------------------------
// behavior_config
// ----------------------------------------------------------------
const BEHAVIOR_KEYS = ['max_messages', 'fallback_message', 'escalate_after_misses'] as const;

export function validateBehaviorConfig(input: unknown): Ok<BehaviorConfig | null> | Err {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '`behavior_config` must be an object or null' };
  }

  const src = input as Record<string, unknown>;
  const out: BehaviorConfig = {};

  for (const key of Object.keys(src)) {
    if (!(BEHAVIOR_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `Unknown behaviour setting '${key}'` };
    }
  }

  if (src.max_messages !== undefined) {
    const r = counter(src.max_messages, LIMITS.maxMessages.min, LIMITS.maxMessages.max, 'max_messages');
    if (!r.ok) return r;
    if (r.value) out.max_messages = r.value;
  }

  if (src.escalate_after_misses !== undefined) {
    const r = counter(
      src.escalate_after_misses,
      LIMITS.escalateAfterMisses.min, LIMITS.escalateAfterMisses.max,
      'escalate_after_misses',
    );
    if (!r.ok) return r;
    if (r.value) out.escalate_after_misses = r.value;
  }

  if (src.fallback_message !== undefined) {
    const r = text(src.fallback_message, LIMITS.fallbackMessage, 'fallback_message');
    if (!r.ok) return r;
    if (r.value !== undefined) out.fallback_message = r.value;
  }

  return { ok: true, value: orNull(out) };
}

// ----------------------------------------------------------------
// lead_config
// ----------------------------------------------------------------

/**
 * A URL a tenant typed, checked before it is stored.
 *
 * `secure` is the difference between the two URL fields this file
 * validates. booking_url is a link the bot reads out to a visitor, so
 * http is tolerable; webhook_url is a destination this Worker POSTs a
 * name, an email and a phone number to, and plaintext is not.
 *
 * The host rules are an SSRF boundary rather than a typo check. A
 * tenant supplies this string and the Worker fetches it, so it must not
 * be able to name something that is only reachable from inside. The
 * platform already refuses most of these at fetch time — the point of
 * checking here is that a save-time rejection is legible, whereas a
 * fetch-time one is a log line nobody reads.
 */
export function validateUrl(
  raw: unknown, field: string, opts: { secure: boolean },
): Ok<string | undefined> | Err {
  if (typeof raw !== 'string') return { ok: false, error: `\`${field}\` must be a string` };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };

  // Not clamped. See LIMITS.url.
  if (value.length > LIMITS.url) {
    return { ok: false, error: `\`${field}\` must be ${LIMITS.url} characters or fewer` };
  }

  let url: URL;
  try { url = new URL(value); }
  catch { return { ok: false, error: `\`${field}\` is not a valid URL` }; }

  if (opts.secure) {
    if (url.protocol !== 'https:') {
      return { ok: false, error: `\`${field}\` must start with https:// — it carries contact details` };
    }
  } else if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: `\`${field}\` must start with https:// or http://` };
  }

  // https://user:pass@host/ — the credentials would be logged by every
  // hop and are never what someone meant to paste.
  if (url.username || url.password) {
    return { ok: false, error: `\`${field}\` must not contain a username or password` };
  }

  const host = url.hostname.toLowerCase();
  const bad =
    host === 'localhost' || host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    // WHATWG keeps IPv6 hosts bracketed, so one check covers [::1] and
    // every other literal form.
    host.startsWith('[') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    // A host with no dot is an intranet name, never a public one.
    !host.includes('.');
  if (bad) {
    return { ok: false, error: `\`${field}\` must be a public hostname, not an internal address` };
  }

  return { ok: true, value };
}

const LEAD_KEYS = [
  'enabled', 'trigger', 'trigger_after_messages', 'fields', 'consent_text',
  'success_message', 'booking_url', 'tag', 'webhook_url', 'webhook_format',
  'email_recipients',
] as const;

/**
 * Notification recipients.
 *
 * The check is deliberately shallow — one `@`, no spaces, a dot in the
 * domain. A stricter regex rejects valid addresses (every RFC-correct
 * one is longer than people expect), and the only test that settles it
 * is whether mail arrives. Five is a distribution list's worth; past
 * that a tenant wants a shared inbox, not more rows in a settings form.
 */
function validateRecipients(input: unknown): Ok<string[] | undefined> | Err {
  if (!Array.isArray(input)) return { ok: false, error: '`email_recipients` must be an array' };
  if (input.length > LIMITS.emailRecipients) {
    return { ok: false, error: `At most ${LIMITS.emailRecipients} email recipients` };
  }

  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return { ok: false, error: 'Each recipient must be a string' };
    const value = raw.trim();
    if (!value) continue;
    if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      return { ok: false, error: `'${raw}' is not a valid email address` };
    }
    const lower = value.toLowerCase();
    if (!out.includes(lower)) out.push(lower);
  }
  return { ok: true, value: out.length ? out : undefined };
}

const LEAD_FIELD_KEYS = ['phone', 'company', 'inquiry'] as const;

function validateLeadFields(input: unknown): Ok<LeadFields | undefined> | Err {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: '`fields` must be an object' };
  }
  const src = input as Record<string, unknown>;
  const out: LeadFields = {};

  for (const key of Object.keys(src)) {
    if (key === 'name' || key === 'email') {
      return {
        ok: false,
        error: '`name` and `email` are always required and cannot be configured',
      };
    }
    if (!(LEAD_FIELD_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `Unknown lead field '${key}'` };
    }
  }

  for (const key of LEAD_FIELD_KEYS) {
    const mode = src[key];
    if (mode === undefined) continue;
    if (!FIELD_MODES.includes(mode as LeadFieldMode)) {
      return { ok: false, error: `\`fields.${key}\` must be one of: ${FIELD_MODES.join(', ')}` };
    }
    out[key] = mode as LeadFieldMode;
  }

  return { ok: true, value: Object.keys(out).length ? out : undefined };
}

export function validateLeadConfig(input: unknown): Ok<LeadConfig | null> | Err {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '`lead_config` must be an object or null' };
  }

  const src = input as Record<string, unknown>;
  const out: LeadConfig = {};

  for (const key of Object.keys(src)) {
    // The two display-only fields redactBotSecrets substitutes for the
    // URL. A form that round-trips the whole object sends them back, so
    // they are dropped rather than rejected — unlike a genuinely
    // unknown key, their presence is expected, not a typo.
    if (key === 'has_webhook' || key === 'webhook_host') continue;
    if (!(LEAD_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `Unknown lead setting '${key}'` };
    }
  }

  if (src.enabled !== undefined) {
    const r = bool(src.enabled, 'enabled');
    if (!r.ok) return r;
    out.enabled = r.value;
  }

  if (src.trigger !== undefined) {
    if (!TRIGGERS.includes(src.trigger as LeadTrigger)) {
      return { ok: false, error: `\`trigger\` must be one of: ${TRIGGERS.join(', ')}` };
    }
    out.trigger = src.trigger as LeadTrigger;
  }

  if (src.trigger_after_messages !== undefined) {
    const r = counter(
      src.trigger_after_messages,
      LIMITS.triggerAfterMessages.min, LIMITS.triggerAfterMessages.max,
      'trigger_after_messages',
    );
    if (!r.ok) return r;
    if (r.value) out.trigger_after_messages = r.value;
  }

  if (src.fields !== undefined) {
    const r = validateLeadFields(src.fields);
    if (!r.ok) return r;
    if (r.value) out.fields = r.value;
  }

  if (src.consent_text !== undefined) {
    const r = text(src.consent_text, LIMITS.consentText, 'consent_text');
    if (!r.ok) return r;
    if (r.value !== undefined) out.consent_text = r.value;
  }

  if (src.success_message !== undefined) {
    const r = text(src.success_message, LIMITS.successMessage, 'success_message');
    if (!r.ok) return r;
    if (r.value !== undefined) out.success_message = r.value;
  }

  if (src.tag !== undefined) {
    const r = text(src.tag, LIMITS.leadTag, 'tag');
    if (!r.ok) return r;
    if (r.value !== undefined) out.tag = r.value;
  }

  if (src.booking_url !== undefined) {
    const r = validateUrl(src.booking_url, 'booking_url', { secure: false });
    if (!r.ok) return r;
    if (r.value !== undefined) out.booking_url = r.value;
  }

  if (src.webhook_url === null) {
    // An explicit clear. Kept as a literal null through validation so
    // mergeConfigs can tell it apart from "the form did not send one",
    // which is every ordinary save — the form is never given the URL
    // and so can never echo it back. See the note there.
    out.webhook_url = null;
  } else if (src.webhook_url !== undefined) {
    const r = validateUrl(src.webhook_url, 'webhook_url', { secure: true });
    if (!r.ok) return r;
    // An empty string is "unset", which here means "not sent" — never
    // "delete it". Clearing is null, and only null.
    if (r.value !== undefined) out.webhook_url = r.value;
  }

  if (src.webhook_format !== undefined) {
    if (!WEBHOOK_FORMATS.includes(src.webhook_format as WebhookFormat)) {
      return { ok: false, error: `\`webhook_format\` must be one of: ${WEBHOOK_FORMATS.join(', ')}` };
    }
    out.webhook_format = src.webhook_format as WebhookFormat;
  }

  if (src.email_recipients !== undefined) {
    const r = validateRecipients(src.email_recipients);
    if (!r.ok) return r;
    if (r.value) out.email_recipients = r.value;
  }

  return { ok: true, value: orNull(out) };
}

// ----------------------------------------------------------------
// Business profile (bots.profile, 015)
//
// The largest validator in this file, and structurally the simplest:
// six independent sections, every field optional, unknown keys
// rejected, free text trimmed to LIMITS.profile.text, URLs through
// validateUrl.
//
// TWO RULES THAT ARE NOT NEGOTIABLE AND ARE EASY TO GET BACKWARDS:
//
//   * TEXT IS CLAMPED, URLS ARE REJECTED. Slicing a URL produces a
//     different, silently broken one — the exception LIMITS.url already
//     records. Slicing a tagline produces a shorter tagline.
//
//   * TIMES AND DATES ARE REJECTED, NOT CLAMPED. "25:99" is not a time
//     that can be shortened into one, and a clamp would put a number
//     into the prompt that the tenant never typed and cannot see is
//     wrong. This is the same call validateFaqItem makes for the same
//     reason: it is content, not a slider.
//
// The whole object is REPLACED WHOLESALE on save — see mergeConfigs in
// src/supabase.ts, and note that unlike widget_config and lead_config
// it needs no carried-forward key, because it holds no secret.
// ----------------------------------------------------------------
const PROFILE_KEYS = ['identity', 'location', 'contact', 'hours', 'links', 'policies'] as const;

const IDENTITY_KEYS = ['legal_name', 'tagline', 'industry'] as const;
const LOCATION_KEYS = [
  'line1', 'line2', 'city', 'region', 'postal', 'country',
  'map_url', 'service_area', 'parking', 'notes',
] as const;
const CONTACT_KEYS = ['phone', 'whatsapp', 'email', 'support_email', 'notes', 'socials'] as const;
const HOURS_KEYS = ['timezone', 'regular', 'exceptions', 'notes'] as const;
const LINKS_KEYS = ['booking_url', 'pricing_url', 'portal_url', 'custom'] as const;
const POLICY_KEYS = [
  'payment_methods', 'cancellation', 'deposit', 'accessibility', 'languages',
] as const;

export const DAY_KEYS: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/** 24-hour `"HH:MM"`. Anchored, so "9:00pm" and "09:00 " are both out. */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** `"YYYY-MM-DD"`. Shape only — 2026-02-31 passes here and is a date
 *  nobody will ever have an exception on, which is cheaper to allow
 *  than a calendar in a validator. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const unknownKey = (key: string, allowed: readonly string[], where: string): Err | null =>
  allowed.includes(key) ? null : { ok: false, error: `Unknown ${where} field '${key}'` };

/** An object, not an array, not null — the shape every section must be. */
function profileSection(raw: unknown, field: string): Ok<Record<string, unknown>> | Err {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `\`profile.${field}\` must be an object` };
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

/** Trim-and-clamp, into `out[key]` only when something survived. */
function assignText(
  out: Record<string, unknown>, src: Record<string, unknown>, key: string, label: string,
): Err | null {
  if (src[key] === undefined) return null;
  const r = text(src[key], LIMITS.profile.text, label);
  if (!r.ok) return r;
  if (r.value !== undefined) out[key] = r.value;
  return null;
}

function assignUrl(
  out: Record<string, unknown>, src: Record<string, unknown>, key: string, label: string,
): Err | null {
  if (src[key] === undefined) return null;
  const r = validateUrl(src[key], label, { secure: false });
  if (!r.ok) return r;
  if (r.value !== undefined) out[key] = r.value;
  return null;
}

/** A label/url pair list — socials and custom links, which differ only
 *  in their cap and their error message. */
function validateLinkRows(
  raw: unknown, max: number, label: string,
): Ok<ProfileLink[] | undefined> | Err {
  if (!Array.isArray(raw)) return { ok: false, error: `\`${label}\` must be an array` };
  if (raw.length > max) return { ok: false, error: `At most ${max} ${label}` };

  const out: ProfileLink[] = [];
  for (const row of raw) {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return { ok: false, error: `Each entry in \`${label}\` must be an object` };
    }
    const src = row as Record<string, unknown>;
    for (const key of Object.keys(src)) {
      const bad = unknownKey(key, ['label', 'url'], label);
      if (bad) return bad;
    }
    const name = text(src.label ?? '', LIMITS.profile.text, `${label}.label`);
    if (!name.ok) return name;
    const url = validateUrl(src.url ?? '', `${label}.url`, { secure: false });
    if (!url.ok) return url;
    // A half-filled row is what an empty "Add link" row looks like
    // before anyone types in it. Dropped rather than rejected — the
    // form should not refuse to save because a blank row is open.
    if (!name.value || !url.value) continue;
    out.push({ label: name.value, url: url.value });
  }
  return { ok: true, value: out.length ? out : undefined };
}

/** A list of short labels — payment methods, languages spoken. */
function validateLabels(raw: unknown, max: number, label: string): Ok<string[] | undefined> | Err {
  if (!Array.isArray(raw)) return { ok: false, error: `\`${label}\` must be an array` };
  if (raw.length > max) return { ok: false, error: `At most ${max} ${label}` };

  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') {
      return { ok: false, error: `Each entry in \`${label}\` must be a string` };
    }
    const value = entry.trim().slice(0, LIMITS.profile.text);
    if (!value || out.includes(value)) continue;
    out.push(value);
  }
  return { ok: true, value: out.length ? out : undefined };
}

/**
 * One day's opening intervals.
 *
 * CLOSE MUST BE AFTER OPEN, AND INTERVALS MUST NOT OVERLAP. Neither is
 * pedantry: the computed open/closed line in src/profile.ts walks them
 * in order and answers with the first that contains the current minute,
 * so a reversed pair silently means "never open" and an overlapping
 * pair means "closes at whichever one you happened to list first".
 */
function validateDay(raw: unknown, day: DayKey): Ok<HoursInterval[] | undefined> | Err {
  if (!Array.isArray(raw)) return { ok: false, error: `\`hours.regular.${day}\` must be an array` };

  const out: HoursInterval[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, error: `Each interval on ${day} must be an object` };
    }
    const src = entry as Record<string, unknown>;
    for (const key of Object.keys(src)) {
      const bad = unknownKey(key, ['open', 'close'], `hours.regular.${day}`);
      if (bad) return bad;
    }
    const open = typeof src.open === 'string' ? src.open.trim() : '';
    const close = typeof src.close === 'string' ? src.close.trim() : '';
    // A row with neither is an empty one the form left open.
    if (!open && !close) continue;
    if (!TIME_RE.test(open) || !TIME_RE.test(close)) {
      return {
        ok: false,
        error: `Times on ${day} must be HH:MM, 24-hour — got '${open || '(empty)'}' to '${close || '(empty)'}'`,
      };
    }
    if (close <= open) {
      return { ok: false, error: `On ${day}, ${close} is not after ${open}` };
    }
    out.push({ open, close });
  }

  // Sorted before the overlap check, so a tenant listing the afternoon
  // first is corrected rather than refused — and so the renderer's
  // "first interval that contains now" walk is in clock order.
  out.sort((a, b) => a.open.localeCompare(b.open));
  for (let i = 1; i < out.length; i++) {
    if (out[i].open < out[i - 1].close) {
      return {
        ok: false,
        error: `Opening hours on ${day} overlap: ${out[i - 1].open}-${out[i - 1].close} and ${out[i].open}-${out[i].close}`,
      };
    }
  }

  return { ok: true, value: out.length ? out : undefined };
}

function validateExceptions(raw: unknown): Ok<HoursException[] | undefined> | Err {
  if (!Array.isArray(raw)) return { ok: false, error: '`hours.exceptions` must be an array' };
  if (raw.length > LIMITS.profile.exceptions) {
    return { ok: false, error: `At most ${LIMITS.profile.exceptions} date exceptions` };
  }

  const out: HoursException[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, error: 'Each date exception must be an object' };
    }
    const src = entry as Record<string, unknown>;
    for (const key of Object.keys(src)) {
      const bad = unknownKey(key, ['date', 'closed', 'open', 'close', 'label'], 'hours.exceptions');
      if (bad) return bad;
    }

    const date = typeof src.date === 'string' ? src.date.trim() : '';
    if (!date) continue;                    // an empty row the form left open
    if (!DATE_RE.test(date)) {
      return { ok: false, error: `Exception dates must be YYYY-MM-DD — got '${date}'` };
    }

    const ex: HoursException = { date };
    if (src.closed !== undefined) {
      const r = bool(src.closed, 'closed');
      if (!r.ok) return r;
      if (r.value) ex.closed = true;
    }

    const open = typeof src.open === 'string' ? src.open.trim() : '';
    const close = typeof src.close === 'string' ? src.close.trim() : '';
    if (open || close) {
      if (!TIME_RE.test(open) || !TIME_RE.test(close)) {
        return { ok: false, error: `Times on ${date} must be HH:MM, 24-hour` };
      }
      if (close <= open) return { ok: false, error: `On ${date}, ${close} is not after ${open}` };
      ex.open = open;
      ex.close = close;
    }

    if (src.label !== undefined) {
      const r = text(src.label, LIMITS.profile.text, 'label');
      if (!r.ok) return r;
      if (r.value !== undefined) ex.label = r.value;
    }

    // Neither closed nor a pair of times says nothing at all, and the
    // renderer would emit "hours differ" with no answer to the obvious
    // follow-up. Rejected here so it is a sentence in the form rather
    // than a shrug in the prompt.
    if (!ex.closed && !ex.open) {
      return {
        ok: false,
        error: `The exception on ${date} needs either "closed" or an open and close time`,
      };
    }
    out.push(ex);
  }

  return { ok: true, value: out.length ? out : undefined };
}

/**
 * An IANA zone name.
 *
 * Checked against `Intl.supportedValuesOf('timeZone')` where the
 * runtime has it, and against the Area/City shape where it does not.
 * The Workers runtime ships full ICU, but the introspection API is a
 * separate proposal and BotConfiguration.tsx already guards it the same
 * way — depending on it here would be depending on it twice.
 */
function validateTimezone(raw: unknown): Ok<string | undefined> | Err {
  if (typeof raw !== 'string') return { ok: false, error: '`hours.timezone` must be a string' };
  const value = raw.trim();
  if (!value) return { ok: true, value: undefined };

  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
    .supportedValuesOf;
  if (typeof supported === 'function') {
    let zones: string[] = [];
    try { zones = supported.call(Intl, 'timeZone'); } catch { zones = []; }
    if (zones.length) {
      // UTC is not in the list on every runtime, and it is the one zone
      // a tenant can name that is certainly valid.
      if (value !== 'UTC' && !zones.includes(value)) {
        return { ok: false, error: `'${value}' is not a known time zone` };
      }
      return { ok: true, value };
    }
  }

  if (value !== 'UTC' && !/^[A-Za-z_+-]+\/[A-Za-z0-9_+\-/]+$/.test(value)) {
    return { ok: false, error: `'${value}' is not a known time zone` };
  }
  return { ok: true, value };
}

function validateHours(input: unknown): Ok<ProfileHours | undefined> | Err {
  const s = profileSection(input, 'hours');
  if (!s.ok) return s;
  const src = s.value;
  const out: ProfileHours = {};

  for (const key of Object.keys(src)) {
    const bad = unknownKey(key, HOURS_KEYS, 'hours');
    if (bad) return bad;
  }

  if (src.timezone !== undefined) {
    const r = validateTimezone(src.timezone);
    if (!r.ok) return r;
    if (r.value) out.timezone = r.value;
  }

  if (src.regular !== undefined) {
    const days = profileSection(src.regular, 'hours.regular');
    if (!days.ok) return days;
    const regular: Partial<Record<DayKey, HoursInterval[]>> = {};
    for (const key of Object.keys(days.value)) {
      if (!DAY_KEYS.includes(key as DayKey)) {
        return {
          ok: false,
          error: `\`hours.regular\` keys must be one of: ${DAY_KEYS.join(', ')} — got '${key}'`,
        };
      }
    }
    for (const day of DAY_KEYS) {
      if (days.value[day] === undefined) continue;
      const r = validateDay(days.value[day], day);
      if (!r.ok) return r;
      // A day with no intervals is CLOSED, and closed is the absence of
      // the key rather than an empty array — the same rule orNull
      // applies to the object as a whole.
      if (r.value) regular[day] = r.value;
    }
    if (Object.keys(regular).length) out.regular = regular;
  }

  if (src.exceptions !== undefined) {
    const r = validateExceptions(src.exceptions);
    if (!r.ok) return r;
    if (r.value) out.exceptions = r.value;
  }

  const bad = assignText(out as Record<string, unknown>, src, 'notes', 'hours.notes');
  if (bad) return bad;

  return { ok: true, value: Object.keys(out).length ? out : undefined };
}

export function validateProfile(input: unknown): Ok<BusinessProfile | null> | Err {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: '`profile` must be an object or null' };
  }

  const src = input as Record<string, unknown>;
  const out: BusinessProfile = {};

  for (const key of Object.keys(src)) {
    const bad = unknownKey(key, PROFILE_KEYS, 'profile');
    if (bad) return bad;
  }

  // ── identity ──
  if (src.identity !== undefined) {
    const s = profileSection(src.identity, 'identity');
    if (!s.ok) return s;
    const o: Record<string, unknown> = {};
    for (const key of Object.keys(s.value)) {
      const bad = unknownKey(key, IDENTITY_KEYS, 'identity');
      if (bad) return bad;
    }
    for (const key of IDENTITY_KEYS) {
      const bad = assignText(o, s.value, key, `identity.${key}`);
      if (bad) return bad;
    }
    if (Object.keys(o).length) out.identity = o as ProfileIdentity;
  }

  // ── location ──
  if (src.location !== undefined) {
    const s = profileSection(src.location, 'location');
    if (!s.ok) return s;
    const o: Record<string, unknown> = {};
    for (const key of Object.keys(s.value)) {
      const bad = unknownKey(key, LOCATION_KEYS, 'location');
      if (bad) return bad;
    }
    for (const key of LOCATION_KEYS) {
      const bad = key === 'map_url'
        ? assignUrl(o, s.value, key, 'location.map_url')
        : assignText(o, s.value, key, `location.${key}`);
      if (bad) return bad;
    }
    if (Object.keys(o).length) out.location = o as ProfileLocation;
  }

  // ── contact ──
  if (src.contact !== undefined) {
    const s = profileSection(src.contact, 'contact');
    if (!s.ok) return s;
    const o: Record<string, unknown> = {};
    for (const key of Object.keys(s.value)) {
      const bad = unknownKey(key, CONTACT_KEYS, 'contact');
      if (bad) return bad;
    }
    // Phone numbers are NOT pattern-checked. Every strict format
    // rejects somebody's real number, and the only test that settles it
    // is whether the call connects — the same judgement
    // validateRecipients makes about email addresses above.
    for (const key of CONTACT_KEYS) {
      if (key === 'socials') {
        if (s.value.socials === undefined) continue;
        const r = validateLinkRows(s.value.socials, LIMITS.profile.socials, 'contact.socials');
        if (!r.ok) return r;
        if (r.value) o.socials = r.value;
      } else {
        const bad = assignText(o, s.value, key, `contact.${key}`);
        if (bad) return bad;
      }
    }
    if (Object.keys(o).length) out.contact = o as ProfileContact;
  }

  // ── hours ──
  if (src.hours !== undefined) {
    const r = validateHours(src.hours);
    if (!r.ok) return r;
    if (r.value) out.hours = r.value;
  }

  // ── links ──
  if (src.links !== undefined) {
    const s = profileSection(src.links, 'links');
    if (!s.ok) return s;
    const o: Record<string, unknown> = {};
    for (const key of Object.keys(s.value)) {
      const bad = unknownKey(key, LINKS_KEYS, 'links');
      if (bad) return bad;
    }
    for (const key of LINKS_KEYS) {
      if (key === 'custom') {
        if (s.value.custom === undefined) continue;
        const r = validateLinkRows(s.value.custom, LIMITS.profile.customLinks, 'links.custom');
        if (!r.ok) return r;
        if (r.value) o.custom = r.value;
      } else {
        const bad = assignUrl(o, s.value, key, `links.${key}`);
        if (bad) return bad;
      }
    }
    if (Object.keys(o).length) out.links = o as ProfileLinks;
  }

  // ── policies ──
  if (src.policies !== undefined) {
    const s = profileSection(src.policies, 'policies');
    if (!s.ok) return s;
    const o: Record<string, unknown> = {};
    for (const key of Object.keys(s.value)) {
      const bad = unknownKey(key, POLICY_KEYS, 'policies');
      if (bad) return bad;
    }
    // In POLICY_KEYS order rather than by kind, so the stored object's
    // key order is the declared one. jsonb preserves insertion order,
    // and a validator that reordered keys would make every save show up
    // as a change to anything diffing the column.
    for (const key of POLICY_KEYS) {
      if (key === 'payment_methods' || key === 'languages') {
        if (s.value[key] === undefined) continue;
        const r = validateLabels(s.value[key], LIMITS.profile.paymentMethods, `policies.${key}`);
        if (!r.ok) return r;
        if (r.value) o[key] = r.value;
      } else {
        const bad = assignText(o, s.value, key, `policies.${key}`);
        if (bad) return bad;
      }
    }
    if (Object.keys(o).length) out.policies = o as ProfilePolicies;
  }

  // Empty stores as NULL, so "never configured" and "configured back to
  // defaults" read alike — as they do for widget_config,
  // behavior_config and lead_config, and as profileFor() depends on.
  return { ok: true, value: orNull(out) };
}

// ----------------------------------------------------------------
// FAQ items (011)
//
// Unlike the three config blobs above, these are ordinary columns that
// Postgres can and does check. The validation here exists for the error
// message: a length CHECK surfaces through PostgREST as an opaque
// constraint name, and "Question must be 300 characters or fewer" is
// the difference between a tenant fixing their own typo and filing a
// ticket.
//
// Rejected rather than clamped, breaking the rule at the top of this
// file — and deliberately. A settings slider that reads 12000 is a UI
// bug worth swallowing; a question silently cut in half is content the
// tenant wrote and can see was mangled.
// ----------------------------------------------------------------
const FAQ_KEYS = ['question', 'answer', 'enabled', 'position'] as const;

export function validateFaqItem(
  input: unknown, opts: { partial?: boolean } = {},
): Ok<FaqItemPayload> | Err {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'A FAQ item must be an object' };
  }
  const src = input as Record<string, unknown>;
  const out: FaqItemPayload = {};

  for (const key of Object.keys(src)) {
    if (!(FAQ_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: `Unknown FAQ field '${key}'` };
    }
  }

  for (const [field, max, label] of [
    ['question', LIMITS.faqQuestion, 'Question'],
    ['answer',   LIMITS.faqAnswer,   'Answer'],
  ] as const) {
    const raw = src[field];
    if (raw === undefined) {
      // A create needs both; a patch may carry either.
      if (!opts.partial) return { ok: false, error: `\`${field}\` is required` };
      continue;
    }
    if (typeof raw !== 'string') return { ok: false, error: `\`${field}\` must be a string` };
    const value = raw.trim();
    // An empty question embeds to noise and an empty answer teaches the
    // bot nothing — both are worse than the item not existing.
    if (!value) return { ok: false, error: `${label} cannot be empty` };
    if (value.length > max) return { ok: false, error: `${label} must be ${max} characters or fewer` };
    out[field] = value;
  }

  if (src.enabled !== undefined) {
    const r = bool(src.enabled, 'enabled');
    if (!r.ok) return r;
    out.enabled = r.value;
  }

  if (src.position !== undefined) {
    if (typeof src.position !== 'number' || !Number.isFinite(src.position)) {
      return { ok: false, error: '`position` must be a number' };
    }
    out.position = clamp(Math.round(src.position), 0, 100_000);
  }

  return { ok: true, value: out };
}

// ----------------------------------------------------------------
// Readers
// ----------------------------------------------------------------
export function widgetConfigFor(bot: Bot): WidgetConfig {
  return bot.widget_config ?? {};
}

export function leadConfigFor(bot: Bot): LeadConfig {
  return bot.lead_config ?? {};
}

/**
 * Is lead capture on for this bot?
 *
 * `enabled` absent means yes: capture is what the prompt did before 010
 * and turning it off has to be a decision someone made, not a default a
 * migration introduced.
 */
export function leadCaptureEnabled(bot: Bot): boolean {
  return leadConfigFor(bot).enabled !== false;
}

export function behaviorConfigFor(bot: Bot): BehaviorConfig {
  return bot.behavior_config ?? {};
}

/**
 * The widget's view of widget_config, for GET /v1/bots/:id/health.
 *
 * Only set fields are emitted, and defaults are deliberately NOT filled
 * in here: widget.js owns what a bot looks like when it has configured
 * nothing, and a second copy of those defaults in the Worker is a
 * second thing to keep in sync. camelCase to match the rest of that
 * response (`primaryColor`, `businessName`).
 *
 * logo_key never leaves the Worker — the widget gets a URL that the
 * Worker serves, so R2 keys stay private and cannot be probed.
 */
export function widgetPublicConfig(bot: Bot, logoUrl: string | null): Record<string, unknown> | null {
  const cfg = widgetConfigFor(bot);
  const out: Record<string, unknown> = {};

  if (cfg.position)            out.position        = cfg.position;
  if (cfg.theme)               out.theme           = cfg.theme;
  if (cfg.greeting)            out.greeting        = cfg.greeting;
  if (cfg.greeting_delay_ms)   out.greetingDelayMs = cfg.greeting_delay_ms;
  if (cfg.show_typing === false)  out.showTyping   = false;
  if (cfg.show_citations === true) out.showCitations = true;
  if (logoUrl)                 out.logoUrl         = logoUrl;

  return Object.keys(out).length ? out : null;
}
