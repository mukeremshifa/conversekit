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
