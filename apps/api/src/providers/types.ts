// ----------------------------------------------------------------
// Provider adapter — shared types
//
// One narrow interface every AI vendor is normalised onto. Deliberately
// NOT a union of every vendor's API: it is the smallest surface the
// platform actually needs (chat, streaming chat, embeddings), so adding
// a vendor is a translation job, not a redesign.
// ----------------------------------------------------------------

export type Role = 'user' | 'assistant';

export interface Message {
  role: Role;
  content: string;
}

/**
 * System prompt is carried separately rather than as a message, because
 * Anthropic and Google both treat it as a distinct field. OpenAI-style
 * vendors get it folded back into messages[0] by their adapter.
 */
export interface GenerateRequest {
  system?: string;
  messages: Message[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface Usage {
  inputTokens: number | null;
  outputTokens: number | null;
}

export type FinishReason = 'stop' | 'length' | 'filtered' | 'unknown';

export interface GenerateResult {
  text: string;
  usage: Usage;
  finishReason: FinishReason;
  model: string;
}

/**
 * Discriminated so new event kinds (tool calls, citations) can be added
 * later without breaking consumers that only handle 'text' and 'done'.
 */
export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'done'; usage: Usage; finishReason: FinishReason; model: string };

export interface ChatProvider {
  readonly vendor: string;
  readonly model: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  stream(req: GenerateRequest): AsyncIterable<StreamEvent>;
}

// ----------------------------------------------------------------
// Embeddings — used by RAG ingestion and query time
// ----------------------------------------------------------------
export interface EmbedRequest {
  input: string[];
  signal?: AbortSignal;
}

export interface EmbedResult {
  vectors: number[][];
  usage: Usage;
  model: string;
  dimensions: number;
}

export interface EmbeddingProvider {
  readonly vendor: string;
  readonly model: string;
  /** Known ahead of a call, so the pgvector column can be sized. */
  readonly dimensions: number | null;
  embed(req: EmbedRequest): Promise<EmbedResult>;
}

// ----------------------------------------------------------------
// Per-tenant configuration
//
// Stored as JSONB on the bot row (see docs/roadmap.md task 1). Every field is
// optional — anything omitted falls back to the vendor preset, then to
// Worker-level env defaults.
// ----------------------------------------------------------------
export interface ProviderConfig {
  vendor?: string;
  model?: string;
  /** BYOK. Overrides the Worker's own key for this vendor. */
  apiKey?: string;
  /** Overrides the preset base URL — self-hosted vLLM, a proxy, a tunnel. */
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface EmbeddingConfig extends ProviderConfig {
  dimensions?: number;
}
