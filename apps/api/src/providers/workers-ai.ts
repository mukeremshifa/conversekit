// ----------------------------------------------------------------
// Cloudflare Workers AI adapter
//
// Reached through the `AI` binding rather than HTTP: no egress, no
// API key, no per-tenant secret to store. That makes it the natural
// default for free-tier tenants and for local `wrangler dev`.
// ----------------------------------------------------------------
import type {
  ChatProvider, EmbeddingProvider, GenerateRequest, GenerateResult,
  StreamEvent, EmbedRequest, EmbedResult, Usage,
} from './types';
import type { VendorPreset } from './catalog';
import { errorFromThrown, ProviderError } from './errors';
import { readSSE } from './sse';

/**
 * Structural type instead of the `Ai` type from @cloudflare/workers-types,
 * so this file compiles whether or not the binding is configured.
 */
export interface AiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

interface Options {
  preset: VendorPreset;
  model: string;
  ai: AiBinding;
  maxTokens?: number;
  temperature?: number;
  dimensions?: number | null;
}

function toMessages(req: GenerateRequest) {
  const msgs: Array<{ role: string; content: string }> = [];
  if (req.system) msgs.push({ role: 'system', content: req.system });
  for (const m of req.messages) msgs.push({ role: m.role, content: m.content });
  return msgs;
}

const NO_USAGE: Usage = { inputTokens: null, outputTokens: null };

export class WorkersAiChatProvider implements ChatProvider {
  readonly vendor: string;
  readonly model: string;
  private o: Options;

  constructor(o: Options) {
    this.o      = o;
    this.vendor = o.preset.id;
    this.model  = o.model;
  }

  private inputs(req: GenerateRequest, stream: boolean): Record<string, unknown> {
    const inputs: Record<string, unknown> = { messages: toMessages(req), stream };
    const maxTokens = req.maxTokens ?? this.o.maxTokens;
    if (maxTokens !== undefined) inputs.max_tokens = maxTokens;

    const temperature = req.temperature ?? this.o.temperature;
    if (temperature !== undefined) inputs.temperature = temperature;

    return inputs;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    let out: any;
    try {
      out = await this.o.ai.run(this.model, this.inputs(req, false));
    } catch (err) {
      throw errorFromThrown(this.vendor, err);
    }

    const text: string = out?.response ?? '';
    if (!text) {
      throw new ProviderError({
        kind: 'unknown', vendor: this.vendor,
        message: 'Empty completion returned',
      });
    }

    return {
      text,
      usage: {
        inputTokens:  out?.usage?.prompt_tokens     ?? null,
        outputTokens: out?.usage?.completion_tokens ?? null,
      },
      finishReason: 'stop',
      model:        this.model,
    };
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    let out: unknown;
    try {
      out = await this.o.ai.run(this.model, this.inputs(req, true));
    } catch (err) {
      throw errorFromThrown(this.vendor, err);
    }

    // The binding hands back a ReadableStream of SSE frames; wrapping it
    // in a Response lets the shared reader handle chunk boundaries.
    if (!(out instanceof ReadableStream)) {
      throw new ProviderError({
        kind: 'unknown', vendor: this.vendor,
        message: 'Model did not return a stream',
      });
    }

    const usage: Usage = { ...NO_USAGE };

    try {
      for await (const msg of readSSE(new Response(out))) {
        if (msg.data === '[DONE]') break;

        let frame: any;
        try { frame = JSON.parse(msg.data); }
        catch { continue; }

        if (frame.usage) {
          usage.inputTokens  = frame.usage.prompt_tokens     ?? usage.inputTokens;
          usage.outputTokens = frame.usage.completion_tokens ?? usage.outputTokens;
        }

        if (typeof frame.response === 'string' && frame.response !== '') {
          yield { type: 'text', delta: frame.response };
        }
      }
    } catch (err) {
      throw errorFromThrown(this.vendor, err);
    }

    yield { type: 'done', usage, finishReason: 'stop', model: this.model };
  }
}

// ----------------------------------------------------------------
// Embeddings
// ----------------------------------------------------------------
export class WorkersAiEmbeddingProvider implements EmbeddingProvider {
  readonly vendor: string;
  readonly model: string;
  readonly dimensions: number | null;
  private o: Options;

  constructor(o: Options) {
    this.o          = o;
    this.vendor     = o.preset.id;
    this.model      = o.model;
    this.dimensions = o.dimensions ?? o.preset.embedDimensions ?? null;
  }

  async embed(req: EmbedRequest): Promise<EmbedResult> {
    if (req.input.length === 0) {
      return { vectors: [], usage: { ...NO_USAGE }, model: this.model, dimensions: this.dimensions ?? 0 };
    }

    let out: any;
    try {
      out = await this.o.ai.run(this.model, { text: req.input });
    } catch (err) {
      throw errorFromThrown(this.vendor, err);
    }

    const vectors: number[][] = out?.data ?? [];
    if (vectors.length !== req.input.length) {
      throw new ProviderError({
        kind: 'unknown', vendor: this.vendor,
        message: `Expected ${req.input.length} embeddings, got ${vectors.length}`,
      });
    }

    return {
      vectors,
      usage:      { ...NO_USAGE },
      model:      this.model,
      dimensions: vectors[0]?.length ?? this.dimensions ?? 0,
    };
  }
}
