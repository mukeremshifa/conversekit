# RAG hardening — audit and brief

What the retrieval pipeline actually does today, the six places it was broken,
the two that only broke at scale, and what production grade adds.

[← Back to the roadmap](roadmap.md) · [Knowledge model](knowledge.md) ·
[The 011 brief](knowledge-pipeline.md)

---

## Status — phases 1, 2 and 3 shipped

Everything below started as analysis against the live schema and the deployed
code. Measurements were taken read-only against the production project on
2026-08-19, when it held 11 chunks across 2 bots.

**Phase 1 shipped:** B1 (model-relative similarity floor), B3 (CJK query gate),
B6 (citation/marker alignment), M2 (`npm run eval:rag`), and the housekeeping.
No SQL migration was needed for any of it.

**Phase 2 shipped**, all on [`012_retrieval.sql`](../supabase/012_retrieval.sql):
M1 (retrieval logging and the tenant-facing miss report), B2 (embedding-model
drift), B4 (the re-index claim), B5 (ingest retry with backoff), S1's first
mitigation (`hnsw.ef_search`), and the S2 title fold.

Phase 2 is one theme, not four fixes: **the pipeline stops lying about its own
state, and starts telling the tenant the truth.** Every claim in the phase 1
audit needed a hand-written SQL query against a table that happened to be small.
Now a bot records what it was asked and whether it could answer, a vendor switch
says so instead of poisoning every answer silently, a raced re-index no longer
marks a working document `failed`, and a rate limit part-way through a batch no
longer discards the batches before it.

**Phase 3 shipped**, on [`013_hybrid.sql`](../supabase/013_hybrid.sql) plus
pure-Worker changes: M8 (near-duplicate suppression), M6 (heading context in
prose chunks), M4 (real hybrid retrieval), M5 (cross-encoder re-ranking), the
`hasChunks` half of S2, S1's `iterative_scan`, and the ranking SQL test that was
the last open housekeeping item.

Phase 3 is also one theme: **every item in it changes what comes back from a
search**, which is a class of change nothing would notice going wrong. Two of
them ship switched off — `retrieval_mode` defaults to `'fallback'` and `rerank`
to `false` — because the alternative is a silent behaviour change on somebody
else's product.

**Still open:** M3 and M7, both deliberately deferred; the eval sweep, which is
a run rather than a build; and the 200k-row fixture that would let S1 be
described as verified rather than as reasoned.

The one thing neither phase has is the measured floor for any embedder other
than bge. The mechanism resolves per model; only bge-base has a number behind
it, and every other vendor falls through to the documented 0.30 fallback marked
as unmeasured. `npm run eval:rag -- --vendor=x --sweep=...` is what replaces
those, and it is the next thing to run — not the next thing to build. The miss
report now measures the same thing continuously against real traffic, which
narrows the gap but does not close it: it reports the floor in force and the
score distribution around it, and it cannot tell you what a *different* floor
would have retrieved.

---

## What is already there

The loop is complete and the parts are individually sound:

| Stage | Where | State |
|---|---|---|
| Extract | [extract.ts](../src/rag/extract.ts), [files.ts](../src/rag/files.ts) | HTML/markdown/PDF/DOCX, SSRF-guarded |
| Chunk | [chunk.ts](../src/rag/chunk.ts) | Recursive character split + a Q&A-aware splitter |
| Embed | [ingest.ts](../src/rag/ingest.ts) | Batched, width-asserted, 11 vendors |
| Store | [005](../supabase/005_rag.sql), [011](../supabase/011_knowledge.sql), [012](../supabase/012_retrieval.sql) | pgvector, HNSW + `ef_search`, `tsvector` + GIN, RLS |
| Retrieve | [retrieve.ts](../src/rag/retrieve.ts) | Vector search, priority boost, lexical fallback, drift gate |
| Render | `renderContext` | Numbered excerpts, character budget, injection framing |
| Inspect | `retrieve-preview` | Runs the real path, reports the channel |
| Observe | `retrieval_log`, `buildMissReport` | Per-turn outcome, miss report, 90-day retention |

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

### B2 — Embedding model drift is silent and unrecoverable — **FIXED**

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

**Fixed**, in two places that answer two different questions.

**On the hot path, at zero extra cost.** `bots.embedding_model_indexed` (012) is
stamped by both ingest paths on success, and `retrieve()` compares it against
the embedder it has just resolved — it already holds the bot row, so this is a
string compare rather than a query. A mismatch returns
`{ chunks: [], skipped: 'stale-index' }` *before* the embedding call, and the
turn proceeds on the plain prompt. Degrading beats answering from noise.

Two things that had to be right, and both are asserted in
[test-knowledge-units.mjs](../scripts/test-knowledge-units.mjs):

- **NULL is not drift.** Every corpus indexed before 012 has no stamp, and
  reading unknown as mismatched would have switched retrieval off for every
  bot on the platform at once. The migration also backfills the column from
  each bot's most recently updated `ready` document, so the NULL case is the
  genuinely-unknown one rather than the common one.
- **A stale index is not a miss.** `missedRetrieval` stays false, because
  otherwise `fallback_message` fires on literally every turn and
  `escalate_after_misses` escalates every conversation — on a bot that is
  answering perfectly well from its knowledge-base fields. Drift is closer to
  "this bot has no corpus" than to "this bot could not answer". It is logged as
  its own thing, and `retrieve-preview` says so in as many words.

**In the dashboard, per document.** `GET /v1/admin/bots/:id/documents` now
returns the model that would resolve *today* alongside the list, and
[Sources.tsx](../dashboard/src/screens/Sources.tsx) shows **"re-index required"**
as a fifth badge beside `pending`/`processing`/`ready`/`failed`, plus a banner
offering to re-index every affected source. Per document because a mixed corpus
is real: the bot-level stamp is the last ingest, the per-document column is the
detail.

That second half also covers the case the bot column cannot — changing the
platform default `EMBEDDING_VENDOR` in `wrangler.toml` alters no bot row at all,
and every corpus on the deployment goes stale at once.

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

### B4 — Concurrent re-index leaves the status lying — **FIXED**

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

**Fixed** with a `documents.ingest_started_at` claim (012). `claimDocument` is a
single conditional PATCH —
`?id=eq.X&or=(ingest_started_at.is.null,ingest_started_at.lt.<cutoff>)` — which
PostgREST turns into one UPDATE, so the compare-and-set is atomic in Postgres
and zero rows back means someone else holds it. The claim is released on success
*and* in the failure path, in the same write as the terminal `status`, so a
document is never left both `ready` and claimed.

The claim lives **inside** `ingestDocument`/`ingestFaq`, so every caller
inherits it: the reindex route, both upload paths and `knowledge/migrate`. The
loser throws a typed `AlreadyIndexing` rather than marking anything `failed` —
that is the whole point, since the bug is the second run overwriting the first
run's status.

Three details that are not obvious from the one-line version:

- **A stale claim is reclaimable, after 10 minutes.** A Worker can die
  mid-`waitUntil` with no chance to release, and a document nobody can ever
  re-index is a worse failure than the double index. The reindex route's
  pre-check honours the same window for the same reason.
- **The route's 409 is a courtesy, not the guarantee.** It reads the document,
  sees `processing`, and tells the tenant — but two clicks a millisecond apart
  both read "free". The claim is the correctness argument; the 409 exists so the
  common case gets a sentence instead of a `202` for work that will not happen.
- **The FAQ path retries instead of refusing.** Clicking Reindex twice asks for
  the same work twice, so refusing the second is right. But an FAQ re-index is
  triggered by an *edit*, and a tenant fixing three answers in a row is ordinary
  — the second run reads different items. Refusing it would leave the corpus one
  edit behind while the editor showed `ready`, a quieter version of exactly the
  lie this fix is about. `reindexFaq` retries the claim a few times, and because
  `ingestFaq` re-reads every item when it starts, one later run subsumes any
  number of edits made while it was blocked.

### B5 — Ingestion does not survive the failure its own comment claims it survives — **FIXED**

[ingest.ts](../src/rag/ingest.ts) opens by saying the design "survives the
failure that actually happens here, which is a vendor rate-limit part-way
through a batch." It does not. `embedPieces` loops batches of 32 with no retry,
no backoff, and no partial-progress record. One 429 on batch 7 of 13 throws,
the catch marks the document `failed`, and all prior work is discarded — the
next attempt re-embeds from zero and can fail the same way.

**Fixed.** `ProviderError` gained `retryAfter`, parsed from the `Retry-After`
header in `errorFromResponse` — both RFC forms, seconds and HTTP date. The
`rate_limit` kind and the `retryable` flag were already modelled; the vendor's
own answer to *how long* was the one piece missing.

`embedPieces` now retries each batch up to three attempts at 1s/2s/4s, honouring
`retryAfter` when present and capped at 10s, and **only when `err.retryable`** —
a `bad_request` or an `auth` failure fails on the first attempt, because
retrying those burns the `waitUntil` budget to arrive at the same error three
times as slowly.

The constant that matters is the one a per-batch limit would not give you: **a
cumulative retry budget of 30 seconds per document**. Three attempts × ten
seconds × thirteen batches is minutes of wall clock inside a `waitUntil` that
will be killed part-way — a silent, partial, unrepeatable failure, strictly
worse than the clean one being fixed.

On exhaustion the error names the batch (`embedding batch 7 of 13 failed after
3 attempts: …`), so a tenant can tell "the vendor is throttling you" from "your
document is broken" — the document reached batch 7, so it is not the file.

The header comment at the top of [ingest.ts](../src/rag/ingest.ts), which had
been claiming all of this since it was written, now describes what the code
does.

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

### S1 — HNSW plus a tenant filter is a recall trap — **MITIGATED, both halves**

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

**Mitigated, cheapest first.** 012 rewrote `match_chunks` as `language plpgsql`
for exactly one reason — so the body can

```sql
perform set_config('hnsw.ef_search', greatest(40, coalesce(p_match_count, 5) * 20)::text, true);
```

before the query. Deep enough that a filtered index scan still has this tenant's
rows in the candidate pool, floored at pgvector's own default so a small `top_k`
never makes recall worse than it was.

Two details, both verified against Postgres rather than assumed:

- **`perform set_config` is required, not preferred.** `SET LOCAL` is a utility
  statement and a `STABLE` function may not run one — it fails outright with
  *"SET is not allowed in a non-volatile function"*. `set_config` is an ordinary
  function call inside a `SELECT`, which a read-only context permits.
- **`is_local := true` scopes the value to the transaction, not to the call.**
  It remains set after the function returns and is discarded at transaction end;
  a function's own `SET` clause commits its nested GUC values upward rather than
  rolling them back. That is the property that matters, because PostgREST runs
  every request in its own transaction — so it cannot leak between requests,
  which is the only leak that would change another caller's results.

**The second half shipped on 013.** `hnsw.iterative_scan = relaxed_order` is the
feature built precisely for filtered vector search: instead of walking
`ef_search` nodes globally and keeping whichever belong to this tenant, the scan
keeps pulling candidates until the filter has yielded enough rows.

It is **guarded**, and that is not defensive habit — `set_config` on an unknown
GUC *errors*, and the parameter does not exist before pgvector 0.8. Unguarded,
this line would turn every search on an older deployment into a 500. The
alternative (emitting the body conditionally at migration time via `do $$ …
execute … $$`) is faster by an immeasurable amount and hides the fallback from
anyone reading the function; the exception block is self-documenting, which is
the point.

`hnsw.max_scan_tuples` is paired with it deliberately: relaxed order with no
ceiling can degenerate into scanning most of the index for a tenant whose slice
is tiny and whose query matches nothing — the pathology being fixed, inverted.

Partitioning `chunks` by tenant is the structural answer and should still not be
reached for first.

*(**Still unverified against rows, and described that way on purpose.** The
phase 2 attempt to demonstrate the recall trap empirically used a 200k-row
rolled-back transaction; it needed a `drop index` to force the plan and was
blocked. Both mitigations therefore ship in the same state: the mechanism is
pgvector's documented filtered-search behaviour and every schema condition for
it is present, but no fixture has shown it happening. Building that fixture
properly under `scripts/spike/` is what would change this sentence. Do not
describe it as verified until someone does.)*

### S2 — Two avoidable round trips on every chat turn — **FIXED**

`hasChunks(db, botId)` runs before retrieval on every turn to decide whether to
embed at all, and `getDocumentTitles` ran after it when citations are on. Both
are separate PostgREST calls on the hot path.

**The title fold shipped.** Both RPCs now return `document_title` from a join to
`documents`, so a citation names its source from the row `match_chunks` already
returned. `getDocumentTitles` was deleted rather than left as an unused export —
`retrieve-preview` moved to the same field, so it had no callers.

It is worth recording that this is the field phase 1 *added and then removed* as
dead surface. It now has a reason to exist, and the reason is the round trip B6
could not take without changing the signature of a versioned SQL function. The
join is `left`, not inner: a chunk whose document row is mid-delete must still
be returned rather than silently vanishing from a search.

**The `hasChunks` half shipped on 013 — but not as the fold described above,
and the correction is the interesting part.**

> ~~It can fold into `match_chunks` — returning zero rows *is* "no corpus".~~

**That fold re-opens B1.** `src/index.ts` computes

```ts
const missedRetrieval = hasCorpus && !staleIndex && rendered.length === 0;
```

Derive `hasCorpus` from whether `match_chunks` returned rows and this becomes
`(rows > 0) && (rendered === 0)` — true only in the narrow case where the
context budget dropped everything. `fallback_message`, `escalate_after_misses`
and `lexical_fallback` all go dead again: the exact three features B1 disabled,
by a different mechanism, one phase later. It would also cost an embedding call
per turn for bots with **no** corpus, which is the one case the probe exists to
make free — you cannot ask `match_chunks` anything until you have a vector.

**"No corpus" and "nothing cleared the floor" have to stay two distinct
states.** So 013 adds `bots.chunk_count`, maintained by a **statement-level**
trigger on `chunks` using transition tables. The bot row is already fetched
before retrieval, so `hasCorpus` becomes a field read; the embed skip survives;
and the two states are separate by construction rather than by care.

Statement-level and not row-level because `replaceChunks` is delete-then-insert
of up to 400 rows and a per-row trigger would fire 800 times per ingest to
compute a number that only has to be right at the end. The count is recomputed
rather than incremented, because a delta is a second source of truth that drifts
the first time a statement does something unexpected.

`hasChunks()` remains in `src/supabase.ts` as the fallback for a Worker running
ahead of the migration: **`chunk_count` undefined means unknown, not zero**, and
reading an absent column as "no corpus" would switch retrieval off for every bot
on the platform. Free side benefit: Sources can show "11 chunks indexed" without
a query.

---

## What production grade adds

Ordered by value per unit of work, not by ambition.

### M1 — Retrieval logging, and the miss report built on it — **BUILT**

Nothing recorded what was asked, what came back, at what score, or via which
channel. Every question in this audit that needed evidence needed a manual SQL
query against a table that happens to be small.

`retrieval_log` (012) is one row per turn where retrieval ran: the query, whether
the model was shown anything, which channel found it, the top score, the floor
that score was tested against, and the embedding model. Written from `waitUntil`
in both chat routes, beside the lead notification and for the same reason — a
visitor's reply must never wait on bookkeeping — and through a `logRetrieval`
that cannot throw.

**Two decisions about what to log, and both are load-bearing.**

*Hits are logged too.* Misses alone give the report its rows but no denominator:
no miss rate, and no score distribution to tune a floor against. That is
precisely the blindness B1 hid inside for four months.

*Skipped turns are logged not at all.* A greeting recorded as `matched: false`
would inflate the miss rate with turns nobody expected an answer to, and a
`stale-index` turn recorded as a miss would report a drifted bot as a bot that
cannot answer. The decision lives in `retrievalLogRow` — pure, beside the
outcome it describes, and unit-tested there.

**The report.** `buildMissReport` in [stats.ts](../src/stats.ts) is a pure
function over rows the caller fetched, in the same shape as `buildStats` and in
the same file so it reuses `normalise()` — "What are your hours?" and "what are
your hours" group identically in the overview and here. It is served by
`GET /v1/admin/bots/:id/retrieval?days=30`, modelled on the stats route: same
day clamping, same `UserDb` so RLS scopes it, same row cap surfaced rather than
hidden.

**In the dashboard** it is a card at the top of the **Knowledge → Retrieval**
tab: *"Questions your bot could not answer"*, count and last-asked per row, and
an **Add as FAQ** action that switches to the FAQ tab with the question
prefilled and the cursor in the Answer field. That is the loop closed — seeing
the gap and fixing it are one action rather than two screens and a copy-paste.

**And it is more than a UI feature.** `scores.hitMedian` against `scores.floor`
is the same measurement the eval sweep makes, taken continuously against real
traffic instead of a fixture corpus. A median sitting just above the floor means
the threshold is doing the rejecting; a wide gap means the misses are genuinely
off-topic and no tuning will help.

**Retention.** The query is stored **verbatim** — a normalised or hashed one
cannot be read back, and a report of question *shapes* tells nobody what to
write next. `prune_retrieval_log(p_days)` runs from a daily cron at 90 days, and
clamps its argument into `[7, 365]` **inside the function body**: the Worker
holds a service-role key, and this is the one table where a wrong number deletes
tenant data outright. See [tenancy.md](tenancy.md#data-retention).

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

### M4 — Real hybrid retrieval — **BUILT, and off by default**

The tsvector column, the GIN index and `match_chunks_lexical` all existed.
Lexical ran only when vector returned *nothing*, and only over `priority > 0`
chunks — so it could rescue a curated FAQ and could never help a question whose
answer is a proper noun buried in a PDF, which is exactly the case keyword
search wins.

**It needed a migration, and this brief said it did not.**

> ~~Running both channels every turn and fusing with reciprocal rank fusion is,
> as the 011 brief predicted, a scoring change rather than a migration.~~

[`012_retrieval.sql:433`](../supabase/012_retrieval.sql) has `and c.priority >
0` hard-coded inside `match_chunks_lexical`. The gate that makes lexical a
*fallback* is precisely what has to become a parameter, and it lives in SQL. So
[`013`](../supabase/013_hybrid.sql) drops and recreates the function with
`p_min_priority smallint default 1` — the drop is not optional, because a
defaulted fourth parameter beside the existing three-argument function makes the
three-argument call ambiguous rather than overloaded.

**Fusion is by rank, never by score.** `match_chunks` returns a cosine and
`match_chunks_lexical` returns a `ts_rank_cd`; 012 already warns they are not on
the same scale, and any weighted sum would need a normalisation nobody has
measured. Reciprocal rank fusion — `score = Σ 1/(k + rank)` at the conventional
`k = 60` — only ever compares ranks, which is why it is right here specifically.
`fuseRRF` is pure and unit-tested directly.

**`RagConfig.retrieval_mode` is `'vector' | 'fallback' | 'hybrid'`, defaulting
to `'fallback'`**, so nobody's bot changes under them. `lexical_fallback` stays
as-is for `'fallback'` mode rather than being overloaded into a tri-state: one
setting that means three things depending on another setting is a knob nobody
can reason about.

**The risk, stated plainly, because it is why the eval negatives gate this.** In
hybrid, lexical runs on every turn against every chunk. Any query sharing half
its lexemes with any chunk returns something, so `rendered.length` is almost
never zero, so `missedRetrieval` is almost never true, and `fallback_message`
and `escalate_after_misses` die — **B1's exact failure, reached from the
opposite direction.** The overlap gate (`ov.hits * 2 >= tq.n`) is the only thing
standing between hybrid and that outcome, and it was tuned for a fallback
channel over curated FAQ chunks, not for a primary channel over an entire
corpus. It is now covered by
[ranking-test.sql](../scripts/rls/ranking-test.sql), one assertion either side
of the line.

So: **ship it off, enable it on one bot, read the miss report before making it a
recommendation.** A miss rate collapsing to near zero after enabling hybrid *is*
the symptom, and someone has to be watching for it. The Retrieval screen says so
in the tenant's own words when the mode is selected.

Two M1 surfaces moved with it. `retrieval_log.channel` gains `'hybrid'` — free
text, so no migration — and `buildMissReport` now pools **only** `channel ===
'vector'` into `hitMedian`. That was an allow-list change, not a cosmetic one:
the old test was `!== 'lexical'`, and under fusion the top result of a hybrid
turn may be the lexical one, whose `similarity` is a `ts_rank_cd`. It would have
gone straight into the median.

### M5 — Re-ranking — **BUILT, off by default**

`top_k` came straight off cosine similarity. A cross-encoder reads the query and
the passage *together* rather than comparing two independently-produced vectors,
which is the highest precision available per token.

**No migration.** `match_chunks` already over-fetches `top_k * 4 + 10`
internally, but re-ranks and truncates before returning — the candidates never
leave Postgres. The Worker gets them by asking for more: `matchCount: top_k * 4`
when re-rank is on, re-rank in the Worker, slice to `top_k`. Model is
`@cf/baai/bge-reranker-base` over the `AiBinding` already declared in
`types.ts` and already used by `storedFileToText`.

**It must fail open, and does.** The binding is a property of the *deployment*,
not of the tenant — a bot on OpenAI embeddings may be running somewhere with no
Workers AI binding at all. Absent binding, an unrecognised response shape, or a
call that throws all degrade to cosine order and log. This is a quality
improvement sitting on the visitor's hot path; it may never fail the turn.

**Interaction with the floor, which is the subtle part.** `min_similarity` is
applied inside `match_chunks` against cosine, so re-ranking happens *after* the
floor has already rejected. That ordering is correct and stays — but it means
the re-ranker can only reorder what survived, never rescue. Do not later "fix"
that by dropping the floor when re-rank is on: that is B1 for the third time.

`channel` stays the retrieval channel and `top_score` stays the retrieval score.
The re-rank changed the order, not the retrieval.

### M6 — Heading context in prose chunks — **BUILT**

`chunkQA` repeats the question into every piece of a split answer, and the
reasoning in its header is exactly right: a fragment without the question is a
fragment nothing will match. **Prose chunks got no equivalent.** Chunk 14 of a
pricing page was a bare paragraph with no indication it is about pricing.

**It could not start in `chunkText`, and this brief said it could.**

> ~~Prepending the document title and nearest preceding heading to each prose
> chunk is a small change to `chunkText`.~~

By the time `chunkText` runs there are no headings left to find. All three
extractors destroyed them, each differently:

| Source | Path | What happened to a heading |
|---|---|---|
| markdown | `markdownToText` | `#{1,6}` markers **stripped**, text kept as a bare line |
| url | `htmlToText` | `<h1-6>` was in `BLOCK_TAGS` → replaced with `\n`. Bare line. |
| file | `storedFileToText` | Workers AI `toMarkdown` output passed through **raw** — `#` markers survived |
| text | none | no headings existed |

So a heading arrived at the chunker as a short line indistinguishable from a
sentence — except for file sources, where it arrived as markdown by accident.
**M6 starts in [`extract.ts`](../src/rag/extract.ts)**, preserving headings in
one canonical form, ATX markdown, because one of the three sources already
produces it. `markdownToText` keeps the marker; `htmlToText` maps `<h1>`–`<h6>`
to `\n\n# `…`\n\n` at their own level *before* the generic tag strip, with
`h[1-6]` removed from `BLOCK_TAGS`.

Then `chunkText(input, { size, overlap, title })` splits on headings and emits
each prose chunk as `{title} › {nearest heading}\n\n{chunk text}`, with the
markers consumed rather than embedded. The prefix is dropped whole — never
truncated — when it would exceed a quarter of `size`, which is the same failure
`MIN_ANSWER_BUDGET` guards against in `chunkQA`, reached from the other
direction. `chunkQA` itself is untouched: it already carries its own header, and
a second prefix would spend the budget saying the same thing twice.

Three consequences worth stating rather than discovering:

- **The prefix is part of `chunks.content`**, so it appears in rendered
  excerpts, in the chunk inspector, and in the `search` tsvector — which *helps*
  the lexical channel, since a heading carries the words a visitor types.
- **It changes what gets embedded**, so it shifts the similarity distribution
  the measured floors were taken against. bge's 0.60 is now approximate until
  the sweep is re-run.
- **Existing corpora get no benefit until re-indexed.** No migration needed, but
  the miss report's `hitMedian` will drift as tenants re-index, and someone
  reading that graph deserves to know why.

A heading with no body of its own folds into the next section's trail
(`Pricing › Plans`) rather than being dropped, and a trailing heading with
nothing under it is kept as content — which is exactly what it was before
headings were markers at all.

### M7 — URL sources never refresh

A URL is fetched once at ingest and the extracted text is cached on the
document row forever. A tenant who indexes their pricing page and then changes
their prices has a bot confidently quoting last year's numbers, with a source
list citing the page that now contradicts it.

A Cron Trigger re-fetching URL sources on a schedule, comparing a content hash,
and re-indexing only on change would fix it. Needs a `last_fetched_at` and a
visible "checked 3 days ago" in Sources, because silent staleness is the
failure mode being fixed.

### M8 — Near-duplicate suppression — **FIXED**

Nothing deduped. The same boilerplate paragraph in three indexed pages returned
three near-identical excerpts that consumed three of five `top_k` slots and most
of `context_chars`.

**It is lexical, not cosine, and that is a constraint rather than a
preference — record it, or the next reader will "improve" it back into the
version that cannot run.** The Worker never receives a chunk's vector:
`MatchedChunk` carries `content`, `similarity`, `kind`, `priority` and
`document_title`, and nothing else. "Drop anything above ~0.95 cosine against a
chunk already kept" would need either 768 floats per candidate shipped over
PostgREST (~60 KB a turn) or the whole check moved into SQL.

The stated failure is *"the same boilerplate paragraph in three indexed
pages"* — **literal** duplication, which a Jaccard overlap over 5-token shingles
catches exactly, at zero cost and with no vectors. `dedupe` runs inside
`selectContext` *before* the budget loop, so a dropped duplicate frees its slot
**and** its characters for a chunk that says something new.

**The trap, and the test that exists for it.** `chunkText` prepends
`chunk_overlap` characters of the previous chunk into every chunk, so two
*adjacent* chunks of one document always share text and must **not** be
deduped — they are different content. At the shipped defaults the overlap lands
near 0.15, but that headroom is a fact about the defaults and both `chunk_size`
and `chunk_overlap` are tenant-configurable. The assertion is taken at the worst
combination the clamps allow (`size: 200`, `overlap: 100`) rather than at the
defaults, against a real `chunkText` run.

*(The first draft of that test used one sentence repeated, which makes adjacent
chunks genuine duplicates — dedupe was right to collapse them and the test was
wrong. The fixture is varied prose now. Worth knowing, because the same mistake
reads as a threshold bug.)*

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

  Phase 2 extended the same harness rather than starting another: the drift
  gate, the re-index claim, the retry schedule and the log-row decision are all
  in that file, and the claim and retry cases run through the **real**
  `ingestDocument` against a stubbed PostgREST — claim, retry, release and stamp
  have to happen in the right order relative to each other, and a stub of the
  middle proves nothing about the order. `buildMissReport` is pure and lives in
  [test-stats-units.mjs](../scripts/test-stats-units.mjs) with `buildStats`.
- ~~**No SQL-level test for ranking.**~~ **DONE.**
  [ranking-test.sql](../scripts/rls/ranking-test.sql), wired into
  `RAG_MIGRATIONS` beside `retrieval-test.sql`. `match_chunks`'s boost and
  `match_chunks_lexical`'s overlap gate had been verified by hand against the
  live database during 011 and were covered nowhere —
  [knowledge-test.sql](../scripts/rls/knowledge-test.sql) tests isolation, not
  ranking. It asserts that a boosted chunk with lower cosine outranks an
  unboosted one at boost 0.5 and does **not** at boost 0 or at the 0.05 default;
  that the floor tests **raw** similarity rather than the boosted score (012
  says so and nothing checked it); that the overlap gate rejects one lexeme in
  five and accepts four; that an apostrophe or a `&` a visitor typed is a
  literal rather than a tsquery syntax error; that `p_min_priority` is what
  separates fallback from hybrid and its default changes nothing; and that
  `bots.chunk_count` stays exact across a delete-then-insert cycle.

  It builds its **own** bot, document and chunks with hand-written embeddings,
  because ranking assertions need known distances between known vectors —
  reusing what the earlier files leave behind would make every number depend on
  what those files happen to insert. It removes the fixture afterwards.

- **A latent blocker found while wiring it up.** No RLS fixture had ever
  inserted an `embedding`, so `retrieval-test.sql`'s title-fold assertion —
  `if total = 0 then raise exception` — would have failed the first time anyone
  ran the RAG block on a Postgres with pgvector, taking `ranking-test.sql` down
  with it. Those eight assertions have still never executed, which is exactly
  how it survived. `rag-test.sql` now gives its chunks a uniform vector; the
  files that test isolation and shape do not care what it is, and
  `ranking-test.sql` builds its own where distance is the point.

---

## Suggested order

**~~First, and small:~~ DONE.** B1 with M2 to prove it, then B3, B6 and the
housekeeping. No migration was needed.

**~~Then, one migration:~~ DONE.** M1 with B2, B4 and B5, plus S1's first
mitigation and the S2 title fold riding
[012](../supabase/012_retrieval.sql) — everything that needed SQL, in one file,
deployed before the Worker because both RPCs widen their return type.

**Still a run rather than a build, and still outstanding — and it is now a gate,
not housekeeping:** `npm run eval:rag -- --vendor=google --sweep=...` for every
embedding vendor with a `defaultEmbedModel`, and commit the measured floors.

**Why it gates M4 specifically.** The eval harness's *negatives* — eight
off-topic queries that must return nothing — are the only automated test that
catches a retrieval change which quietly stops rejecting, and M4 is exactly such
a change. They must run green **before and after** enabling hybrid on anything;
if off-topic rejection drops, the overlap gate needs raising for hybrid mode
first. Everything else about M4 can be reviewed by reading. That cannot.

M6 is the other reason to re-run it: the heading prefix changes what gets
embedded, so it moves the similarity distribution the floors were measured
against. Until then every non-bge
vendor is on the unmeasured 0.30 — which is the value B1 was about, still in
place for anyone who switched away from the platform default. It needs
`wrangler login`, live Supabase and real embedding quota, and it creates then
deletes a tenant in the production project, which is why it has not happened as
a side effect of anything else.

**~~Then, quality:~~ DONE**, in that order and for that reason: M8 and M6 are
pure-function changes with offline tests, then M4 and M5, which change what
retrieval returns. M4 needed [`013`](../supabase/013_hybrid.sql) after all — see
its entry — and both it and M5 ship switched off.

**~~Before real scale:~~ DONE.** S1's `iterative_scan` and the `hasChunks` half
of S2 both rode 013. S1 remains documented as unverified; S2 got a counter
column rather than the row fold, which would have re-opened B1.

**Deferred deliberately:** M3 and M7 both cost recurring calls, and neither pays
off until the corpus is bigger and the conversations longer than they are today.
M7's Cron Trigger objection is now gone — 012 added one for retention — but the
argument that stands is the deliberately narrow scope of that handler: a "daily
maintenance" function accretes, and one failure takes down work unrelated to the
failure. A URL refresh gets its own schedule and its own handler, not another
line in that one.
