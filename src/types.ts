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
  // migration in PLAN.md task 1 lands — undefined falls back to
  // the Worker's env defaults.
  provider_config?: ProviderConfig | null;
  embedding_config?: EmbeddingConfig | null;
  rag_config?: RagConfig | null;
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
}
