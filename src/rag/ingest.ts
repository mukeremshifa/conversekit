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
import type { ServiceDb } from '../supabase';
import { getDocumentForChat, updateDocument, replaceChunks } from '../supabase';
import { resolveEmbeddingProvider, ProviderError } from '../providers';
import { chunkText, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP } from './chunk';
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

export function ragConfigFor(bot: Bot): Required<RagConfig> {
  const c = bot.rag_config ?? {};
  return {
    enabled:        c.enabled ?? true,
    top_k:          clamp(c.top_k ?? 5, 1, 20),
    min_similarity: clamp(c.min_similarity ?? 0.3, 0, 1),
    chunk_size:     clamp(c.chunk_size ?? DEFAULT_CHUNK_SIZE, 200, 4000),
    chunk_overlap:  clamp(c.chunk_overlap ?? DEFAULT_CHUNK_OVERLAP, 0, 1000),
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

export async function ingestDocument(
  env: Env,
  db: ServiceDb,
  documentId: string,
  bot: Bot,
): Promise<IngestResult> {
  const cfg = ragConfigFor(bot);

  const doc = await getDocumentForChat(db, documentId);
  if (!doc) throw new Error(`Document ${documentId} not found`);

  await updateDocument(db, documentId, { status: 'processing', error: null });

  try {
    const { text, title } = await extractText(env, doc);

    const pieces = chunkText(text, { size: cfg.chunk_size, overlap: cfg.chunk_overlap });
    if (pieces.length === 0) throw new ExtractError('Nothing left to index after extraction');
    if (pieces.length > MAX_CHUNKS) {
      throw new ExtractError(`Document produces ${pieces.length} chunks, over the ${MAX_CHUNKS} limit. Split it up.`);
    }

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

    await replaceChunks(db, {
      documentId,
      botId: doc.bot_id,
      rows: pieces.map((content, ordinal) => ({ ordinal, content, embedding: vectors[ordinal] })),
    });

    await updateDocument(db, documentId, {
      status: 'ready',
      error: null,
      chunk_count: pieces.length,
      embedding_model: embedder.model,
      embedding_dimensions: dimensions,
      // Cache the extracted text so a re-chunk needs no second fetch,
      // and so a file source survives losing its object in the bucket.
      content: doc.source === 'url' || doc.source === 'file' ? text : doc.content,
      ...(title && doc.title === doc.url ? { title } : {}),
    });

    return { chunkCount: pieces.length, model: embedder.model, dimensions };
  } catch (err) {
    const message = err instanceof ProviderError ? err.message
                  : err instanceof Error ? err.message
                  : String(err);
    await updateDocument(db, documentId, { status: 'failed', error: message.slice(0, 500) })
      .catch((e) => console.error('could not record ingest failure:', e));
    throw err;
  }
}
