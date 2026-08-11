// ----------------------------------------------------------------
// Text chunking
//
// Recursive character splitting: try to break on the largest natural
// boundary that fits, and only fall back to a hard cut when a single
// run of text has no boundary at all. Splitting mid-sentence is the
// cheapest way to make retrieval worse, because the embedding then
// describes half a thought.
//
// Sizes are in characters, not tokens. A token estimate would need a
// tokenizer per vendor, and the ~4-chars-per-token rule is close
// enough when the only consumer is a chunk-size budget.
// ----------------------------------------------------------------

export interface ChunkOptions {
  /** Target maximum chunk length in characters. */
  size?: number;
  /** Characters of trailing context repeated into the next chunk. */
  overlap?: number;
}

export const DEFAULT_CHUNK_SIZE = 800;
export const DEFAULT_CHUNK_OVERLAP = 120;

/** Ordered widest-to-narrowest. Paragraphs before lines before words. */
const SEPARATORS = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' '];

/** Collapse the whitespace noise that HTML-to-text extraction leaves. */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Split `text` so that no piece exceeds `size`, preferring the widest
 * separator that produces a piece which fits.
 */
function split(text: string, size: number): string[] {
  if (text.length <= size) return [text];

  for (const sep of SEPARATORS) {
    const idx = text.lastIndexOf(sep, size);
    // Ignore a separator so early that the chunk would be mostly empty —
    // that produces a long tail of tiny fragments.
    if (idx > size * 0.4) {
      const head = text.slice(0, idx + sep.length);
      const tail = text.slice(idx + sep.length);
      return [head, ...split(tail, size)];
    }
  }

  // No usable boundary: hard cut. Happens with things like base64 blobs.
  return [text.slice(0, size), ...split(text.slice(size), size)];
}

export function chunkText(input: string, opts: ChunkOptions = {}): string[] {
  const size    = Math.max(opts.size ?? DEFAULT_CHUNK_SIZE, 100);
  const overlap = Math.max(Math.min(opts.overlap ?? DEFAULT_CHUNK_OVERLAP, Math.floor(size / 2)), 0);

  const normalized = normalizeText(input);
  if (!normalized) return [];

  const pieces = split(normalized, size)
    .map((p) => p.trim())
    .filter(Boolean);

  if (overlap === 0 || pieces.length < 2) return pieces;

  // Prepend the tail of the previous chunk so a fact spanning a
  // boundary is retrievable from either side.
  return pieces.map((piece, i) => {
    if (i === 0) return piece;
    const prev = pieces[i - 1];
    const carry = prev.slice(Math.max(0, prev.length - overlap));
    return `${carry.trimStart()} ${piece}`.trim();
  });
}
