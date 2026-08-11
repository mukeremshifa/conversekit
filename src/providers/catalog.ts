// ----------------------------------------------------------------
// Vendor catalog
//
// Most vendors speak the OpenAI chat-completions shape, so they are
// config rather than code — one adapter, many entries. Only Anthropic,
// Google and Workers AI need their own translation layer.
//
// The dashboard reads this list to render the provider picker.
// ----------------------------------------------------------------

export type AdapterKind = 'openai-compat' | 'anthropic' | 'google' | 'workers-ai';

/** Rough cost signal for the dashboard — not a billing source of truth. */
export type CostTier = 'paid' | 'free-tier' | 'local';

export interface VendorPreset {
  id: string;
  label: string;
  kind: AdapterKind;
  /** Omitted for workers-ai (binding, not HTTP) and for fully custom endpoints. */
  baseUrl?: string;
  /** Worker env var consulted when the tenant has not supplied their own key. */
  keyEnv?: string;
  /** Local servers accept any key, or none at all. */
  keyless?: boolean;
  costTier: CostTier;

  defaultChatModel: string;
  defaultEmbedModel?: string;
  embedDimensions?: number;

  /**
   * `stream_options: {include_usage: true}` yields token counts on the
   * final SSE frame. Strict local servers reject the unknown field, so
   * it is opt-in per vendor.
   */
  supportsStreamUsage?: boolean;
  extraHeaders?: Record<string, string>;
}

export const VENDORS: Record<string, VendorPreset> = {
  // ── Major hosted ────────────────────────────────────────────────
  openai: {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    costTier: 'paid',
    defaultChatModel: 'gpt-4o-mini',
    defaultEmbedModel: 'text-embedding-3-small',
    embedDimensions: 1536,
    supportsStreamUsage: true,
  },

  anthropic: {
    id: 'anthropic',
    label: 'Anthropic Claude',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    keyEnv: 'ANTHROPIC_API_KEY',
    costTier: 'paid',
    defaultChatModel: 'claude-sonnet-5',
    // No embeddings API — resolveEmbeddingProvider rejects this vendor.
  },

  google: {
    id: 'google',
    label: 'Google Gemini',
    kind: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    keyEnv: 'GEMINI_API_KEY',
    costTier: 'free-tier',
    defaultChatModel: 'gemini-3.5-flash',
    // gemini-embedding-001 natively returns 3072; outputDimensionality
    // truncates it to the platform-wide 768 (see RAG_DIMENSIONS).
    defaultEmbedModel: 'gemini-embedding-001',
    embedDimensions: 768,
  },

  // ── Free tiers / fast+cheap ─────────────────────────────────────
  groq: {
    id: 'groq',
    label: 'Groq',
    kind: 'openai-compat',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    costTier: 'free-tier',
    defaultChatModel: 'llama-3.3-70b-versatile',
    supportsStreamUsage: true,
  },

  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai-compat',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    costTier: 'free-tier',
    // The ':free' suffix routes to no-cost capacity.
    defaultChatModel: 'meta-llama/llama-3.3-70b-instruct:free',
    supportsStreamUsage: true,
    extraHeaders: {
      'HTTP-Referer': 'https://conversekit.io',
      'X-Title': 'ConverseKit',
    },
  },

  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'openai-compat',
    baseUrl: 'https://api.deepseek.com/v1',
    keyEnv: 'DEEPSEEK_API_KEY',
    costTier: 'paid',
    defaultChatModel: 'deepseek-chat',
    supportsStreamUsage: true,
  },

  mistral: {
    id: 'mistral',
    label: 'Mistral',
    kind: 'openai-compat',
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnv: 'MISTRAL_API_KEY',
    costTier: 'free-tier',
    defaultChatModel: 'mistral-small-latest',
    defaultEmbedModel: 'mistral-embed',
    embedDimensions: 1024,
    supportsStreamUsage: true,
  },

  together: {
    id: 'together',
    label: 'Together AI',
    kind: 'openai-compat',
    baseUrl: 'https://api.together.xyz/v1',
    keyEnv: 'TOGETHER_API_KEY',
    costTier: 'paid',
    defaultChatModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    defaultEmbedModel: 'BAAI/bge-base-en-v1.5',
    embedDimensions: 768,
    supportsStreamUsage: true,
  },

  // ── Cloudflare-native (no egress, no separate key) ──────────────
  'workers-ai': {
    id: 'workers-ai',
    label: 'Cloudflare Workers AI',
    kind: 'workers-ai',
    keyless: true,
    costTier: 'free-tier',
    defaultChatModel: '@cf/meta/llama-3.1-8b-instruct',
    defaultEmbedModel: '@cf/baai/bge-base-en-v1.5',
    embedDimensions: 768,
  },

  // ── Local ───────────────────────────────────────────────────────
  ollama: {
    id: 'ollama',
    label: 'Ollama (local)',
    kind: 'openai-compat',
    baseUrl: 'http://localhost:11434/v1',
    keyless: true,
    costTier: 'local',
    defaultChatModel: 'llama3.2',
    defaultEmbedModel: 'nomic-embed-text',
    embedDimensions: 768,
    // Older builds 400 on unknown request fields.
    supportsStreamUsage: false,
  },

  lmstudio: {
    id: 'lmstudio',
    label: 'LM Studio (local)',
    kind: 'openai-compat',
    baseUrl: 'http://localhost:1234/v1',
    keyless: true,
    costTier: 'local',
    defaultChatModel: 'local-model',
    defaultEmbedModel: 'text-embedding-nomic-embed-text-v1.5',
    embedDimensions: 768,
    supportsStreamUsage: false,
  },

  // ── Escape hatch: any OpenAI-compatible server (vLLM, llama.cpp,
  //    LiteLLM, a self-hosted gateway). Requires an explicit baseUrl.
  custom: {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    kind: 'openai-compat',
    keyEnv: 'CUSTOM_API_KEY',
    keyless: true,
    costTier: 'local',
    defaultChatModel: 'default',
    supportsStreamUsage: false,
  },
};

export function getPreset(vendor: string): VendorPreset | null {
  return VENDORS[vendor] ?? null;
}

/** Vendors that can serve embeddings — i.e. everything except Anthropic. */
export function embeddingCapableVendors(): VendorPreset[] {
  return Object.values(VENDORS).filter((v) => !!v.defaultEmbedModel);
}
