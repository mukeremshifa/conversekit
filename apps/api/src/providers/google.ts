// ----------------------------------------------------------------
// Google Gemini adapter (raw REST)
//
// Deliberately not the @google/generative-ai SDK: the same reasoning
// as src/supabase.ts — the SDK drags Node polyfills into the Workers
// runtime, and the REST surface is small.
//
// Gemini quirks handled here: 'assistant' is called 'model', the
// history must begin with a user turn, and streaming needs ?alt=sse
// (without it the endpoint returns a JSON array, not events).
// ----------------------------------------------------------------
import type {
  ChatProvider, EmbeddingProvider, GenerateRequest, GenerateResult, StreamEvent,
  EmbedRequest, EmbedResult, FinishReason, Usage,
} from './types';
import type { VendorPreset } from './catalog';
import { errorFromResponse, errorFromThrown, ProviderError } from './errors';
import { readSSE } from './sse';
import { getAccessToken, type ServiceAccount } from './vertex-auth';

/**
 * Addressing for Vertex AI instead of the Developer API.
 *
 * The WIRE FORMAT EITHER SIDE IS IDENTICAL — same `contents`, same
 * `systemInstruction`, same `generationConfig`, same response shape —
 * which is the entire reason this is a branch inside the existing
 * adapter rather than a second one. Only the URL and the credential
 * differ, and duplicating the streaming loop to change two lines is how
 * the two copies drift.
 *
 * WHY VERTEX EXISTS HERE AT ALL: generativelanguage.googleapis.com
 * geolocates the caller's IP and refuses whole countries with 400
 * FAILED_PRECONDITION, "User location is not supported for the API
 * use". A Worker egresses from whichever colo it runs in, so that check
 * is not something this side can satisfy — see the note in
 * wrangler.jsonc. Vertex is Google's own documented answer for
 * restricted regions: it authorises by IAM, not by where the call came
 * from.
 */
export interface VertexTarget {
  projectId: string;
  /** A region such as 'us-central1', or 'global' — which is a real
   *  location name here, not a sentinel, and the one to prefer unless
   *  data residency says otherwise: it spans every region and so rides
   *  out single-region capacity 429s. */
  location: string;
  serviceAccount: ServiceAccount;
}

interface Options {
  preset: VendorPreset;
  model: string;
  apiKey: string | null;
  baseUrl: string;
  /** Present for the Vertex vendor, absent for the Developer API.
   *  When set, apiKey/baseUrl are unused. */
  vertex?: VertexTarget | null;
  maxTokens?: number;
  temperature?: number;
  dimensions?: number | null;
}

function mapFinish(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'STOP':       return 'stop';
    case 'MAX_TOKENS': return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':  return 'filtered';
    default:           return reason ? 'unknown' : 'stop';
  }
}

function mapUsage(u: any): Usage {
  return {
    inputTokens:  typeof u?.promptTokenCount     === 'number' ? u.promptTokenCount     : null,
    outputTokens: typeof u?.candidatesTokenCount === 'number' ? u.candidatesTokenCount : null,
  };
}

/**
 * Gemini rejects a history that opens on a model turn. Session history
 * should always start with the visitor, but a trimmed window can slice
 * mid-exchange — so drop any leading model turns rather than 400.
 */
function toContents(messages: GenerateRequest['messages']) {
  let start = 0;
  while (start < messages.length && messages[start].role === 'assistant') start++;
  return messages.slice(start).map((m) => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));
}

export class GoogleChatProvider implements ChatProvider {
  readonly vendor: string;
  readonly model: string;
  private o: Options;

  constructor(o: Options) {
    this.o      = o;
    this.vendor = o.preset.id;
    this.model  = o.model;
  }

  private url(method: string, sse: boolean): string {
    const q = sse ? '?alt=sse' : '';
    const v = this.o.vertex;
    if (!v) return `${this.o.baseUrl}/models/${encodeURIComponent(this.model)}:${method}${q}`;

    // 'global' is addressed on the BARE host with no region prefix,
    // while every real region repeats itself in both the hostname and
    // the path. Building the regional form for 'global' yields
    // global-aiplatform.googleapis.com, which does not resolve.
    const host = v.location === 'global'
      ? 'https://aiplatform.googleapis.com'
      : `https://${v.location}-aiplatform.googleapis.com`;

    return `${host}/v1/projects/${v.projectId}/locations/${v.location}` +
           `/publishers/google/models/${encodeURIComponent(this.model)}:${method}${q}`;
  }

  // Async because Vertex's credential is a minted OAuth token, not a
  // static key. Cached in vertex-auth.ts, so this is a map lookup on
  // all but roughly one call an hour.
  private async headers(): Promise<Record<string, string>> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.o.vertex) {
      h.Authorization = `Bearer ${await getAccessToken(this.o.vertex.serviceAccount)}`;
      return h;
    }
    // Header auth rather than ?key= so the secret stays out of logs/URLs.
    if (this.o.apiKey) h['x-goog-api-key'] = this.o.apiKey;
    return h;
  }

  private body(req: GenerateRequest): Record<string, unknown> {
    const generationConfig: Record<string, unknown> = {};
    const maxTokens = req.maxTokens ?? this.o.maxTokens;
    if (maxTokens !== undefined) generationConfig.maxOutputTokens = maxTokens;

    const temperature = req.temperature ?? this.o.temperature;
    if (temperature !== undefined) generationConfig.temperature = temperature;

    const body: Record<string, unknown> = { contents: toContents(req.messages) };
    if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
    if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;

    return body;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    let res: Response;
    try {
      res = await fetch(this.url('generateContent', false), {
        method:  'POST',
        headers: await this.headers(),
        body:    JSON.stringify(this.body(req)),
        signal:  req.signal,
      });
    } catch (err) {
      throw errorFromThrown(this.vendor, err);
    }
    if (!res.ok) throw await errorFromResponse(this.vendor, res);

    const json: any   = await res.json();
    const candidate   = json?.candidates?.[0];
    const text: string = (candidate?.content?.parts ?? [])
      .map((p: any) => p?.text ?? '')
      .join('');

    if (!text) {
      const blocked = json?.promptFeedback?.blockReason ?? candidate?.finishReason;
      throw new ProviderError({
        kind:    blocked && blocked !== 'STOP' ? 'bad_request' : 'unknown',
        vendor:  this.vendor,
        message: blocked ? `No content returned (${blocked})` : 'Empty completion returned',
      });
    }

    return {
      text,
      usage:        mapUsage(json?.usageMetadata),
      finishReason: mapFinish(candidate?.finishReason),
      model:        json?.modelVersion ?? this.model,
    };
  }

  async *stream(req: GenerateRequest): AsyncIterable<StreamEvent> {
    let res: Response;
    try {
      res = await fetch(this.url('streamGenerateContent', true), {
        method:  'POST',
        headers: { ...(await this.headers()), Accept: 'text/event-stream' },
        body:    JSON.stringify(this.body(req)),
        signal:  req.signal,
      });
    } catch (err) {
      throw errorFromThrown(this.vendor, err);
    }
    if (!res.ok) throw await errorFromResponse(this.vendor, res);

    let usage: Usage         = { inputTokens: null, outputTokens: null };
    let finish: FinishReason = 'stop';
    let model                = this.model;

    try {
      for await (const msg of readSSE(res)) {
        let frame: any;
        try { frame = JSON.parse(msg.data); }
        catch { continue; }

        if (frame.modelVersion)  model = frame.modelVersion;
        // Cumulative — the last frame carries the final counts.
        if (frame.usageMetadata) usage = mapUsage(frame.usageMetadata);

        const candidate = frame.candidates?.[0];
        if (!candidate) continue;
        if (candidate.finishReason) finish = mapFinish(candidate.finishReason);

        for (const part of candidate.content?.parts ?? []) {
          if (typeof part?.text === 'string' && part.text !== '') {
            yield { type: 'text', delta: part.text };
          }
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
export class GoogleEmbeddingProvider implements EmbeddingProvider {
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

    const modelPath = `models/${this.model}`;
    const body = {
      requests: req.input.map((text) => {
        const r: Record<string, unknown> = { model: modelPath, content: { parts: [{ text }] } };
        if (this.o.dimensions) r.outputDimensionality = this.o.dimensions;
        return r;
      }),
    };

    let res: Response;
    try {
      res = await fetch(`${this.o.baseUrl}/${modelPath}:batchEmbedContents`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.o.apiKey ? { 'x-goog-api-key': this.o.apiKey } : {}),
        },
        body:   JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      throw errorFromThrown(this.vendor, err);
    }
    if (!res.ok) throw await errorFromResponse(this.vendor, res);

    const json: any = await res.json();
    const vectors: number[][] = (json?.embeddings ?? []).map((e: any) => e?.values);

    if (vectors.length !== req.input.length || vectors.some((v) => !Array.isArray(v))) {
      throw new ProviderError({
        kind: 'unknown', vendor: this.vendor,
        message: `Expected ${req.input.length} embeddings, got ${vectors.length}`,
      });
    }

    return {
      vectors,
      // Gemini's batch embed endpoint does not report token usage.
      usage:      { inputTokens: null, outputTokens: null },
      model:      this.model,
      dimensions: vectors[0]?.length ?? this.dimensions ?? 0,
    };
  }
}
