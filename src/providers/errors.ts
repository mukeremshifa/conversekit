// ----------------------------------------------------------------
// Normalised provider errors
//
// Every vendor fails differently. Callers need two things from a
// failure: an HTTP status to return, and whether retrying (or failing
// over to another vendor) could plausibly help.
// ----------------------------------------------------------------

export type ProviderErrorKind =
  | 'auth'            // bad or missing API key
  | 'rate_limit'      // 429 / quota
  | 'context_length'  // prompt too long — retrying the same input won't help
  | 'bad_request'     // malformed call, unknown model
  | 'timeout'
  | 'network'         // could not reach the vendor at all
  | 'server'          // vendor 5xx
  | 'unsupported'     // vendor cannot do this operation (e.g. Anthropic embeddings)
  | 'unknown';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly vendor: string;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(opts: {
    kind: ProviderErrorKind;
    vendor: string;
    message: string;
    status?: number | null;
    retryable?: boolean;
  }) {
    super(`[${opts.vendor}] ${opts.message}`);
    this.name      = 'ProviderError';
    this.kind      = opts.kind;
    this.vendor    = opts.vendor;
    this.status    = opts.status ?? null;
    this.retryable = opts.retryable ?? defaultRetryable(opts.kind);
  }
}

function defaultRetryable(kind: ProviderErrorKind): boolean {
  return kind === 'rate_limit' || kind === 'timeout' || kind === 'network' || kind === 'server';
}

/** Map an HTTP status from any vendor onto a normalised kind. */
export function kindFromStatus(status: number, body: string): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 408 || status === 504) return 'timeout';
  if (status >= 500) return 'server';
  if (status === 400 || status === 404 || status === 422) {
    // Context-length overflows arrive as 400s with vendor-specific wording.
    const lower = body.toLowerCase();
    if (
      lower.includes('context length') ||
      lower.includes('context_length') ||
      lower.includes('too many tokens') ||
      lower.includes('maximum context') ||
      lower.includes('prompt is too long')
    ) return 'context_length';
    return 'bad_request';
  }
  return 'unknown';
}

/** Wrap a non-2xx vendor response. */
export async function errorFromResponse(vendor: string, res: Response): Promise<ProviderError> {
  let body = '';
  try { body = await res.text(); } catch { /* body already consumed or unreadable */ }
  return new ProviderError({
    kind:    kindFromStatus(res.status, body),
    vendor,
    status:  res.status,
    message: `HTTP ${res.status}: ${body.slice(0, 500) || res.statusText}`,
  });
}

/** Wrap a thrown fetch/abort failure. */
export function errorFromThrown(vendor: string, err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const message = err instanceof Error ? err.message : String(err);
  const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
  return new ProviderError({
    kind:    aborted ? 'timeout' : 'network',
    vendor,
    message,
  });
}

/** HTTP status the Worker should return for a given failure. */
export function httpStatusFor(err: ProviderError): 401 | 429 | 502 | 504 {
  switch (err.kind) {
    case 'auth':       return 401;
    case 'rate_limit': return 429;
    case 'timeout':    return 504;
    default:           return 502;
  }
}
