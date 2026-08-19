// ----------------------------------------------------------------
// Ingestion: source → text → chunks → embeddings → rows
//
// Runs as service_role. The document row is created by the caller
// under RLS (which validates org membership); everything after that is
// derived data the tenant cannot write directly, so it is inserted
// with the privileged client.
//
// Status on the document row is the durability mechanism: a failure
// leaves `failed` plus the reason, and re-ingesting is idempotent
// because chunks are replaced wholesale. That is deliberately less
// than a Workflow gives you — see docs/roadmap.md Phase 2b for when to
// upgrade — but it survives the failure that actually happens here,
// which is a vendor rate-limit part-way through a batch.
// ----------------------------------------------------------------
import type { Env, Bot, Document, RagConfig } from '../types';
import type { ServiceDb, ChunkInsert } from '../supabase';
import {
  getDocumentForChat, updateDocument, replaceChunks,
  listFaqItemsForIngest, getFaqDocument,
} from '../supabase';
import { resolveEmbeddingProvider, ProviderError, DEFAULT_SIMILARITY_FLOOR } from '../providers';
import { chunkText, chunkQA, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP } from './chunk';
import { fetchUrl, markdownToText, ExtractError } from './extract';
import { storedFileToText } from './files';

/** Embedding requests per vendor call. Small enough to stay well
 *  inside payload limits, large enough to keep round-trips down. */
const EMBED_BATCH = 32;

/** A single document may not exceed this many chunks. Guards against
 *  one pasted novel consuming a tenant's entire embedding quota. */
const MAX_CHUNKS = 400;

export interface IngestResult {
  chunkCount: number;
  model: string;
  dimensions: number;
}

/** Ceiling on the rendered retrieval section, in characters. Roughly
 *  1500 tokens — enough for five 800-character chunks with room over,
 *  and small enough that it cannot crowd out the conversation. */
export const DEFAULT_CONTEXT_CHARS = 6000;

/** Similarity points added per priority level when ordering. Small on
 *  purpose: it decides near-ties, it does not overrule relevance. */
export const DEFAULT_PRIORITY_BOOST = 0.05;

/**
 * @param floor Default similarity floor for the embedding model that
 *   will actually run this query, from similarityFloorFor. Omitted by
 *   the callers that only want chunk sizes or the context budget —
 *   they get DEFAULT_SIMILARITY_FLOOR, which they never read.
 *
 *   A tenant's own min_similarity still wins over both. That is the
 *   whole contract: the floor became model-relative, an explicit
 *   override kept its meaning.
 */
export function ragConfigFor(bot: Bot, floor?: number): Required<RagConfig> {
  const c = bot.rag_config ?? {};
  return {
    enabled:        c.enabled ?? true,
    top_k:          clamp(c.top_k ?? 5, 1, 20),
    min_similarity: clamp(c.min_similarity ?? floor ?? DEFAULT_SIMILARITY_FLOOR, 0, 1),
    chunk_size:     clamp(c.chunk_size ?? DEFAULT_CHUNK_SIZE, 200, 4000),
    chunk_overlap:  clamp(c.chunk_overlap ?? DEFAULT_CHUNK_OVERLAP, 0, 1000),
    // The floor is 1000, not 0: a budget small enough to render nothing
    // would present as "retrieval is broken" rather than as a setting.
    context_chars:  clamp(c.context_chars ?? DEFAULT_CONTEXT_CHARS, 1000, 40_000),
    // Capped well below 1: a boost that can outweigh similarity outright
    // stops being a tie-breaker and becomes a pin, and pinning is a
    // different feature with different failure modes.
    priority_boost: clamp(c.priority_boost ?? DEFAULT_PRIORITY_BOOST, 0, 0.5),
    lexical_fallback: c.lexical_fallback ?? true,
  };
}

function clamp(n: number, lo: number, hi: number): number {
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : lo;
}

/** Resolve the document's raw text from whichever source it came from. */
async function extractText(env: Env, doc: Document, signal?: AbortSignal): Promise<{ text: string; title: string | null }> {
  if (doc.source === 'url') {
    if (!doc.url) throw new ExtractError('Document is a URL source but has no url');
    return fetchUrl(doc.url, signal);
  }
  if (doc.source === 'file') {
    return { text: await storedFileToText(env.DOCS, env.AI, doc), title: null };
  }
  const raw = doc.content ?? '';
  if (!raw.trim()) throw new ExtractError('Document has no content');
  return { text: doc.source === 'markdown' ? markdownToText(raw) : raw, title: null };
}

/**
 * Embed every piece and assert the width, in batches.
 *
 * Shared by both ingestion paths rather than duplicated, because the
 * 768 check is the one that turns a vendor misconfiguration into a
 * sentence instead of an opaque Postgres error, and a second copy of it
 * is a second copy to forget to update.
 */
async function embedPieces(
  env: Env, bot: Bot, pieces: string[],
): Promise<{ vectors: number[][]; model: string; dimensions: number }> {
  const embedder = resolveEmbeddingProvider(env, bot.embedding_config);

  const vectors: number[][] = [];
  for (let i = 0; i < pieces.length; i += EMBED_BATCH) {
    const batch = pieces.slice(i, i + EMBED_BATCH);
    const res = await embedder.embed({ input: batch });
    vectors.push(...res.vectors);
  }

  const dimensions = vectors[0]?.length ?? 0;
  if (dimensions !== 768) {
    // The chunks column is vector(768); a mismatch would fail on
    // insert with an opaque Postgres error. Say why instead.
    throw new Error(
      `Embedding model '${embedder.model}' returned ${dimensions} dimensions; ` +
      `this deployment stores 768. Choose a 768-dimension model, or set ` +
      `embedding_config.dimensions if the vendor supports truncation.`,
    );
  }

  return { vectors, model: embedder.model, dimensions };
}

export async function ingestDocument(
  env: Env,
  db: ServiceDb,
  documentId: string,
  bot: Bot,
): Promise<IngestResult> {
  const cfg = ragConfigFor(bot);

  const doc = await getDocumentForChat(db, documentId);
  if (!doc) throw new Error(`Document ${documentId} not found`);

  // The FAQ document has no content of its own — its text lives in
  // faq_items. Delegating here rather than special-casing the callers
  // is what makes "Reindex" on the Sources list work for it unchanged.
  if (doc.source === 'faq') return ingestFaq(env, db, doc.bot_id, bot);

  await updateDocument(db, documentId, { status: 'processing', error: null });

  try {
    const { text, title } = await extractText(env, doc);

    const pieces = chunkText(text, { size: cfg.chunk_size, overlap: cfg.chunk_overlap });
    if (pieces.length === 0) throw new ExtractError('Nothing left to index after extraction');
    if (pieces.length > MAX_CHUNKS) {
      throw new ExtractError(`Document produces ${pieces.length} chunks, over the ${MAX_CHUNKS} limit. Split it up.`);
    }

    const { vectors, model, dimensions } = await embedPieces(env, bot, pieces);

    await replaceChunks(db, {
      documentId,
      botId: doc.bot_id,
      rows: pieces.map((content, ordinal) => ({ ordinal, content, embedding: vectors[ordinal] })),
    });

    await updateDocument(db, documentId, {
      status: 'ready',
      error: null,
      chunk_count: pieces.length,
      embedding_model: model,
      embedding_dimensions: dimensions,
      // Cache the extracted text so a re-chunk needs no second fetch,
      // and so a file source survives losing its object in the bucket.
      content: doc.source === 'url' || doc.source === 'file' ? text : doc.content,
      ...(title && doc.title === doc.url ? { title } : {}),
    });

    return { chunkCount: pieces.length, model, dimensions };
  } catch (err) {
    const message = err instanceof ProviderError ? err.message
                  : err instanceof Error ? err.message
                  : String(err);
    await updateDocument(db, documentId, { status: 'failed', error: message.slice(0, 500) })
      .catch((e) => console.error('could not record ingest failure:', e));
    throw err;
  }
}

/**
 * Re-index a bot's whole FAQ.
 *
 * Every enabled item is chunked with chunkQA — one item is one chunk,
 * and an answer too long for the budget splits with its question
 * repeated into every piece. The chunks go in at kind='faq' and
 * priority=1, which is what makes match_chunks favour them on a
 * near-tie and what restricts the lexical fallback to hand-written
 * material.
 *
 * `metadata.faq_item_id` is the link back. Nothing reads it yet; the
 * chunk inspector and a future per-item index state both will, and
 * writing it now costs a jsonb column that already exists.
 *
 * Whole-FAQ rather than per-item because chunks are replaced per
 * document and there is one document. An edit therefore re-embeds
 * every enabled item — which the 200-item cap keeps to a handful of
 * batched calls, and which is the price of not building a second
 * ingestion state machine. See docs/knowledge-pipeline.md, D2.
 */
export async function ingestFaq(
  env: Env,
  db: ServiceDb,
  botId: string,
  bot: Bot,
): Promise<IngestResult> {
  const cfg = ragConfigFor(bot);

  const doc = await getFaqDocument(db, botId);
  if (!doc) throw new Error(`Bot ${botId} has no FAQ document`);

  await updateDocument(db, doc.id, { status: 'processing', error: null });

  try {
    const items = await listFaqItemsForIngest(db, botId);

    // Every item disabled, or none yet: not a failure. Clear the chunks
    // so retrieval stops returning answers the tenant took down, and
    // report ready-with-nothing rather than failed-with-a-reason.
    if (items.length === 0) {
      await replaceChunks(db, { documentId: doc.id, botId, rows: [] });
      await updateDocument(db, doc.id, { status: 'ready', error: null, chunk_count: 0 });
      return { chunkCount: 0, model: '', dimensions: 0 };
    }

    const rows: Array<Omit<ChunkInsert, 'embedding'>> = [];
    for (const item of items) {
      for (const content of chunkQA(item.question, item.answer, { size: cfg.chunk_size })) {
        rows.push({
          ordinal:  rows.length,
          content,
          kind:     'faq',
          priority: 1,
          metadata: { faq_item_id: item.id },
        });
      }
    }

    if (rows.length === 0) throw new Error('No FAQ items produced any text to index');
    if (rows.length > MAX_CHUNKS) {
      // Reported with the number rather than failing opaquely: 200 items
      // normally produce 200 chunks, so hitting 400 means several very
      // long answers split, and the tenant needs to know which lever to
      // pull.
      throw new Error(
        `${items.length} FAQ items produce ${rows.length} chunks, over the ${MAX_CHUNKS} limit. ` +
        `Shorten the longest answers, or move them to a document.`,
      );
    }

    const { vectors, model, dimensions } = await embedPieces(env, bot, rows.map((r) => r.content));

    await replaceChunks(db, {
      documentId: doc.id,
      botId,
      rows: rows.map((row, i) => ({ ...row, embedding: vectors[i] })),
    });

    await updateDocument(db, doc.id, {
      status: 'ready',
      error: null,
      chunk_count: rows.length,
      embedding_model: model,
      embedding_dimensions: dimensions,
    });

    return { chunkCount: rows.length, model, dimensions };
  } catch (err) {
    const message = err instanceof ProviderError ? err.message
                  : err instanceof Error ? err.message
                  : String(err);
    await updateDocument(db, doc.id, { status: 'failed', error: message.slice(0, 500) })
      .catch((e) => console.error('could not record FAQ ingest failure:', e));
    throw err;
  }
}
