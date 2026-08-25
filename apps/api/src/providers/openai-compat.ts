// ----------------------------------------------------------------
// OpenAI-compatible adapter
//
// Covers OpenAI, Groq, OpenRouter, DeepSeek, Mistral, Together,
// Ollama, LM Studio, vLLM, llama.cpp and anything else exposing
// /chat/completions + /embeddings. Vendor differences live in the
// catalog preset, not here.
// ----------------------------------------------------------------
import type {
  ChatProvider, EmbeddingProvider, GenerateRequest, GenerateResult,
  StreamEvent, EmbedRequest, EmbedResult, FinishReason, Usage,
} from './types';
import type { VendorPreset } from './catalog';
import { errorFromResponse, errorFromThrown, ProviderError } from './errors';
import { readSSE } from './sse';

interface Options {
  preset: VendorPreset;
  model: string;
  apiKey: string | null;
  baseUrl: string;
  maxTokens?: number;
  temperature?: number;
  dimensions?: number | null;
}

function headersFor(o: Options): Record<string, string> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(o.preset.extraHeaders ?? {}),
  };
  if (o.apiKey) h['Authorization'] = `Bearer ${o.apiKey}`;
  return h;
}

/** OpenAI carries the system prompt as the first message. */
function toMessages(req: GenerateRequest) {
  const msgs: Array<{ role: string; content: string }> = [];
  if (req.system) msgs.push({ role: 'system', content: req.system });
  for (const m of req.messages) msgs.push({ role: m.role, content: m.content });
  return msgs;
}

function mapFinish(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
    case 'end_turn':       return 'stop';
    case 'length':
    case 'max_tokens':     return 'length';
    case 'content_filter': return 'filtered';
    default:               return reason ? 'unknown' : 'stop';
  }
}

function mapUsage(u: any): Usage {
  return {
    inputTokens:  typeof u?.prompt_tokens     === 'number' ? u.prompt_tokens     : null,
    outputTokens: typeof u?.completion_tokens === 'number' ? u.completion_tokens : null,
  };
}

// ----------------------------------------------------------------
// Chat
// ----------------------------------------------------------------
export class OpenAICompatChatProvider implements ChatProvider {
  readonly vendor: string;
  readonly model: string;
  private o: Options;

  constructor(o: Options) {
    this.o      = o;
    this.vendor = o.preset.id;
    this.model  = o.model;
  }

  private body(req: GenerateRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model:    this.model,
      messages: toMessages(req),
      stream,
    };
    const maxTokens = req.maxTokens ?? this.o.maxTokens;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;

    const temperature = req.temperature ?? this.o.temperature;
    if (temperature !== undefined) body.temperature = temperature;

    if (stream && this.o.preset.supportsStreamUsage) {
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    let res: Response;
    try {
      res = await fetch(`${this.o.baseUrl}/chat/completions`, {
        method:  'POST',
        headers: headersFor(this.o),
        body:    JSON.stringify(this.body(req, false)),
        signal:  req.signal,
      });
    } catch (err) {
      throw errorFromThrown(this.vendor, err);
    }
    if (!res.ok) throw await errorFromResponse(this.vendor, res);

    const json: any = await res.json();
    const choice    = json?.choices?.[0];
    const text      = choice?.message?.content ?? '';

    if (!text) {
      throw new ProviderError({
        kind: 'unknown', vendor: this.vendor,
        message: 'Empty completion returned',
      });
    }

    return {
      text,
      usage:        mapUsage(json?.usage),
      finishReason: mapFinish(choice?.finish_reason),
      model:        json?.model ?? this.model,
    };
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    let res: Response;
    try {
      res = await fetch(`${this.o.baseUrl}/chat/completions`, {
        method:  'POST',
        headers: { ...headersFor(this.o), Accept: 'text/event-stream' },
        body:    JSON.stringify(this.body(req, true)),
        signal:  req.signal,
      });
    } catch (err) {
      throw errorFromThrown(this.vendor, err);
    }
    if (!res.ok) throw await errorFromResponse(this.vendor, res);

    let usage: Usage      = { inputTokens: null, outputTokens: null };
    let finish: FinishReason = 'stop';
    let model             = this.model;

    try {
      for await (const msg of readSSE(res)) {
        if (msg.data === '[DONE]') break;

        let frame: any;
        try { frame = JSON.parse(msg.data); }
        catch { continue; } // tolerate keep-alives and partial junk

        if (frame.model) model = frame.model;
        // Final usage frame arrives with an empty choices array.
        if (frame.usage) usage = mapUsage(frame.usage);

        const choice = frame.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) finish = mapFinish(choice.finish_reason);

        const delta = choice.delta?.content;
        if (typeof delta === 'string' && delta !== '') {
          yield { type: 'text', delta };
        }
      }
    } catch (err) {
      throw errorFromThrown(this.vendor, err);
    }

    yield { type: 'done', usage, finishReason: finish, model };
  }
}

// ----------------------------------------------------------------
// Embeddings
// ----------------------------------------------------------------
export class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
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
      return { vectors: [], usage: { inputTokens: 0, outputTokens: 0 }, model: this.model, dimensions: this.dimensions ?? 0 };
    }

    const body: Record<string, unknown> = { model: this.model, input: req.input };
    // Only OpenAI's v3 models support truncating to a requested size.
    if (this.o.dimensions && this.vendor === 'openai') body.dimensions = this.o.dimensions;

    let res: Response;
    try {
      res = await fetch(`${this.o.baseUrl}/embeddings`, {
        method:  'POST',
        headers: headersFor(this.o),
        body:    JSON.stringify(body),
        signal:  req.signal,
      });
    } catch (err) {
      throw errorFromThrown(this.vendor, err);
    }
    if (!res.ok) throw await errorFromResponse(this.vendor, res);

    const json: any = await res.json();
    const rows: any[] = json?.data ?? [];

    // Providers are not required to preserve input order; `index` is.
    const vectors: number[][] = new Array(req.input.length);
    for (const row of rows) {
      const idx = typeof row.index === 'number' ? row.index : rows.indexOf(row);
      vectors[idx] = row.embedding;
    }

    if (vectors.some((v) => !Array.isArray(v))) {
      throw new ProviderError({
        kind: 'unknown', vendor: this.vendor,
        message: `Expected ${req.input.length} embeddings, got ${rows.length}`,
      });
    }

    return {
      vectors,
      usage:      mapUsage(json?.usage),
      model:      json?.model ?? this.model,
      dimensions: vectors[0]?.length ?? this.dimensions ?? 0,
    };
  }
}
