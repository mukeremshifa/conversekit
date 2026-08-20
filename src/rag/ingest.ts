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
// upgrade.
//
// TWO THINGS MAKE THAT CLAIM TRUE, and until 012 neither existed.
//
// The header here used to say the design "survives the failure that
// actually happens, which is a vendor rate-limit part-way through a
// batch". It did not: embedPieces looped batches with no retry, so one
// 429 on batch 7 of 13 threw, the catch marked the document `failed`,
// and every batch already embedded was discarded. It now retries with
// bounded backoff, honours the vendor's own Retry-After, and spends a
// cumulative budget rather than an unbounded one — because a retry
// schedule longer than the `waitUntil` it runs inside is a worse
// failure than the one it fixes. See B5 in docs/rag-hardening.md.
//
// And two runs could interleave. `replaceChunks` is delete-then-insert,
// so two reindex clicks raced: the loser marked a document `failed`
// while the winner's chunks sat there indexed and working. Every entry
// point now goes through a claim on `documents.ingest_started_at`, and
// the loser throws AlreadyIndexing rather than touching `status` at
// all — the whole point being that the second run must not overwrite
// the first run's result. See B4.
// ----------------------------------------------------------------
import type { Env, Bot, Document, RagConfig } from '../types';
import type { ServiceDb, ChunkInsert } from '../supabase';
import {
  getDocumentForChat, updateDocument, replaceChunks,
  listFaqItemsForIngest, getFaqDocument,
  claimDocument, setBotIndexedModel, logUsage,
} from '../supabase';
import { usageTokens } from '../stats';
import {
  resolveEmbeddingProvider, ProviderError, DEFAULT_SIMILARITY_FLOOR, type Usage,
} from '../providers';
import { chunkText, chunkQA, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP } from './chunk';
import { fetchUrl, markdownToText, ExtractError } from './extract';
import { storedFileToText } from './files';

/** Embedding requests per vendor call. Small enough to stay well
 *  inside payload limits, large enough to keep round-trips down. */
const EMBED_BATCH = 32;

/** A single document may not exceed this many chunks. Guards against
 *  one pasted novel consuming a tenant's entire embedding quota. */
const MAX_CHUNKS = 400;

/** Attempts per batch, first included. Three, not more: past that the
 *  vendor is not having a bad second, it is having a bad minute, and
 *  the tenant is better served by a message than by a longer wait. */
const EMBED_ATTEMPTS = 3;

/** 1s, then 2s. Doubling from here. */
const EMBED_BACKOFF_MS = 1000;

/** Ceiling on any single wait, however long the vendor asks for. A
 *  `Retry-After: 3600` is a real answer to a real question and a
 *  useless one inside a request-scoped runtime. */
const EMBED_BACKOFF_CAP_MS = 10_000;

/**
 * Cumulative retry budget for one document, across every batch.
 *
 * This is the constant that matters, and per-batch limits alone would
 * not give it: three attempts × ten seconds × thirteen batches is
 * minutes of wall clock inside a `waitUntil` that will be killed
 * part-way through — a silent, partial, unrepeatable failure, which is
 * strictly worse than the clean one being fixed.
 */
const EMBED_RETRY_BUDGET_MS = 30_000;

/**
 * How long a claim on a document may be held before another run may
 * take it (012).
 *
 * Ten minutes is well past the slowest legitimate ingest — a 400-chunk
 * document is thirteen batched vendor calls — and well short of leaving
 * a tenant with a document they cannot re-index. It exists because a
 * Worker can die mid-`waitUntil` with no chance to release.
 */
export const CLAIM_STALE_MS = 10 * 60_000;

/**
 * Thrown when another run already holds this document's claim.
 *
 * A distinct type rather than a generic Error because the callers must
 * treat it differently from every other ingest failure: it is the one
 * outcome that must NOT mark the document `failed`. The first run is
 * still going, and overwriting its status is precisely the bug.
 */
export class AlreadyIndexing extends Error {
  constructor(readonly documentId: string) {
    super('This source is already being indexed. Wait for that to finish.');
    this.name = 'AlreadyIndexing';
  }
}

export interface IngestResult {
  chunkCount: number;
  model: string;
  dimensions: number;
}

/**
 * What one embedding run produced, including what it cost.
 *
 * `usage` is carried out of embedPieces rather than discarded there,
 * which is the whole of F2 in docs/usage-metering.md: this is the
 * larger of the two token numbers on the platform and it used to end
 * at the `res.usage` that nobody read.
 */
interface EmbedRun {
  vectors: number[][];
  model: string;
  dimensions: number;
  vendor: string;
  /** `inputTokens` null when no batch reported one — the platform
   *  default embedder never does. */
  usage: Usage;
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
    // 'fallback' is what every bot has been doing since 011, and the
    // default has to stay that: hybrid changes what comes back from
    // every search, and a mode that switched itself on would be a
    // silent behaviour change on somebody else's product. An
    // unrecognised value decays to the default rather than throwing —
    // this runs on the visitor's hot path.
    retrieval_mode: c.retrieval_mode === 'vector' || c.retrieval_mode === 'hybrid'
      ? c.retrieval_mode
      : 'fallback',
    rerank: c.rerank ?? false,
    // ── 015 ──
    // Both default to today's behaviour rather than to the
    // better-sounding one, exactly as retrieval_mode does. The router
    // changes which turns search at all and the FAQ shortcut changes
    // what answers them; neither is a decision the platform should make
    // on a tenant's behalf on a deploy they did not ask for.
    router: c.router === 'on' ? 'on' : 'off',
    // 0 is off, which is why this is one knob and not a knob plus a
    // boolean. Capped below 1: a threshold of 1 means "only an exact
    // string match", which is a feature nobody wants and everybody
    // would read as broken.
    faq_shortcut_threshold: clamp(c.faq_shortcut_threshold ?? 0, 0, 0.95),
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
 * How long to wait before retrying a failed embedding batch.
 *
 * Exported because it is the part of the backoff worth testing without
 * actually sleeping: the schedule, the vendor's override, and the cap
 * are three separate decisions and each can be wrong on its own.
 *
 * The vendor's own `Retry-After` wins over the schedule when it sends
 * one — it knows when its window resets and we are guessing — but it
 * is still capped, because an hour-long answer is correct and unusable
 * here. `attempt` is 1-based: the wait after the first failure.
 */
export function retryDelayMs(attempt: number, retryAfterSeconds: number | null): number {
  const scheduled = EMBED_BACKOFF_MS * 2 ** Math.max(0, attempt - 1);
  const asked = retryAfterSeconds === null ? null : retryAfterSeconds * 1000;
  return Math.min(asked ?? scheduled, EMBED_BACKOFF_CAP_MS);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Embed every piece and assert the width, in batches, with bounded
 * retries per batch.
 *
 * Shared by both ingestion paths rather than duplicated, because the
 * 768 check is the one that turns a vendor misconfiguration into a
 * sentence instead of an opaque Postgres error, and a second copy of it
 * is a second copy to forget to update.
 *
 * ONLY `retryable` FAILURES ARE RETRIED. A `bad_request` or an `auth`
 * failure is deterministic: retrying it burns the `waitUntil` budget to
 * arrive at exactly the same error, three times as slowly, and delays
 * the message that would let the tenant fix it.
 */
async function embedPieces(
  env: Env, bot: Bot, pieces: string[],
): Promise<EmbedRun> {
  const embedder = resolveEmbeddingProvider(env, bot.embedding_config);

  const vectors: number[][] = [];
  const batches = Math.ceil(pieces.length / EMBED_BATCH);
  let budget = EMBED_RETRY_BUDGET_MS;

  // Accumulated across batches, and NULL until some batch actually
  // reports something. Null is what tells the caller to estimate —
  // zero would be a claim that the vendor read nothing at all, which
  // on the platform default embedder (@cf/baai/bge-base-en-v1.5,
  // NO_USAGE) would be the number it reports for every ingest ever
  // run. See F3 in docs/usage-metering.md.
  let inputTokens: number | null = null;

  for (let i = 0; i < pieces.length; i += EMBED_BATCH) {
    const batch = pieces.slice(i, i + EMBED_BATCH);
    const batchNumber = i / EMBED_BATCH + 1;

    for (let attempt = 1; ; attempt++) {
      try {
        const res = await embedder.embed({ input: batch });
        vectors.push(...res.vectors);
        if (res.usage.inputTokens !== null) {
          inputTokens = (inputTokens ?? 0) + res.usage.inputTokens;
        }
        break;
      } catch (err) {
        if (!(err instanceof ProviderError) || !err.retryable) throw err;

        const wait = retryDelayMs(attempt, err.retryAfter);
        // Two ways to be out of road, and they are reported as one
        // thing because the tenant's next move is the same for both:
        // wait, then re-index.
        if (attempt >= EMBED_ATTEMPTS || wait > budget) {
          throw new ProviderError({
            kind:   err.kind,
            vendor: err.vendor,
            status: err.status,
            // Naming the batch is what separates "the vendor is
            // throttling you" from "your document is broken" — the
            // document reached batch 7 of 13, so it is not the file.
            message:
              `embedding batch ${batchNumber} of ${batches} failed after ${attempt} attempt` +
              `${attempt === 1 ? '' : 's'}: ${err.message}`,
          });
        }

        budget -= wait;
        await sleep(wait);
      }
    }
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

  return {
    vectors,
    model: embedder.model,
    dimensions,
    vendor: embedder.vendor,
    // Output is undefined rather than null: an embedding call has no
    // output side at all, and usageTokens keeps that distinct from
    // "produced zero output tokens".
    usage: { inputTokens, outputTokens: null },
  };
}

/**
 * Write the one `kind: 'embed'` row an ingest produces. NEVER THROWS —
 * logUsage swallows its own failures, and this runs after the corpus
 * is already durable.
 *
 * INGEST IS WHERE A TENANT'S TOKENS ACTUALLY GO. One document is
 * thousands of input tokens and one chat turn is hundreds, so a meter
 * that counts only chat under-reports the bill in the direction that
 * matters. It is also the path that reports nothing on the platform
 * default, which is why the estimator is the PRIMARY route here rather
 * than a fallback — see L1.
 *
 * Success only. A run that dies on batch 7 of 13 did spend tokens, but
 * nothing in hand says how many, and a row guessing at it would be
 * worse than the gap.
 */
async function logEmbedUsage(
  db: ServiceDb, botId: string, run: EmbedRun, pieces: string[],
): Promise<void> {
  if (!run.model) return;   // nothing was embedded
  await logUsage(db, {
    bot_id: botId,
    // Ingest belongs to no visitor's conversation.
    session_id: null,
    kind: 'embed',
    vendor: run.vendor,
    model: run.model,
    // The text the vendor was handed, joined the way it was sent.
    ...usageTokens(run.usage, { input: pieces.join('\n') }),
  });
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
  // Claimed there rather than here, so it is claimed exactly once.
  if (doc.source === 'faq') return ingestFaq(env, db, doc.bot_id, bot);

  // BEFORE the status write, not after. Losing the race must leave the
  // winner's `processing`/`ready`/`failed` exactly as it found it —
  // writing `processing` first and then discovering the claim is held
  // would already have clobbered it.
  if (!await claimDocument(db, documentId, CLAIM_STALE_MS)) {
    throw new AlreadyIndexing(documentId);
  }

  // Inside the try, so that every path from here on releases the claim.
  // A document left holding one is unindexable until the stale window
  // expires, and the status write is as able to fail as anything else.
  try {
    await updateDocument(db, documentId, { status: 'processing', error: null });

    const { text, title } = await extractText(env, doc);

    // The title goes to the chunker (M6), which prefixes it and the
    // nearest heading onto every prose chunk. A URL source whose title
    // is still the URL passes nothing rather than stamping a link on
    // every chunk — the extracted <title>, when there is one, is the
    // better name and is already in hand.
    const chunkTitle = title ?? (doc.title === doc.url ? '' : doc.title);
    const pieces = chunkText(text, {
      size: cfg.chunk_size, overlap: cfg.chunk_overlap, title: chunkTitle,
    });
    if (pieces.length === 0) throw new ExtractError('Nothing left to index after extraction');
    if (pieces.length > MAX_CHUNKS) {
      throw new ExtractError(`Document produces ${pieces.length} chunks, over the ${MAX_CHUNKS} limit. Split it up.`);
    }

    const run = await embedPieces(env, bot, pieces);
    const { vectors, model, dimensions } = run;

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
      // Released here rather than in a `finally`, so the claim and the
      // terminal status land in the same write. A crash between two
      // writes is the state the stale window exists to recover from,
      // but there is no reason to create one.
      ingest_started_at: null,
      // Cache the extracted text so a re-chunk needs no second fetch,
      // and so a file source survives losing its object in the bucket.
      content: doc.source === 'url' || doc.source === 'file' ? text : doc.content,
      ...(title && doc.title === doc.url ? { title } : {}),
    });

    // B2: the corpus is now this model's. Stamped on success only, and
    // after the document row, so a failure between the two leaves the
    // bot's last-known-good stamp rather than a claim about vectors
    // that were never written.
    await stampIndexedModel(db, doc.bot_id, model);

    // After the document row and the model stamp, for the same reason
    // both of those are ordered the way they are: the corpus is the
    // durable result, and the meter must never be the thing that turns
    // a successful ingest into a failed one.
    await logEmbedUsage(db, doc.bot_id, run, pieces);

    return { chunkCount: pieces.length, model, dimensions };
  } catch (err) {
    const message = err instanceof ProviderError ? err.message
                  : err instanceof Error ? err.message
                  : String(err);
    await updateDocument(db, documentId, {
      status: 'failed',
      error: message.slice(0, 500),
      // Released on failure too. A document holding a claim it will
      // never use is one nobody can re-index until the stale window
      // expires — and "click Reindex" is the entire remedy this screen
      // offers for a failed row.
      ingest_started_at: null,
    }).catch((e) => console.error('could not record ingest failure:', e));
    throw err;
  }
}

/**
 * Record the model a bot's corpus is now built with, without letting
 * that write fail an ingest that has already succeeded.
 *
 * The document row is the durable result; this is the hot-path hint
 * that makes drift detectable. Losing it degrades to NULL, which
 * retrieval reads as "unknown, allow" — the pre-012 behaviour, not a
 * broken bot.
 */
async function stampIndexedModel(db: ServiceDb, botId: string, model: string): Promise<void> {
  if (!model) return;
  await setBotIndexedModel(db, botId, model)
    .catch((e) => console.error('[rag] could not stamp the indexed model:', e));
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

  // Same claim, same reason as ingestDocument: every FAQ edit fires a
  // background re-index of the whole FAQ, so a tenant editing three
  // items quickly is the ordinary case rather than the pathological
  // one, and those runs must not interleave.
  if (!await claimDocument(db, doc.id, CLAIM_STALE_MS)) {
    throw new AlreadyIndexing(doc.id);
  }

  try {
    await updateDocument(db, doc.id, { status: 'processing', error: null });

    const items = await listFaqItemsForIngest(db, botId);

    // Every item disabled, or none yet: not a failure. Clear the chunks
    // so retrieval stops returning answers the tenant took down, and
    // report ready-with-nothing rather than failed-with-a-reason.
    if (items.length === 0) {
      await replaceChunks(db, { documentId: doc.id, botId, rows: [] });
      await updateDocument(db, doc.id, {
        status: 'ready', error: null, chunk_count: 0, ingest_started_at: null,
      });
      // No model to stamp: nothing was embedded, so the corpus is
      // whatever the last real ingest left it as.
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

    const pieces = rows.map((r) => r.content);
    const run = await embedPieces(env, bot, pieces);
    const { vectors, model, dimensions } = run;

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
      ingest_started_at: null,
    });

    await stampIndexedModel(db, botId, model);

    // Every FAQ edit re-embeds the whole FAQ (see the note above), so
    // this is the row that makes an expensive editing habit visible
    // rather than mysterious.
    await logEmbedUsage(db, botId, run, pieces);

    return { chunkCount: rows.length, model, dimensions };
  } catch (err) {
    const message = err instanceof ProviderError ? err.message
                  : err instanceof Error ? err.message
                  : String(err);
    await updateDocument(db, doc.id, {
      status: 'failed',
      error: message.slice(0, 500),
      ingest_started_at: null,
    }).catch((e) => console.error('could not record FAQ ingest failure:', e));
    throw err;
  }
}
