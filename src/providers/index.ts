// ----------------------------------------------------------------
// Provider registry
//
// Resolution order for every setting, most specific first:
//   1. the tenant's own config  (bots.provider_config JSONB)
//   2. Worker env defaults      (AI_VENDOR / AI_MODEL / AI_MAX_TOKENS…)
//   3. the vendor preset        (src/providers/catalog.ts)
//
// Callers never construct an adapter directly — they ask for a
// ChatProvider or an EmbeddingProvider and get whatever the tenant
// is configured for.
// ----------------------------------------------------------------
import type { Env } from '../types';
import type { ChatProvider, EmbeddingProvider, ProviderConfig, EmbeddingConfig } from './types';
import { VENDORS, getPreset, type VendorPreset } from './catalog';
import { ProviderError } from './errors';
import { OpenAICompatChatProvider, OpenAICompatEmbeddingProvider } from './openai-compat';
import { AnthropicChatProvider } from './anthropic';
import { GoogleChatProvider, GoogleEmbeddingProvider } from './google';
import { WorkersAiChatProvider, WorkersAiEmbeddingProvider, type AiBinding } from './workers-ai';

export * from './types';
export * from './errors';
export {
  VENDORS, getPreset, embeddingCapableVendors,
  similarityFloorFor, resolveSimilarityFloor, DEFAULT_SIMILARITY_FLOOR,
} from './catalog';
export type { VendorPreset, AdapterKind, CostTier } from './catalog';

/** Used when neither the tenant nor the env expresses a preference. */
const FALLBACK_VENDOR = 'google';

// ----------------------------------------------------------------
// Key + endpoint resolution
// ----------------------------------------------------------------
function resolveKey(env: Env, preset: VendorPreset, cfg: ProviderConfig): string | null {
  // BYOK wins — a tenant supplying a key must never fall through to ours.
  if (cfg.apiKey) return cfg.apiKey;
  if (!preset.keyEnv) return null;

  const key = (env as unknown as Record<string, string | undefined>)[preset.keyEnv];
  if (key) return key;

  if (preset.keyless) return null;
  throw new ProviderError({
    kind:    'auth',
    vendor:  preset.id,
    message: `No API key: set the ${preset.keyEnv} secret or store one on the bot`,
  });
}

function resolveBaseUrl(preset: VendorPreset, cfg: ProviderConfig): string {
  const base = cfg.baseUrl ?? preset.baseUrl;
  if (!base) {
    throw new ProviderError({
      kind:    'bad_request',
      vendor:  preset.id,
      message: `Vendor '${preset.id}' requires an explicit baseUrl`,
    });
  }
  return base.replace(/\/+$/, '');
}

function requireAi(env: Env, vendor: string): AiBinding {
  const ai = (env as { AI?: AiBinding }).AI;
  if (!ai) {
    throw new ProviderError({
      kind:    'bad_request',
      vendor,
      message: 'Workers AI selected but no `AI` binding is configured (see wrangler.toml)',
    });
  }
  return ai;
}

function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Merge tenant config over env defaults. */
function mergeChatConfig(env: Env, override?: ProviderConfig | null): Required<Pick<ProviderConfig, 'vendor'>> & ProviderConfig {
  const cfg = override ?? {};
  return {
    vendor:      cfg.vendor      ?? env.AI_VENDOR ?? FALLBACK_VENDOR,
    model:       cfg.model       ?? env.AI_MODEL,
    apiKey:      cfg.apiKey,
    baseUrl:     cfg.baseUrl     ?? env.AI_BASE_URL,
    maxTokens:   cfg.maxTokens   ?? num(env.AI_MAX_TOKENS),
    temperature: cfg.temperature ?? num(env.AI_TEMPERATURE),
  };
}

// ----------------------------------------------------------------
// Chat
// ----------------------------------------------------------------
export function resolveChatProvider(env: Env, override?: ProviderConfig | null): ChatProvider {
  const cfg    = mergeChatConfig(env, override);
  const preset = getPreset(cfg.vendor);

  if (!preset) {
    throw new ProviderError({
      kind:    'bad_request',
      vendor:  cfg.vendor,
      message: `Unknown vendor '${cfg.vendor}'. Known: ${Object.keys(VENDORS).join(', ')}`,
    });
  }

  const model = cfg.model ?? preset.defaultChatModel;
  const common = { preset, model, maxTokens: cfg.maxTokens, temperature: cfg.temperature };

  switch (preset.kind) {
    case 'workers-ai':
      return new WorkersAiChatProvider({ ...common, ai: requireAi(env, preset.id) });

    case 'anthropic':
      return new AnthropicChatProvider({
        ...common,
        apiKey:  resolveKey(env, preset, cfg),
        baseUrl: resolveBaseUrl(preset, cfg),
      });

    case 'google':
      return new GoogleChatProvider({
        ...common,
        apiKey:  resolveKey(env, preset, cfg),
        baseUrl: resolveBaseUrl(preset, cfg),
      });

    case 'openai-compat':
      return new OpenAICompatChatProvider({
        ...common,
        apiKey:  resolveKey(env, preset, cfg),
        baseUrl: resolveBaseUrl(preset, cfg),
      });
  }
}

// ----------------------------------------------------------------
// Embeddings
//
// Kept separate from chat on purpose: a tenant will often want a
// strong chat model from one vendor and cheap local embeddings from
// another, and re-embedding a corpus to follow a chat-model change
// would be expensive and pointless.
// ----------------------------------------------------------------
export function resolveEmbeddingProvider(env: Env, override?: EmbeddingConfig | null): EmbeddingProvider {
  const cfg    = override ?? {};
  const vendor = cfg.vendor ?? env.EMBEDDING_VENDOR ?? FALLBACK_VENDOR;
  const preset = getPreset(vendor);

  if (!preset) {
    throw new ProviderError({
      kind:    'bad_request',
      vendor,
      message: `Unknown vendor '${vendor}'. Known: ${Object.keys(VENDORS).join(', ')}`,
    });
  }

  const model = cfg.model ?? env.EMBEDDING_MODEL ?? preset.defaultEmbedModel;
  if (!model) {
    throw new ProviderError({
      kind:    'unsupported',
      vendor,
      message: `Vendor '${vendor}' does not provide an embeddings API — pick another for RAG`,
    });
  }

  const dimensions = cfg.dimensions ?? num(env.EMBEDDING_DIMENSIONS) ?? preset.embedDimensions ?? null;
  const common     = { preset, model, dimensions };
  const merged: ProviderConfig = { ...cfg, baseUrl: cfg.baseUrl ?? env.EMBEDDING_BASE_URL };

  switch (preset.kind) {
    case 'workers-ai':
      return new WorkersAiEmbeddingProvider({ ...common, ai: requireAi(env, preset.id) });

    case 'google':
      return new GoogleEmbeddingProvider({
        ...common,
        apiKey:  resolveKey(env, preset, merged),
        baseUrl: resolveBaseUrl(preset, merged),
      });

    case 'openai-compat':
      return new OpenAICompatEmbeddingProvider({
        ...common,
        apiKey:  resolveKey(env, preset, merged),
        baseUrl: resolveBaseUrl(preset, merged),
      });

    case 'anthropic':
      throw new ProviderError({
        kind:    'unsupported',
        vendor,
        message: 'Anthropic has no embeddings API — pick another vendor for RAG',
      });
  }
}
