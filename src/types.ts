import type { ProviderConfig, EmbeddingConfig } from './providers/types';

// ----------------------------------------------------------------
// Cloudflare Worker environment bindings (secrets from .dev.vars)
//
// Vendor keys are all optional: a deployment only needs a key for the
// vendors it actually resolves to. Unset ones fail with a clear
// ProviderError at resolve time rather than at call time.
// ----------------------------------------------------------------
export interface Env {
  SUPABASE_URL: string;
  /** Browser-safe. Used as the `apikey` alongside a user's JWT. */
  SUPABASE_ANON_KEY: string;
  /** Bypasses RLS. Public chat path only — never leaves the Worker. */
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Only for projects still signing JWTs with a shared HS256 secret. */
  SUPABASE_JWT_SECRET?: string;
  /** Override the expected `iss` claim. Needed for custom auth domains
   *  and for older projects that mint a bare `supabase` issuer. */
  SUPABASE_JWT_ISSUER?: string;
  /** Signs visitor session ids. Optional — falls back to a key derived
   *  from the service-role key so no extra config is required. */
  SESSION_SECRET?: string;

  /** Cloudflare rate-limiting binding. Optional: absent means no
   *  limiting, which is the pre-existing behaviour. */
  CHAT_LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };

  // Worker-level defaults, overridden per bot by bots.provider_config
  AI_VENDOR?: string;
  AI_MODEL?: string;
  AI_BASE_URL?: string;
  AI_MAX_TOKENS?: string;
  AI_TEMPERATURE?: string;

  EMBEDDING_VENDOR?: string;
  EMBEDDING_MODEL?: string;
  EMBEDDING_BASE_URL?: string;
  EMBEDDING_DIMENSIONS?: string;

  // Vendor API keys — names must match VendorPreset.keyEnv in catalog.ts
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  GROQ_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  TOGETHER_API_KEY?: string;
  CUSTOM_API_KEY?: string;

  // Workers AI binding — present only when configured in wrangler.toml
  AI?: AiBinding;

  /** R2 bucket holding uploaded source files. Optional: a deployment
   *  without it simply cannot accept uploads, and the route says so
   *  rather than throwing. */
  DOCS?: R2Bucket;

  /** Resend API key, for lead notification emails. Optional and
   *  deployment-wide, not per tenant: it is the platform sending on its
   *  own domain, so a tenant configuring recipients never touches it.
   *  Absent means the email half of notifications is simply off. */
  RESEND_API_KEY?: string;
  /** The From address those emails are sent from, e.g.
   *  `"ConverseKit <leads@yourdomain.com>"`. Must be on a domain
   *  verified with Resend — an unverified one is rejected at send time,
   *  which is why both of these are checked together before sending. */
  LEAD_EMAIL_FROM?: string;
}

/**
 * Structural, not the `Ai` type from @cloudflare/workers-types, for the
 * same reason src/providers/workers-ai.ts declares its own: this must
 * compile whether or not the binding is configured.
 */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
  /** Workers AI's document → markdown converter. Handles PDF, DOCX and
   *  20-odd other formats without a parser in the bundle. */
  toMarkdown(file: MarkdownInput): Promise<MarkdownConversion>;
}

export interface MarkdownInput {
  name: string;
  blob: Blob;
}

/**
 * A conversion either produced markdown or explained why it could not.
 * The failure arm is a normal return value, not a thrown error — only
 * transport and size failures throw.
 */
export type MarkdownConversion =
  | { format: 'markdown'; name: string; mimeType: string; tokens: number; data: string }
  | { format: 'error'; name: string; mimeType: string; error: string };

// ----------------------------------------------------------------
// Supabase row shapes
// ----------------------------------------------------------------
export interface Organization {
  id: string;
  name: string;
  slug: string;
  plan: string;
}

export type Role = 'owner' | 'admin' | 'viewer';

export interface Membership {
  org_id: string;
  role: Role;
  /** PostgREST embeds the joined row under the table name. */
  organizations: Organization | null;
}

export interface Bot {
  id: string;
  org_id: string;
  name: string;
  business_name: string;
  // ── Legacy business facts (001/002, 002 Phase 1) ──────────────
  //
  // Read-through deprecated since 015, not dropped — the treatment
  // `allowed_origin` got in 006. `profile` supersedes all six, but a
  // bot with `profile IS NULL` still renders from exactly these, byte
  // for byte as it did before 015, and that is what makes the cutover
  // safe to do one tenant at a time. See src/profile.ts.
  /** @deprecated superseded by `profile.hours`. */
  hours: string | null;
  /** @deprecated superseded by `profile.location`. */
  location: string | null;
  /** @deprecated superseded by `profile.contact`. */
  contact: string | null;
  services: string | null;
  custom_instructions: string | null;
  primary_color: string;
  /** @deprecated superseded by allowed_origins[]; kept as a fallback. */
  allowed_origin: string | null;
  allowed_origins?: string[] | null;
  /** Widget starter chips. Null = the widget's neutral defaults. */
  suggestions?: string[] | null;
  created_at: string;
  // Phase 1 knowledge base fields
  //
  // business_description STAYS. It is prose about the business rather
  // than a fact about it, it is already capped by PROMPT_TEXT_CAPS, and
  // moving it into `profile` would buy nothing.
  business_description: string | null;
  faq: string | null;
  /** @deprecated superseded by `profile.contact.email`. */
  contact_email: string | null;
  /** @deprecated superseded by `profile.contact.phone`. */
  contact_phone: string | null;
  /** @deprecated superseded by `profile.location`. */
  address: string | null;

  /**
   * Structured business facts (supabase/015).
   *
   * NULL — including on a Worker running ahead of the migration — means
   * the six legacy columns above are rendered into the system prompt
   * exactly as they were before 015. Nothing stamps this: the backfill
   * route writes it, and a tenant editing the Business Profile screen
   * writes it. See src/profile.ts for the renderer and the contract.
   */
  profile?: BusinessProfile | null;

  // Per-tenant AI vendor selection (JSONB). Optional until the
  // migration in docs/roadmap.md task 1 lands — undefined falls back to
  // the Worker's env defaults.
  provider_config?: ProviderConfig | null;
  embedding_config?: EmbeddingConfig | null;
  rag_config?: RagConfig | null;

  // Bot Configuration (supabase/009). Both optional: a row predating
  // the migration reads as undefined, which every consumer treats as
  // "the defaults that shipped before it".
  widget_config?: WidgetConfig | null;
  behavior_config?: BehaviorConfig | null;

  // Lead Capture (supabase/010). Same contract: undefined reproduces
  // the hardcoded prompt block byte for byte.
  lead_config?: LeadConfig | null;

  /**
   * Knowledge unification cutover (supabase/011).
   *
   * NULL — including on a Worker running ahead of the migration — means
   * `services` and `faq` are still inlined into the system prompt
   * exactly as they were before 011. Stamped only after a successful
   * ingest of both into the corpus, at which point the prompt drops
   * those two sections and retrieval takes over.
   *
   * Nulling it reverts, with the now-redundant chunks sitting
   * harmlessly in the corpus. That reversibility is the whole point.
   */
  knowledge_migrated_at?: string | null;

  /**
   * Embedding model this bot's corpus was last successfully built with
   * (supabase/012).
   *
   * NULL means UNKNOWN, which retrieval treats as "allow" — a corpus
   * indexed before 012, or a Worker running ahead of it, has nothing to
   * compare against, and reading unknown as mismatched would switch
   * retrieval off for every existing bot. See B2 in
   * docs/rag-hardening.md.
   */
  embedding_model_indexed?: string | null;

  /**
   * Indexed chunks for this bot (supabase/013).
   *
   * Maintained by a statement-level trigger on `chunks`, never by the
   * application. The chat path reads it instead of asking PostgREST
   * "does this bot have a corpus" before every single turn.
   *
   * UNDEFINED MEANS UNKNOWN, not zero — a Worker running ahead of the
   * migration gets no column back, and reading that as "no corpus"
   * would switch retrieval off for every bot on the platform. The
   * caller falls back to the query in that case. See S2 in
   * docs/rag-hardening.md.
   */
  chunk_count?: number;
}

// ----------------------------------------------------------------
// Business profile (bots.profile, supabase/015)
//
// Tier 0 of the four-tier knowledge model: bounded, always relevant,
// NEVER retrieved and always in the prompt. The question that decides
// what belongs here is "is it bounded and always relevant, or unbounded
// and sometimes relevant" — opening hours are the former, a
// twelve-page treatment guide the latter, and the latter is what the
// corpus is for.
//
// Every field is optional and every one of them may be absent: a
// profile is built up over time by a tenant filling in a form, not
// posted complete. Validated by validateProfile in src/config.ts,
// because Postgres cannot check a jsonb shape.
// ----------------------------------------------------------------

/** A label and a URL, used for socials and for custom links. Both
 *  halves are required — a URL with no label renders as a bare string
 *  the model has to guess the purpose of. */
export interface ProfileLink {
  label: string;
  url: string;
}

/** One continuous span of a day the business is open. `"HH:MM"`,
 *  24-hour, validated as strings and never parsed into Date objects —
 *  the Worker needs them as instants only in the computed-hours line,
 *  which does its own conversion. */
export interface HoursInterval {
  open: string;
  close: string;
}

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/**
 * A date that does not follow the weekly pattern.
 *
 * `closed: true` is a holiday; an `open`/`close` pair is a short day.
 * Both may be present — `closed` wins, so a tenant who ticks "closed"
 * without clearing the times gets what they asked for.
 */
export interface HoursException {
  /** `"YYYY-MM-DD"`. */
  date: string;
  closed?: boolean;
  open?: string;
  close?: string;
  label?: string;
}

export interface ProfileHours {
  /**
   * IANA zone, e.g. `Europe/London`.
   *
   * Deliberately independent of the timezone picker on the Bot
   * Configuration screen, which is inert by design and stores nothing.
   * This is the field the computed open/closed line reads, and without
   * it that line cannot be produced at all — an LLM does not know what
   * time it is anywhere.
   */
  timezone?: string;
  /** Missing days read as closed. An empty array reads as closed too. */
  regular?: Partial<Record<DayKey, HoursInterval[]>>;
  exceptions?: HoursException[];
  /**
   * The free-text escape hatch, and the backfill target for the legacy
   * `bots.hours` column. The renderer prefers `regular` when it is
   * present and falls back to this, so a tenant is never forced to
   * structure their hours before the profile is usable.
   */
  notes?: string;
}

export interface ProfileLocation {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postal?: string;
  country?: string;
  map_url?: string;
  service_area?: string;
  parking?: string;
  /** Lossless landing place for anything the fields above cannot hold.
   *  Every text column being replaced needs one. */
  notes?: string;
}

export interface ProfileContact {
  phone?: string;
  whatsapp?: string;
  email?: string;
  support_email?: string;
  /** The backfill target for the legacy `bots.contact` column, which
   *  was one freehand line and is not reliably either a phone or an
   *  email. Only written when neither of those two is set. */
  notes?: string;
  socials?: ProfileLink[];
}

export interface ProfileLinks {
  /**
   * The one URL that also lives on `lead_config`. THE PROFILE OWNS IT:
   * leadCaptureLines reads `lead_config.booking_url ?? this`, so an
   * existing configuration keeps working and the lead form's field
   * becomes an override.
   */
  booking_url?: string;
  pricing_url?: string;
  portal_url?: string;
  custom?: ProfileLink[];
}

export interface ProfilePolicies {
  payment_methods?: string[];
  cancellation?: string;
  deposit?: string;
  accessibility?: string;
  languages?: string[];
}

export interface ProfileIdentity {
  legal_name?: string;
  tagline?: string;
  industry?: string;
}

export interface BusinessProfile {
  identity?: ProfileIdentity;
  location?: ProfileLocation;
  contact?: ProfileContact;
  hours?: ProfileHours;
  links?: ProfileLinks;
  policies?: ProfilePolicies;
}

export type WidgetPosition = 'bottom-right' | 'bottom-left';
export type WidgetTheme = 'light' | 'dark' | 'auto';

/**
 * How the widget looks and greets (bots.widget_config). All optional —
 * an absent field is the widget's own default, never an error.
 */
export interface WidgetConfig {
  position?: WidgetPosition;
  theme?: WidgetTheme;
  /** R2 object key. Written by the logo upload route, never by the form. */
  logo_key?: string | null;
  greeting?: string;
  greeting_delay_ms?: number;
  show_typing?: boolean;
  show_citations?: boolean;
}

/**
 * When the bot should stop trying and offer a human (bots.behavior_config).
 * Both counters use 0 for "off", which is what an absent column decays to.
 */
export interface BehaviorConfig {
  max_messages?: number;
  fallback_message?: string;
  escalate_after_misses?: number;
}

// ----------------------------------------------------------------
// Lead capture (bots.lead_config, supabase/010)
// ----------------------------------------------------------------

/**
 * When the bot should start asking for contact details.
 *
 * `intent` is the pre-010 behaviour and the default. `after_messages`
 * is the only one of the three that is a fact rather than an
 * instruction: it is decided by counting the session's rows, the same
 * way behavior_config.max_messages is, and delivered through the
 * `situational` channel added in 009.
 */
export type LeadTrigger = 'intent' | 'always' | 'after_messages';

/** Off = absent from the marker schema entirely, so the model is never
 *  told the field exists. */
export type LeadFieldMode = 'off' | 'optional' | 'required';

/**
 * The three configurable fields. `name` and `email` are absent on
 * purpose: src/leads.ts refuses to save without them, and that guard is
 * what keeps half-filled rows out of the table.
 */
export interface LeadFields {
  phone?: LeadFieldMode;
  company?: LeadFieldMode;
  inquiry?: LeadFieldMode;
}

export type WebhookFormat = 'json' | 'slack' | 'teams';

/**
 * Lead capture settings (bots.lead_config). Every field optional, and
 * an absent column reproduces the prompt block that shipped before 010.
 */
export interface LeadConfig {
  /** false removes the whole Lead Capture section from the prompt. */
  enabled?: boolean;
  trigger?: LeadTrigger;
  /** Only read when trigger is `after_messages`. */
  trigger_after_messages?: number;
  fields?: LeadFields;
  /** Spoken before contact details are requested, not a UI checkbox. */
  consent_text?: string;
  success_message?: string;
  booking_url?: string;
  /** Applied server-side at save time, never supplied by the model. */
  tag?: string;
  /**
   * WRITE-ONLY. A Slack or Teams incoming-webhook URL is a bearer
   * credential, so this is stripped by redactBotSecrets on every admin
   * read and carried forward by mergeConfigs on every save — the same
   * handling provider_config.apiKey gets, for the same reason.
   *
   * Three states, because "stop notifying me" has to be expressible by
   * a form that is never shown the current value:
   *   absent  — leave whatever is stored alone (every ordinary save)
   *   string  — replace it
   *   null    — clear it
   */
  webhook_url?: string | null;
  webhook_format?: WebhookFormat;
  /**
   * Who to email when a lead is captured. Not a secret — an address is
   * not a credential the way a webhook URL is — so this round-trips to
   * the dashboard normally.
   *
   * Sending requires RESEND_API_KEY and LEAD_EMAIL_FROM on the
   * deployment. Recipients configured without them are stored and
   * simply never sent to, which is the same shape as every other
   * optional binding in this codebase.
   */
  email_recipients?: string[];
}

/**
 * What the dashboard is told about the webhook instead of the URL.
 * Presence and host are enough to render "Posting to hooks.slack.com"
 * without the secret ever reaching a browser.
 */
export interface LeadConfigPublic extends Omit<LeadConfig, 'webhook_url'> {
  has_webhook?: boolean;
  webhook_host?: string | null;
}

/** Per-tenant retrieval settings (bots.rag_config). All optional. */
export interface RagConfig {
  enabled?: boolean;
  top_k?: number;
  min_similarity?: number;
  chunk_size?: number;
  chunk_overlap?: number;

  // ── Added by 011 ──
  /**
   * Ceiling on the rendered `## Retrieved Reference Material` section,
   * in characters. Chunks are taken in rank order until it is spent.
   * Without it, top_k × chunk_size is the only bound and 20 × 4000 is
   * 80 KB of prompt on a single turn.
   */
  context_chars?: number;
  /**
   * Added to similarity when ORDERING boosted chunks (FAQ items ingest
   * at priority 1). The min_similarity floor still tests raw
   * similarity, so this wins near-ties without letting an irrelevant
   * chunk through. 0 disables it.
   */
  priority_boost?: number;
  /**
   * Whether to fall back to lexical search when the vector search
   * returns nothing at all. Costs one query on the miss path and
   * nothing on the happy path.
   *
   * Read only in `retrieval_mode: 'fallback'`. Deliberately NOT
   * overloaded into a tri-state alongside the mode below — one setting
   * that means "off", "fallback" and "hybrid" depending on another
   * setting is the kind of knob nobody can reason about.
   */
  lexical_fallback?: boolean;

  // ── Added by 013 ──
  /**
   * How the two search channels are combined (M4).
   *
   *   'vector'   — vector search only. Nothing rescues a miss.
   *   'fallback' — vector, then lexical over curated chunks ONLY when
   *                vector found nothing. The default, and what every
   *                bot has been doing since 011.
   *   'hybrid'   — both channels on every turn, over the whole corpus,
   *                fused by reciprocal rank.
   *
   * DEFAULTS TO 'fallback' SO NOBODY'S BOT CHANGES UNDER THEM. Hybrid
   * is the one setting on this object that can quietly disable
   * `fallback_message` and `escalate_after_misses`: lexical running
   * against every chunk on every turn almost always returns something,
   * so "the bot could not answer" stops being reachable. See the header
   * of supabase/013_hybrid.sql, and watch the miss report after
   * switching a bot to it.
   */
  retrieval_mode?: 'vector' | 'fallback' | 'hybrid';
  /**
   * Re-rank the retrieved candidates with a cross-encoder before the
   * context budget is applied (M5).
   *
   * Off by default: it is one extra model call and its latency on the
   * visitor's hot path, which is a tenant's decision rather than the
   * platform's. Needs a Workers AI binding, which is a property of the
   * DEPLOYMENT and not of the tenant — absent binding, or a re-rank
   * call that throws, falls back to cosine order rather than failing
   * the turn.
   *
   * It can only REORDER what the similarity floor already let through.
   * It never rescues a rejected chunk, and dropping the floor when
   * re-rank is on would be B1 for the third time.
   */
  rerank?: boolean;

  // ── Added by 015 ──
  /**
   * The per-turn retrieval router (src/rag/route.ts).
   *
   * 'off' — every turn long enough to embed goes through retrieval,
   *         which is what every bot has done since RAG shipped.
   * 'on'  — turns where retrieval is POINTLESS (closings,
   *         acknowledgements, a bare contact detail) skip the embedding
   *         call and the vector search entirely.
   *
   * DEFAULTS TO 'off' SO NOBODY'S BOT CHANGES UNDER THEM ON DEPLOY,
   * the same reasoning `retrieval_mode` defaults to 'fallback' for. A
   * false skip is a wrong answer while a false retrieve is only
   * latency, so watch the miss report after switching a bot on: if the
   * miss rate moves at all, a skip rule is too aggressive.
   */
  router?: 'off' | 'on';
  /**
   * Trigram similarity above which a curated FAQ question answers the
   * turn directly, with no embedding call at all (016).
   *
   * `similarity()` is normalised 0-1, which is exactly why this is
   * trigram rather than the existing `match_chunks_lexical` — ts_rank
   * is not normalised and cannot be thresholded meaningfully.
   *
   * 0 switches the shortcut off. One knob, not a knob and a boolean.
   */
  faq_shortcut_threshold?: number;
}

export type DocumentSource = 'text' | 'url' | 'markdown' | 'file' | 'faq';
export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

/**
 * What shape a chunk's text has. Retrieval weights, filters and
 * explains by this; ingestion sets it and a tenant never can.
 */
export type ChunkKind = 'prose' | 'faq';

export interface Document {
  id: string;
  bot_id: string;
  org_id: string;
  source: DocumentSource;
  title: string;
  url: string | null;
  content: string | null;
  status: DocumentStatus;
  error: string | null;
  chunk_count: number;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  created_at: string;
  updated_at: string;

  // File sources only. The bytes live in R2; these say where and what.
  // Kept after extraction so a document can be re-chunked, or
  // re-extracted with a better converter, without a second upload.
  r2_key?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;

  /**
   * The ingest claim (supabase/012). Non-null while a run owns this
   * document; released on success and on failure alike. Deliberately
   * absent from the list queries the dashboard reads — it is a lock,
   * not a status, and `status` is the thing a tenant looks at.
   */
  ingest_started_at?: string | null;
}

export interface DocumentCreatePayload {
  bot_id: string;
  source: DocumentSource;
  title: string;
  url?: string | null;
  content?: string | null;
  r2_key?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
}

export interface ChunkRow {
  id: string;
  document_id: string;
  ordinal: number;
  content: string;
  created_at: string;
  // Added by 011. Optional so a Worker reading a pre-011 row — or a
  // deploy that lands before the migration — still parses.
  kind?: ChunkKind;
  priority?: number;
  metadata?: Record<string, unknown> | null;
}

/**
 * One question and its answer (supabase/011).
 *
 * Rows rather than a parsed text blob: per-item edit, reorder and
 * disable are what a tenant actually does with an FAQ, and every one of
 * those is string surgery on a blob. They hang off a synthetic
 * `documents` row with source='faq' so they inherit status, reindex,
 * the chunk inspector, citations and ON DELETE CASCADE unchanged —
 * the pipeline stays one pipeline.
 */
export interface FaqItem {
  id: string;
  bot_id: string;
  org_id: string;
  document_id: string;
  question: string;
  answer: string;
  position: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface FaqItemPayload {
  question?: string;
  answer?: string;
  position?: number;
  enabled?: boolean;
}

export interface Lead {
  id: string;
  bot_id: string;
  session_id: string;
  name: string;
  email: string;
  phone: string | null;
  inquiry: string | null;
  created_at: string;

  // supabase/010. Optional so a Worker deployed ahead of the migration
  // still type-checks against rows that do not have them yet.
  tag?: string | null;
  company?: string | null;
  /** See the column comment in 010 — this means "the bot was told to
   *  ask", not "the visitor accepted". */
  consent_given?: boolean | null;
}

export interface ConversationRow {
  id: string;
  bot_id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

// ----------------------------------------------------------------
// Request / response shapes
// ----------------------------------------------------------------
export interface ChatRequest {
  botId: string;
  message: string;
  sessionId: string;
}

export interface ChatResponse {
  reply: string;
  sessionId: string;
}

export interface BotCreatePayload {
  org_id: string;
  name: string;
  business_name: string;
  allowed_origins: string[];
  primary_color?: string;
}

export interface BotUpdatePayload {
  provider_config?: ProviderConfig | null;
  embedding_config?: EmbeddingConfig | null;
  rag_config?: RagConfig | null;
  name?: string;
  business_name?: string;
  business_description?: string;
  services?: string;
  faq?: string;
  hours?: string;
  address?: string;
  contact_email?: string;
  contact_phone?: string;
  primary_color?: string;
  allowed_origins?: string[];
  suggestions?: string[] | null;
  custom_instructions?: string;
  // Replaced wholesale, not merged — unlike provider_config, neither
  // holds a write-only secret, and the form always posts the whole
  // object. See the note on mergeConfigs in src/supabase.ts.
  widget_config?: WidgetConfig | null;
  behavior_config?: BehaviorConfig | null;
  // Also replaced wholesale, with one carried-forward key: webhook_url
  // IS a secret and the form never sends it back. Structurally the same
  // exception widget_config.logo_key already gets.
  lead_config?: LeadConfig | null;
  // Replaced wholesale with NO carried-forward key at all — it holds no
  // secret, the form posts the whole object, and a merge would make a
  // cleared field un-clearable. The next person will look for the
  // exception the two above have; there is none. See mergeConfigs.
  profile?: BusinessProfile | null;
}
