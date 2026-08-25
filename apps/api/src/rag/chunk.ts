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
  /** The document's own title. Prefixed to every prose chunk together
   *  with the nearest preceding heading — see chunkText (M6). Absent
   *  means the breadcrumb is the heading alone, or nothing. */
  title?: string;
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

// ----------------------------------------------------------------
// Heading context (M6)
//
// chunkQA repeats the question into every piece of a split answer, and
// the reasoning in its header is exactly right: a fragment without its
// question is a fragment nothing will ever match. PROSE GOT NO
// EQUIVALENT. Chunk 14 of a pricing page is a bare paragraph with
// nothing in it saying it is about pricing, and that is ~90% of a
// corpus.
//
// THIS COULD NOT START HERE, which is the part worth recording. By the
// time text reaches this file its headings are already gone: markdown
// extraction stripped the `#` markers, HTML extraction replaced
// `<h2>` with a newline, and only a converted file arrived as markdown
// by accident. src/rag/extract.ts now preserves all three as ATX, so
// the splitter below has something to find.
// ----------------------------------------------------------------

/** An ATX heading line. The text is optional so `##` alone is consumed
 *  as a marker rather than embedded as two literal hashes. */
const HEADING = /^(#{1,6})(?:[ \t]+(.*))?$/;

/** Separator between the document title and the heading trail. Not a
 *  character a heading is likely to contain, and it reads as a path. */
const CRUMB = ' › ';

/**
 * Fraction of `size` the breadcrumb may consume.
 *
 * Past this the chunk is mostly header and the text it was supposed to
 * introduce no longer fits — the same failure MIN_ANSWER_BUDGET guards
 * against in chunkQA, reached from the other direction: there a long
 * question, here a long title against a small tenant-configured
 * chunk_size. Over the line the prefix is dropped whole rather than
 * truncated, because half a breadcrumb names the wrong section.
 */
const MAX_PREFIX_FRACTION = 0.25;

interface Section {
  /** The heading trail above this text, joined, or null at the top of
   *  a document. */
  heading: string | null;
  text: string;
}

/**
 * Split normalised text into (heading trail, prose) pairs.
 *
 * A heading with no body of its own does not lose its words: it is
 * carried into the next section's trail, so `# Pricing` immediately
 * followed by `## Plans` yields `Pricing › Plans` rather than dropping
 * `Pricing` on the floor. A trailing heading with nothing after it
 * becomes a section of its own text, which is exactly what this
 * function returned for it before headings were markers at all.
 */
function sections(normalized: string): Section[] {
  const out: Section[] = [];
  let trail: string[] = [];
  let buf: string[] = [];

  const flush = () => {
    const text = buf.join('\n').trim();
    buf = [];
    if (!text) return false;
    out.push({ heading: trail.join(CRUMB) || null, text });
    trail = [];
    return true;
  };

  for (const line of normalized.split('\n')) {
    const m = HEADING.exec(line.trim());
    if (!m) { buf.push(line); continue; }
    flush();
    const heading = (m[2] ?? '').trim();
    if (heading) trail.push(heading);
  }

  // Headings at the very end with no prose under them. Kept as content
  // rather than discarded — they are still the only words on that part
  // of the page.
  if (!flush() && trail.length) out.push({ heading: null, text: trail.join('\n') });

  return out;
}

/**
 * Split prose into chunks, each carrying where in the document it came
 * from.
 *
 * Every piece is emitted as
 *
 *     {title} › {nearest heading}
 *
 *     {chunk text}
 *
 * with the `#` markers consumed rather than embedded. The prefix is
 * part of `chunks.content`, so it is embedded, it appears in rendered
 * excerpts and in the chunk inspector, and it feeds the `search`
 * tsvector — which helps the lexical channel rather than hurting it,
 * since the heading carries the words a visitor is most likely to type.
 *
 * TWO CONSEQUENCES WORTH STATING OUT LOUD. It changes what gets
 * embedded, so it shifts the similarity distribution the measured
 * floors in catalog.ts were taken against. And an existing corpus gets
 * none of it until re-indexed, so the miss report's hitMedian will
 * drift as tenants re-index — which is a migration in progress, not a
 * regression.
 *
 * Overlap is applied WITHIN a section, not across one. A heading is a
 * genuine topic boundary, and carrying the tail of the pricing section
 * into the first chunk of the refunds section is the mid-sentence split
 * this file exists to avoid. With no headings there is exactly one
 * section, so the behaviour is byte-identical to the pre-M6 chunker.
 */
export function chunkText(input: string, opts: ChunkOptions = {}): string[] {
  const size    = Math.max(opts.size ?? DEFAULT_CHUNK_SIZE, 100);
  const overlap = Math.max(Math.min(opts.overlap ?? DEFAULT_CHUNK_OVERLAP, Math.floor(size / 2)), 0);
  const title   = (opts.title ?? '').trim().replace(/\s+/g, ' ');

  const normalized = normalizeText(input);
  if (!normalized) return [];

  const out: string[] = [];

  for (const section of sections(normalized)) {
    const crumbs = [title, section.heading].filter(Boolean).join(CRUMB);
    const full   = crumbs ? `${crumbs}\n\n` : '';
    const prefix = full.length <= size * MAX_PREFIX_FRACTION ? full : '';
    // What is left for the text itself. Floored so a pathological
    // prefix cannot drive the budget to zero.
    const budget = Math.max(size - prefix.length, 100);

    const pieces = split(section.text, budget)
      .map((p) => p.trim())
      .filter(Boolean);

    for (let i = 0; i < pieces.length; i++) {
      if (i === 0 || overlap === 0) { out.push(`${prefix}${pieces[i]}`); continue; }
      // Prepend the tail of the previous chunk so a fact spanning a
      // boundary is retrievable from either side. Carried from the
      // previous piece's TEXT, never from its prefix — repeating the
      // breadcrumb twice would spend the budget saying the same thing.
      const prev  = pieces[i - 1];
      const carry = prev.slice(Math.max(0, prev.length - overlap));
      out.push(`${prefix}${`${carry.trimStart()} ${pieces[i]}`.trim()}`);
    }
  }

  return out;
}
