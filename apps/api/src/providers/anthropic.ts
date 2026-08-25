// ----------------------------------------------------------------
// Anthropic Messages API adapter
//
// Differs from the OpenAI shape in three ways that matter here:
// system is a top-level field, max_tokens is mandatory, and the SSE
// stream is a typed event sequence rather than uniform delta frames.
// ----------------------------------------------------------------
import type {
  ChatProvider, GenerateRequest, GenerateResult, StreamEvent, FinishReason, Usage,
} from './types';
import type { VendorPreset } from './catalog';
import { errorFromResponse, errorFromThrown, ProviderError } from './errors';
import { readSSE } from './sse';

const API_VERSION = '2023-06-01';
/** Anthropic rejects a request without max_tokens; chat replies stay short. */
const DEFAULT_MAX_TOKENS = 1024;

interface Options {
  preset: VendorPreset;
  model: string;
  apiKey: string | null;
  baseUrl: string;
  maxTokens?: number;
  temperature?: number;
}

function mapStop(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence': return 'stop';
    case 'max_tokens':    return 'length';
    case 'refusal':       return 'filtered';
    default:              return reason ? 'unknown' : 'stop';
  }
}

export class AnthropicChatProvider implements ChatProvider {
  readonly vendor: string;
  readonly model: string;
  private o: Options;

  constructor(o: Options) {
    this.o      = o;
    this.vendor = o.preset.id;
    this.model  = o.model;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type':      'application/json',
      'anthropic-version': API_VERSION,
    };
    if (this.o.apiKey) h['x-api-key'] = this.o.apiKey;
    return h;
  }

  private body(req: GenerateRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model:      this.model,
      max_tokens: req.maxTokens ?? this.o.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages:   req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
    };
    if (req.system) body.system = req.system;

    const temperature = req.temperature ?? this.o.temperature;
    if (temperature !== undefined) body.temperature = temperature;

    return body;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    let res: Response;
    try {
      res = await fetch(`${this.o.baseUrl}/messages`, {
        method:  'POST',
        headers: this.headers(),
        body:    JSON.stringify(this.body(req, false)),
        signal:  req.signal,
      });
    } catch (err) {
      throw errorFromThrown(this.vendor, err);
    }
    if (!res.ok) throw await errorFromResponse(this.vendor, res);

    const json: any = await res.json();
    const text = (json?.content ?? [])
      .filter((b: any) => b?.type === 'text')
      .map((b: any) => b.text)
      .join('');

    if (!text) {
      throw new ProviderError({
        kind: 'unknown', vendor: this.vendor,
        message: 'Empty completion returned',
      });
    }

    return {
      text,
      usage: {
        inputTokens:  json?.usage?.input_tokens  ?? null,
        outputTokens: json?.usage?.output_tokens ?? null,
      },
      finishReason: mapStop(json?.stop_reason),
      model:        json?.model ?? this.model,
    };
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    let res: Response;
    try {
      res = await fetch(`${this.o.baseUrl}/messages`, {
        method:  'POST',
        headers: { ...this.headers(), Accept: 'text/event-stream' },
        body:    JSON.stringify(this.body(req, true)),
        signal:  req.signal,
      });
    } catch (err) {
      throw errorFromThrown(this.vendor, err);
    }
    if (!res.ok) throw await errorFromResponse(this.vendor, res);

    const usage: Usage    = { inputTokens: null, outputTokens: null };
    let finish: FinishReason = 'stop';
    let model             = this.model;

    try {
      for await (const msg of readSSE(res)) {
        let frame: any;
        try { frame = JSON.parse(msg.data); }
        catch { continue; }

        switch (frame.type) {
          case 'message_start':
            model = frame.message?.model ?? model;
            usage.inputTokens = frame.message?.usage?.input_tokens ?? usage.inputTokens;
            break;

          case 'content_block_delta': {
            const delta = frame.delta;
            if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
              yield { type: 'text', delta: delta.text };
            }
            break;
          }

          case 'message_delta':
            if (frame.delta?.stop_reason) finish = mapStop(frame.delta.stop_reason);
            usage.outputTokens = frame.usage?.output_tokens ?? usage.outputTokens;
            break;

          case 'error':
            throw new ProviderError({
              kind: 'server', vendor: this.vendor,
              message: frame.error?.message ?? 'Stream error',
            });
        }
      }
    } catch (err) {
      throw errorFromThrown(this.vendor, err);
    }

    yield { type: 'done', usage, finishReason: finish, model };
  }
}
