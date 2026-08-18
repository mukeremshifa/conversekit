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
  // contact / location kept for backwards compat with existing rows
  hours: string | null;
  location: string | null;
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
  business_description: string | null;
  faq: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  address: string | null;

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
}

export type DocumentSource = 'text' | 'url' | 'markdown' | 'file';
export type DocumentStatus = 'pending' | 'processing' | 'ready' | 'failed';

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
}
