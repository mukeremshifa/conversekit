// ----------------------------------------------------------------
// Source → plain text
//
// Covers the three sources Phase 2 ingests: pasted text, markdown, and
// a fetched URL. Binary formats (PDF, DOCX) are deliberately absent —
// they need a parser that cannot run inside a request-scoped Worker,
// which is the same reason R2 and Workflows are deferred with them.
// ----------------------------------------------------------------

export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExtractError';
  }
}

/** Elements whose text content is never page content. */
const STRIP_BLOCKS = /<(script|style|noscript|svg|head|nav|footer|form|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;
/** Tags that imply a line break once markup is gone.
 *
 *  h1-h6 are DELIBERATELY ABSENT — they are handled below as headings
 *  rather than as generic breaks. Putting them back here would flatten
 *  every heading into a bare line again, which is precisely what M6
 *  had to undo. */
const BLOCK_TAGS = /<\/?(p|div|br|li|tr|section|article|header|blockquote)\b[^>]*>/gi;

/**
 * Headings, preserved as ATX markdown at their own level (M6).
 *
 * ALL THREE EXTRACTORS USED TO DESTROY HEADINGS, each differently, so
 * by the time the chunker ran a heading was a short line indistinguish-
 * able from a sentence. One canonical form is what lets chunkText find
 * them — and ATX is that form because storedFileToText already produces
 * it: Workers AI's toMarkdown output passes through untouched.
 */
const HEADING_OPEN  = /<h([1-6])\b[^>]*>/gi;
const HEADING_CLOSE = /<\/h[1-6]\s*>/gi;

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&#39;': "'", '&apos;': "'", '&mdash;': '—', '&ndash;': '–',
};

export function htmlToText(html: string): string {
  // Read the title from the ORIGINAL markup: <head> is one of the
  // stripped blocks, so searching the stripped copy would never find it.
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();

  let out = html
    .replace(STRIP_BLOCKS, ' ')
    // Before the generic tag strip, and before BLOCK_TAGS, so the level
    // survives: <h2> becomes '## ' rather than another newline.
    .replace(HEADING_OPEN, (_, level) => `\n\n${'#'.repeat(Number(level))} `)
    .replace(HEADING_CLOSE, '\n\n')
    .replace(BLOCK_TAGS, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&[a-z]+;/gi, (e) => ENTITIES[e.toLowerCase()] ?? ' ');

  return title ? `${title}\n\n${out}` : out;
}

/**
 * Strip the markup that carries no meaning once embedded, while keeping
 * heading text — headings are usually the most retrievable sentence in
 * a section.
 *
 * THE `#` MARKERS ARE KEPT (M6). They used to be stripped here, which
 * left a heading as a bare line the chunker could not tell from a
 * sentence; chunkText now reads them to build the breadcrumb it
 * prefixes onto each prose chunk, and consumes them in the process, so
 * nothing markdown-shaped reaches an embedding. The leading whitespace
 * still goes, so `   ## Plans` and `## Plans` are one thing.
 */
export function markdownToText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code
    .replace(/`([^`]*)`/g, '$1')              // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')    // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')  // links → link text
    .replace(/^\s{0,3}(#{1,6})\s+/gm, '$1 ')  // headings: keep, normalise
    .replace(/^\s{0,3}>\s?/gm, '')            // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '• ')          // bullets
    .replace(/(\*\*|__|\*|_)/g, '');          // emphasis
}

const MAX_BYTES = 2_000_000;

export async function fetchUrl(url: string, signal?: AbortSignal): Promise<{ text: string; title: string | null }> {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { throw new ExtractError(`Not a valid URL: ${url}`); }

  // Refuse anything that is not a public web fetch. Without this the
  // ingestion endpoint is an SSRF primitive pointed at the Worker's
  // own network position.
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ExtractError(`Unsupported protocol: ${parsed.protocol}`);
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new ExtractError(`Refusing to fetch a private or loopback address: ${parsed.hostname}`);
  }

  let res: Response;
  try {
    res = await fetch(parsed.toString(), {
      signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'ConverseKit-Ingest/1.0', 'Accept': 'text/html,text/plain,text/markdown,*/*' },
    });
  } catch (err) {
    throw new ExtractError(`Could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) throw new ExtractError(`Fetching ${url} returned HTTP ${res.status}`);

  const type = (res.headers.get('content-type') ?? '').toLowerCase();
  if (type.includes('pdf') || type.startsWith('image/') || type.startsWith('audio/') || type.startsWith('video/')) {
    throw new ExtractError(`Unsupported content type '${type.split(';')[0]}'. Only HTML, text and markdown are supported.`);
  }

  const body = await res.text();
  if (body.length > MAX_BYTES) throw new ExtractError(`Document is too large (${body.length} bytes, limit ${MAX_BYTES})`);

  const isHtml = type.includes('html') || /<html[\s>]/i.test(body.slice(0, 2000));
  const text   = isHtml ? htmlToText(body)
               : type.includes('markdown') ? markdownToText(body)
               : body;

  const title = isHtml
    ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() ?? null
    : null;

  return { text, title };
}

/**
 * Blocks the obvious SSRF targets: loopback, link-local, and the
 * RFC1918 ranges. Hostnames that resolve to private space are still
 * reachable — a full defence needs resolve-then-check, which the
 * Workers runtime does not expose. Recorded in docs/roadmap.md risks.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === '::1' || h === '0.0.0.0') return true;
  // IPv6 unique-local and link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  return false;
}
