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

// ----------------------------------------------------------------
// Q&A pairs
//
// The one content shape whose boundaries are known exactly. Handing a
// curated FAQ to the recursive splitter above throws that away — it
// cuts mid-answer, or bundles three unrelated questions into one
// embedding — so a pair gets its own chunker instead.
//
// One item is one chunk. When an answer is too long for the budget it
// splits, and THE QUESTION IS REPEATED INTO EVERY PIECE. That is the
// whole point: the question carries the words a visitor will actually
// type, so a fragment without it is a fragment nothing will ever match.
// A character splitter cannot do this, because it does not know which
// part of the text is the question.
// ----------------------------------------------------------------

/** Rendered so the model reads a pair as a pair, and so the chunk
 *  inspector shows a tenant something recognisable as their own FAQ. */
const Q_PREFIX = 'Q: ';
const A_PREFIX = 'A: ';

/** An answer never gets less room than this, however long the question
 *  is — otherwise a 300-character question against a small chunk_size
 *  produces a chunk that is all header and no answer. */
const MIN_ANSWER_BUDGET = 200;

export function chunkQA(question: string, answer: string, opts: ChunkOptions = {}): string[] {
  const size = Math.max(opts.size ?? DEFAULT_CHUNK_SIZE, 100);

  const q = normalizeText(question).replace(/\n+/g, ' ').trim();
  const a = normalizeText(answer);
  if (!q || !a) return [];

  const header = `${Q_PREFIX}${q}\n${A_PREFIX}`;
  const budget = Math.max(size - header.length, MIN_ANSWER_BUDGET);

  // No overlap between the pieces of one answer. Overlap exists to make
  // a fact that straddles a boundary findable from either side, and the
  // repeated question already does that job here — adding both would
  // spend the budget saying the same thing twice.
  const pieces = a.length <= budget
    ? [a]
    : split(a, budget).map((p) => p.trim()).filter(Boolean);

  return pieces.map((piece) => `${header}${piece}`);
}

// ----------------------------------------------------------------
// Parsing a legacy bots.faq blob into items
//
// Used once per bot, by the 011 cutover. The shape it targets is the
// one 002_phase1.sql seeded and the one the old FAQ textarea hinted
// at — `Q: …` / `A: …`, usually separated by blank lines — but a
// tenant typed this field freehand for two years, so the parser has to
// assume nothing and lose nothing.
//
// Text belonging to no pair comes back as `unparsed` rather than being
// discarded or guessed at. The caller puts it in the corpus as prose,
// which is where unstructured text belongs anyway.
// ----------------------------------------------------------------

export interface FaqDraft { question: string; answer: string }
export interface ParsedFaq {
  items: FaqDraft[];
  /** Everything that was not part of a pair. Empty string when all of
   *  the text parsed. */
  unparsed: string;
}

// Tolerant of the punctuation people actually type. Anchored to the
// start of a line so a "Q:" inside an answer stays inside the answer.
const Q_MARKER = /^(?:q|question)\s*[:.)\-–]\s*(.*)$/i;
const A_MARKER = /^(?:a|ans|answer)\s*[:.)\-–]\s*(.*)$/i;

export function parseFaqText(input: string): ParsedFaq {
  const normalized = normalizeText(input);
  if (!normalized) return { items: [], unparsed: '' };

  const items: FaqDraft[] = [];
  const loose: string[] = [];

  let question: string[] | null = null;
  let answer: string[] | null = null;

  /** Close the pair in progress. A question with no answer is not a
   *  pair — it goes to `loose`, because an empty answer would embed to
   *  noise and teach the bot nothing. */
  const flush = () => {
    const q = question?.join(' ').trim() ?? '';
    const a = answer?.join('\n').trim() ?? '';
    if (q && a) items.push({ question: q, answer: a });
    else if (q || a) loose.push([q, a].filter(Boolean).join('\n'));
    question = null;
    answer = null;
  };

  for (const raw of normalized.split('\n')) {
    const line = raw.trim();

    const q = Q_MARKER.exec(line);
    if (q) {
      flush();
      question = q[1] ? [q[1]] : [];
      continue;
    }

    const a = question !== null ? A_MARKER.exec(line) : null;
    if (a) {
      answer = a[1] ? [a[1]] : [];
      continue;
    }

    if (!line) {
      // A blank line ends a pair but not a run of loose prose — the
      // 002 seed separates its pairs exactly this way.
      if (question !== null && answer !== null) flush();
      else if (loose.length && loose[loose.length - 1] !== '') loose.push('');
      continue;
    }

    if (answer !== null) answer.push(line);
    else if (question !== null) question.push(line);
    else loose.push(line);
  }
  flush();

  return { items, unparsed: loose.join('\n').replace(/\n{3,}/g, '\n\n').trim() };
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
