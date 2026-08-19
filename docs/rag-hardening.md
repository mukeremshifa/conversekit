# RAG hardening — audit and brief

What the retrieval pipeline actually does today, the six places it is broken,
the two that only break at scale, and what production grade would add.

[← Back to the roadmap](roadmap.md) · [Knowledge model](knowledge.md) ·
[The 011 brief](knowledge-pipeline.md)

---

## Status — phase 1 shipped

Everything below started as analysis against the live schema and the deployed
code. Measurements were taken read-only against the production project on
2026-08-19, when it held 11 chunks across 2 bots.

**Shipped:** B1 (model-relative similarity floor), B3 (CJK query gate), B6
(citation/marker alignment), M2 (`npm run eval:rag`), and the housekeeping.
No SQL migration was needed for any of it.

**Still open:** B2, B4, B5, S1, S2 and M1, M3–M8. Each is marked below.

The one thing phase 1 does **not** yet have is the measured floor for any
embedder other than bge. The mechanism resolves per model; only bge-base has a
number behind it, and every other vendor falls through to the documented 0.30
fallback marked as unmeasured. `npm run eval:rag -- --vendor=x --sweep=...` is
what replaces those, and it is the next thing to run — not the next thing to
build.

---

## What is already there

The loop is complete and the parts are individually sound:

| Stage | Where | State |
|---|---|---|
| Extract | [extract.ts](../src/rag/extract.ts), [files.ts](../src/rag/files.ts) | HTML/markdown/PDF/DOCX, SSRF-guarded |
| Chunk | [chunk.ts](../src/rag/chunk.ts) | Recursive character split + a Q&A-aware splitter |
| Embed | [ingest.ts](../src/rag/ingest.ts) | Batched, width-asserted, 11 vendors |
| Store | [005](../supabase/005_rag.sql), [011](../supabase/011_knowledge.sql) | pgvector, HNSW, `tsvector` + GIN, RLS |
| Retrieve | [retrieve.ts](../src/rag/retrieve.ts) | Vector search, priority boost, lexical fallback |
| Render | `renderContext` | Numbered excerpts, character budget, injection framing |
| Inspect | `retrieve-preview` | Runs the real path, reports the channel |

The architecture is right. **The defaults are not**, and that turns out to
matter more than any missing feature.

---

## Broken

### B1 — The similarity floor sits below the model's noise floor — **FIXED**

The headline finding, and the one that silently disabled three shipped
features.

Measured on the live corpus with the platform default embedder
(`@cf/baai/bge-base-en-v1.5`):

| Chunk pair | Pairs | Min | Avg | Max |
|---|---|---|---|---|
| **Different bots** — unrelated businesses | 10 | 0.476 | 0.516 | 0.557 |
| **Same bot** — genuinely related | 45 | 0.617 | 0.722 | 0.807 |

The default `min_similarity` is **0.30**. That is not merely low — it is below
the *minimum* score two completely unrelated businesses' documents achieve. The
floor cannot reject anything, so `match_chunks` returns `top_k` rows for every
query ever asked, including questions about the weather.

The sample is small (n=55 pairs, 2 bots), but the conclusion does not rest on
it: bge-base-en-v1.5 is documented as having a compressed similarity range,
typically 0.4–0.9. A 0.3 floor is calibrated for an OpenAI-like distribution
that spreads toward 0. The platform default embedder is not that model.

**What this disables.** In [index.ts](../src/index.ts#L404-L414),
`missedRetrieval = hasCorpus && chunks.length === 0`. If the floor never
rejects, `chunks` is never empty, so `missedRetrieval` is never true, and:

- `behavior.fallback_message` never fires — the tenant-authored "I don't know"
  wording is unreachable configuration.
- `escalate_after_misses` never fires — the miss streak is always zero.
- `lexical_fallback` never fires — it is gated on the vector channel returning
  *nothing*, which never happens.

Three features that a tenant can switch on in the dashboard, that are
documented, and that are tested, are dead in production. Nothing logs this.

**And the failure is worse than silence.** An off-topic question now injects
five irrelevant excerpts under a header that reads *"Treat them as FACTS TO
USE"*. The closing line of `renderContext` ("if they do not answer the
question, say you do not know") is the only thing standing between that and a
confident wrong answer — a prompt-level mitigation carrying load that a
threshold was supposed to carry.

**Fixed.** The floor is now resolved from the embedder that will actually run
the query, in [catalog.ts](../src/providers/catalog.ts):

```ts
resolveSimilarityFloor({ vendor, model })  // → { floor, source }
```

Resolution order is **model pattern, then vendor preset, then default** — model
first because Workers AI and Together serve the same bge weights, and a tenant
can point any OpenAI-compatible vendor at them through
`embedding_config.model`. Keying the floor to whoever is hosting the model
would get that case wrong.

`ragConfigFor(bot, floor?)` takes the resolved value as its default;
[retrieve.ts](../src/rag/retrieve.ts) resolves the embedder first and then
builds the config with it. An explicit tenant `min_similarity` still wins over
both, which is the whole contract.

**bge-base-en-v1.5 sits at 0.60** — measured, and the only measured number in
the table. The discriminative boundary above is between 0.557 and 0.617.
Everything else still falls through to `DEFAULT_SIMILARITY_FLOOR` (0.30),
explicitly commented as unmeasured. Guessing a number that then reads like a
measurement is the failure this whole entry is about, so the sweep produces
them instead.

`retrieve()` now returns what actually governed the search:

```ts
effective: { min_similarity, embedding_model, floor_source: 'tenant' | 'model' | 'default' }
```

and `retrieve-preview` reports it rather than recomputing a config without an
embedder — which would show a different number from the one the query was
filtered by. A tenant asking "why did it find nothing" gets the model, the
floor, and whether that floor was measured.

### B2 — Embedding model drift is silent and unrecoverable

`documents.embedding_model` is recorded at ingest. `retrieve()` calls
`resolveEmbeddingProvider(env, bot.embedding_config)` and compares it to
nothing.

Change a bot from Workers AI `bge-base-en-v1.5` to Google
`gemini-embedding-001` and both are 768-dimensional, so the width assertion in
`embedPieces` passes and Postgres raises no error. But the stored vectors and
the query vector now come from **different embedding spaces**. Cosine
similarity between them is noise. Retrieval returns confident nonsense
permanently, with no error, no status change, and no dashboard signal.

The dimension guard catches the OpenAI case (1536 ≠ 768) loudly. It cannot
catch the dangerous case, which is two models that agree on width and disagree
on everything else.

**Fix.** Compare at query time: if any of the bot's documents were embedded
with a model other than the one now resolving, mark those documents
`stale` and surface "Re-index required" in Sources. Refusing to retrieve is the
wrong call — degrading to the plain prompt beats answering from noise, but
telling the tenant is what actually fixes it.

### B3 — A 4-character minimum drops valid CJK questions — **FIXED**

```ts
if (q.length < 4) return { chunks: [], skipped: 'empty-query' };
```

The intent is right: "ok" and "hi" retrieve noise. But the measure is UTF-16
code units, and 天气如何 is a complete question in four characters while 多少钱
("how much?") is three and gets silently skipped. For a platform whose pitch
includes answering in the visitor's language, a Latin-alphabet word-length
heuristic is the wrong gate.

**Fixed.** `isTooShortToRetrieve` in [retrieve.ts](../src/rag/retrieve.ts)
counts **code points**, not code units, and drops the floor to 2 when the query
contains Han, Hiragana, Katakana, Hangul or Thai. Unicode property escapes
rather than hand-rolled ranges, so CJK Extension B and beyond come out right;
the code-point count is what stops a single astral character reading as two.

### B4 — Concurrent re-index leaves the status lying

`reindex` fires `waitUntil(ingestDocument(...))` with no lock, and
`replaceChunks` is delete-then-insert. Two clicks, or a click landing while a
`waitUntil` from an edit is still running, interleave:

```
A: delete  →  B: delete  →  A: insert (ok)  →  B: insert (conflict)
```

`unique(document_id, ordinal)` saves the data — there are no duplicate chunks —
but B's failure marks the document `failed` with an error message, while A's
chunks are sitting there indexed and working. The tenant sees a red row on a
document that is fine, and the natural response is to click reindex again.

**Fix.** A `documents.ingest_started_at` claim, or advisory-lock on the
document id in the RPC. Refuse rather than queue: the second run would produce
identical output.

### B5 — Ingestion does not survive the failure its own comment claims it survives

[ingest.ts](../src/rag/ingest.ts) opens by saying the design "survives the
failure that actually happens here, which is a vendor rate-limit part-way
through a batch." It does not. `embedPieces` loops batches of 32 with no retry,
no backoff, and no partial-progress record. One 429 on batch 7 of 13 throws,
the catch marks the document `failed`, and all prior work is discarded — the
next attempt re-embeds from zero and can fail the same way.

**Fix.** Bounded exponential backoff per batch (three attempts, respecting
`Retry-After` where the vendor sends it). The provider layer already models
`kind: 'rate_limit'` in [errors.ts](../src/providers/errors.ts), so the signal
exists and is simply not acted on.

### B6 — Citations do not correspond to the `[n]` markers the model sees — **FIXED**

`renderContext` numbers excerpts `[1]`, `[2]`, `[3]`. The `citations` array is
built separately as a deduplicated set of document *titles*, in Map iteration
order:

```ts
const titles = await getDocumentTitles(db, [...new Set(chunks.map(ch => ch.document_id))]);
citations = [...new Set([...titles.values()].filter(Boolean))];
```

Three chunks from one document collapse to one title; the ordering is the
database's, not the ranking's. So the model may write "according to [2]" while
the widget displays a source list where nothing is 2. The two numbering schemes
are unrelated and both are shown to the visitor.

There was a second bug underneath it: `renderContext` drops chunks that do not
fit the character budget, but citations were built from **all** chunks. The list
could name a document the model was never shown.

**Fixed.** The budget loop is now `selectContext`, exported from
[retrieve.ts](../src/rag/retrieve.ts), and the chat path renders exactly what it
selected. Citations are built from that selection, in rank order, **one entry
per rendered excerpt with duplicates preserved** — three chunks from one
document are three markers pointing at it, and collapsing them would renumber
the list out of step with the prompt. `citations` stays `string[]`, so the
wire contract is unchanged.

[widget.js](../public/widget.js) renders `[1,3] Pricing · [2] Hours` — markers
intact, each document named once.

Also fixed by the same change: `missedRetrieval` is now computed from the
rendered selection rather than the raw result set, so "the model was shown
nothing" and "retrieval missed" are finally the same statement.

*Not* done: folding the title into `match_chunks` to drop the per-turn round
trip. That changes the signature of a versioned SQL function, so it waits for
the next migration rather than riding along.

---

## Breaks at scale, not yet

### S1 — HNSW plus a tenant filter is a recall trap

One shared `chunks` table, one global HNSW index over `embedding
vector_cosine_ops`, and `where c.bot_id = p_bot_id` applied *after* the vector
ordering. `hnsw.ef_search` is unset, so it is the default 40.

At 11 rows the planner seq-scans and the index is never touched — confirmed by
`EXPLAIN` against the live database. That is why this is invisible today.

At scale the planner has two options and the dangerous one wins in the middle
of the range. When a bot's share of the table is small the b-tree on `bot_id`
is selective and the plan is correct. When a bot holds a large enough slice
that fetching all its rows looks expensive, the planner switches to the HNSW
ordered scan and filters afterwards — walking only `ef_search` candidates
globally and keeping whichever happen to belong to this tenant. The result is
**fewer than `top_k` rows, sometimes zero**, for a tenant whose corpus contains
a perfectly good answer, with no error and nothing in the logs.

The over-fetch in `match_chunks` (`limit top_k * 4 + 10`) helps the re-rank but
does not help here: it widens the candidate set *after* the index has already
decided which 40 nodes to visit.

**Fix, cheapest first.** `set local hnsw.ef_search` inside the RPC to something
like `greatest(40, p_match_count * 20)`. Then, on pgvector 0.8+, enable
`hnsw.iterative_scan = relaxed_order`, which is the feature built precisely for
filtered vector search. Partitioning `chunks` by tenant is the structural
answer and should not be reached for first.

*(I attempted to demonstrate this empirically with a 200k-row rolled-back
transaction; the test needed a `drop index` to force the plan and was blocked by
the sandbox. The mechanism is pgvector's documented filtered-search behaviour,
and the schema conditions for it are all present.)*

### S2 — Two avoidable round trips on every chat turn

`hasChunks(db, botId)` runs before retrieval on every turn to decide whether to
embed at all, and `getDocumentTitles` runs after it when citations are on. Both
are separate PostgREST calls on the hot path. The first can fold into
`match_chunks` — returning zero rows *is* "no corpus", and since B1 that is a
state which actually occurs, so the premise now holds.

The second did **not** disappear with B6. Aligning the citations needed no
schema change and got none; dropping the round trip means returning the title
from `match_chunks`, which changes the signature of a versioned SQL function.
Both halves of S2 are therefore one migration, and they should go together.

---

## What production grade adds

Ordered by value per unit of work, not by ambition.

### M1 — Retrieval logging, and the miss report built on it

Nothing records what was asked, what came back, at what score, or via which
channel. Every question in this audit that needed evidence needed a manual SQL
query against a table that happens to be small.

A `retrieval_log` row per turn — query, top score, channel, chunk ids, whether
it cleared the floor — is a day of work and it is the foundation for
everything else here. It also turns into the single most valuable *tenant*
feature in the product: **"here are the questions your visitors asked that your
bot could not answer."** That is the report that tells someone what to write
next, and it is the natural home for a "add this as an FAQ item" button that
closes the loop back into [FaqEditor.tsx](../dashboard/src/screens/knowledge/FaqEditor.tsx).

It needs a retention window and it holds visitor-typed text, so it is a privacy
surface — see the note in [tenancy.md](tenancy.md) about what the conversation
tables already carry.

### M2 — An eval harness — **BUILT**

There is no golden set of question → expected chunk, so every threshold in
`ragConfigFor` is a guess and no change to the pipeline can be shown to improve
it. B1 survived review, shipping and a dashboard build because nothing measures
retrieval quality.

**Built**, as [eval-rag.mjs](../scripts/eval-rag.mjs):

```bash
SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... WORKER_URL=http://localhost:8787 npm run eval:rag
```

It builds a disposable tenant with [testenv.mjs](../scripts/lib/testenv.mjs),
ingests a committed three-document corpus, and runs 16 questions and 8 off-topic
queries through `POST /v1/admin/bots/:id/retrieve-preview` — the endpoint that
calls the real `retrieve()`. **It reimplements nothing**: a harness that only
approximately reproduces production measures the harness.

Two departures from the sketch above, both of which matter:

**Negatives are first-class.** Recall@k alone cannot catch a floor that is too
low — a floor of 0.0 scores perfect recall while injecting five irrelevant
excerpts into every off-topic answer. The eight off-topic queries returning
*nothing* is what proves the floor discriminates, and it is the assertion that
fails on the pre-B1 default.

**Fixtures match on document title plus a distinctive substring, never on chunk
id.** `replaceChunks` is delete-then-insert, so every chunk gets a new id on
every re-index; an id-keyed golden set would rot the first time anyone changed
`chunk_size`. Matching is whitespace-insensitive because the corpus is
hard-wrapped and the chunker reflows.

`--sweep=0.3,0.4,0.5,0.6,0.7` runs the queries **once** with the floor at zero
and filters the returned scores client-side for each candidate. That is exactly
what `match_chunks` does — its floor is a predicate on raw similarity applied
after the over-fetch — so every candidate is scored against identical
embeddings instead of against its own run. It reports the viable band and the
number to put in `catalog.ts`.

Kept out of `npm test`, which is offline: embeddings are the thing under test,
so there is nothing to stub.

### M3 — Conversational query rewriting

The raw visitor message is embedded verbatim. In a multi-turn conversation
"what about the second one?" or "how much is that?" embeds to noise, so the
follow-up questions that matter most retrieve worst. A cheap rewrite pass —
resolve the pronouns against the last two turns before embedding — is the
standard fix and the chat provider is already resolved on that path.

Costs one extra model call per turn, so it wants to be conditional: skip it
when the message has no anaphora and stands alone.

### M4 — Real hybrid retrieval

The tsvector column, the GIN index and `match_chunks_lexical` all exist. Today
lexical runs only when vector returns *nothing*, and only over `priority > 0`
chunks — so it can rescue a curated FAQ and can never help a question whose
answer is a proper noun buried in a PDF, which is exactly the case keyword
search wins.

Running both channels every turn and fusing with reciprocal rank fusion is,
as the 011 brief predicted, a scoring change rather than a migration. The
groundwork is done, and **the gate is now open**: B1's floor means the vector
channel yields, so there is something to fuse with. M2 is what makes the fusion
weights arguable rather than guessed — the same trap B1 fell into, one layer up.

### M5 — Re-ranking

`top_k` comes straight off cosine similarity. A cross-encoder re-rank over the
already-over-fetched candidate set (`match_chunks` fetches `top_k * 4 + 10` and
throws most away) is the highest-precision-per-token step available, and the
candidates are already in hand. Workers AI hosts a re-ranker on the same free
tier as the default embedder.

### M6 — Heading context in prose chunks

`chunkQA` repeats the question into every piece of a split answer, and the
reasoning in its header is exactly right: a fragment without the question is a
fragment nothing will match. **Prose chunks get no equivalent.** Chunk 14 of a
pricing page is a bare paragraph with no indication it is about pricing.

Prepending the document title and nearest preceding heading to each prose chunk
is a small change to `chunkText`, costs a few tokens per chunk, and applies the
lesson the FAQ chunker already learned to the 90% of the corpus that is prose.
Probably the best retrieval-quality-per-line change on this list.

### M7 — URL sources never refresh

A URL is fetched once at ingest and the extracted text is cached on the
document row forever. A tenant who indexes their pricing page and then changes
their prices has a bot confidently quoting last year's numbers, with a source
list citing the page that now contradicts it.

A Cron Trigger re-fetching URL sources on a schedule, comparing a content hash,
and re-indexing only on change would fix it. Needs a `last_fetched_at` and a
visible "checked 3 days ago" in Sources, because silent staleness is the
failure mode being fixed.

### M8 — Near-duplicate suppression

Nothing dedupes. The same boilerplate paragraph in three indexed pages returns
three near-identical excerpts that consume three of five `top_k` slots and most
of `context_chars`. A similarity check between selected chunks at render time
(drop anything above ~0.95 against a chunk already kept) costs nothing and is
worth the most on exactly the corpora that are hardest to curate.

---

## Housekeeping

- ~~**Stale build artefacts on disk.**~~ **DONE.** Thirteen of them, not four —
  `src/providers` had nine more that the audit missed. All `tsc` output from
  August 10, all gitignored, all deleted.
- ~~**No unit tests for `retrieve()` or `ragConfigFor()`.**~~ **DONE.** Added to
  [test-knowledge-units.mjs](../scripts/test-knowledge-units.mjs): channel
  selection, the skip conditions including the CJK cases, floor resolution and
  provenance, and config clamping.

  `retrieve()` is exercised through the real wiring rather than a
  reimplementation — a `globalThis.fetch` stub answers `/embeddings` and both
  RPCs, with `embedding_config` pointed at the keyless `custom` vendor. Provider
  resolution, the floor, the RPC payloads and the fallback decision all run
  exactly as they do in the Worker, and the tests assert on what
  `match_chunks` was actually *asked* for.
- **No SQL-level test for ranking.** `match_chunks`'s boost and
  `match_chunks_lexical`'s overlap gate were verified by hand against the live
  database during the 011 work and are not covered by
  [knowledge-test.sql](../scripts/rls/knowledge-test.sql), which tests isolation
  rather than ranking.

---

## Suggested order

**~~First, and small:~~ DONE.** B1 with M2 to prove it, then B3, B6 and the
housekeeping. No migration was needed.

**Next, and it is a run rather than a build:** `npm run eval:rag --
--vendor=google --sweep=...` for every embedding vendor with a
`defaultEmbedModel`, and commit the measured floors. Until then every non-bge
vendor is on the unmeasured 0.30 — which is the value B1 was about, still in
place for anyone who switched away from the platform default.

**Then:** M1 (retrieval logging + miss report), which is the largest tenant-
visible win on the list and makes every later change measurable. B2 and B4
alongside it, since both are about telling the tenant the truth about index
state.

**Then, quality:** M8 and M6 (cheap, no new infrastructure), then M4 (hybrid,
groundwork already laid), then M5 (re-rank).

**Before real scale:** S1. It is invisible now and unpleasant to debug later,
and the first mitigation is one `set local` inside an existing function.

**Deferred deliberately:** M3 and M7 both cost recurring calls or a Cron
Trigger, and neither pays off until the corpus is bigger and the conversations
longer than they are today.
