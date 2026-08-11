# Phase 2B — File ingestion (PDF / DOCX)

**A self-contained brief.** Everything a fresh session needs in order to build
this without re-deriving the project. `roadmap.md` has the wider roadmap and
`README.md` explains how the pieces fit; this file is only about the next chunk.

---

## STATUS — built, 2026-08-11

**§3's spike passed, so this phase took the short shape.** `env.AI.toMarkdown()`
converted a 75-page, 6.8 MB PDF in 908 ms and a real DOCX in 246 ms. No PDF
parser in the bundle, no `unpdf`, and **no Workflows** — the measured end-to-end
budget is ~11 s, almost all of it embedding, which fits `waitUntil` with room to
spare. Numbers and the three findings that shaped the code:
[scripts/spike/FINDINGS.md](../scripts/spike/FINDINGS.md).

Everything in §4 is written and tested:

| Item | Where |
|---|---|
| 1. Migration | `supabase/008_files.sql` + `scripts/rls/files-test.sql` |
| 2. R2 binding | `wrangler.toml` → `DOCS` |
| 3. Upload route | `POST /v1/admin/bots/:id/documents/upload` |
| 4. Parse step | `src/rag/files.ts`, dispatched from `ingest.ts` |
| 5. Dashboard | drop zone in `dashboard/src/screens/Sources.tsx` |
| 6. Workflow | **not built** — §3 concluded it is not warranted |

Verified: 141 unit assertions (was 97); the real converter's output run through
the real extraction code for four documents including the IRS XFA form; the
upload route exercised against `wrangler dev` with R2 simulated locally and the
AI binding remote; `008_files.sql` applied, re-applied and behaviour-tested
against a throwaway Postgres.

**Shipped.** R2 was enabled, `008` applied, and both the Worker and Pages are
deployed. `verify:isolation` against the live stack is fully green, file block
included: a PDF uploads, converts, chunks, embeds and comes back out of
retrieval, a textless one fails with an explanation, and neither tenant can see
the other's objects.

One bug survived every offline test and was caught only by that live run: the
empty-extraction guard rejected a genuinely short document with "No readable
text could be extracted", which was false — text had been read, there was just
very little of it. It is now two tiers, an empty case and a too-short case, each
with a sentence that is true. The isolation fixture was also a one-word PDF,
which is indistinguishable from a failed extraction; it is now a realistic
document.

**Migrations are no longer applied by hand** — `npm run db:migrate`, see the
README. Run `npm run db:baseline` once first, since `001`–`008` were applied
through the SQL Editor and the runner has no record of them.

---

## 1. Where the project stands

ConverseKit is a multi-tenant embeddable AI chat widget. One Cloudflare Worker
(the API) plus one Pages site (widget, demo, React dashboard) plus Supabase
Postgres serve many client bots.

**Shipped and deployed:** pluggable AI vendors with streaming and embeddings
(`src/providers/`), tenancy enforced by Postgres RLS, Supabase Auth, RAG over
text/markdown/URL sources, a React dashboard, HMAC-signed visitor sessions,
widget markdown rendering, multi-origin locks, a Playground, and rate limiting.

**Migrations 001–007 are all applied** to the live project.

**The free stack is the default:** Groq (`llama-3.3-70b-versatile`) for chat,
Workers AI (`@cf/baai/bge-base-en-v1.5`) for embeddings — both set in
`wrangler.toml` under `[vars]`. A Gemini key still exists but its free tier is
exhausted and nothing uses it.

---

## 2. What Phase 2B is

Ingesting **uploaded files** — PDF first, DOCX second — as knowledge sources.
Today `documents.source` accepts only `text`, `url` and `markdown`
(`supabase/005_rag.sql`), and the dashboard's Add Source card says so plainly.

It pulls in two pieces of infrastructure, which is why all three were deferred as
one unit:

- **R2** — a binary needs somewhere to live between upload and parse, and needs
  to stay readable so a document can be re-chunked without re-uploading.
- **Cloudflare Workflows** — durable, retryable, multi-step execution that
  outlives the request, for parsing that is slow and unpredictable.

Neither earns its complexity for text sources, where ingestion finishes in
seconds inside `waitUntil`, and where `documents.status` plus the reindex
endpoint already cover the failure that actually happens: a vendor rate-limit
part-way through a batch.

---

## 3. Do this first — verify `env.AI.toMarkdown()`

**The shape of this entire phase depends on one unknown.** Getting text out of a
PDF inside a Workers runtime is the hard part: no filesystem, no native
bindings, a CPU budget.

Workers AI exposes markdown conversion (`env.AI.toMarkdown()`) that accepts
PDF/DOCX/XLSX and returns markdown. **If it works within acceptable size limits,
Phase 2B collapses dramatically:**

```
upload → R2 → env.AI.toMarkdown() → the existing chunk/embed pipeline
```

No PDF parser in the bundle at all, and markdown is a format
`src/rag/extract.ts` already handles through `markdownToText()`.

The `[ai]` binding is **already enabled** in `wrangler.toml`, and Workers AI is
already proven in production (it serves embeddings today), so this is a short
spike: call it with a real PDF and record output quality, size ceiling and cost.

**If it does not work**, the fallback is `unpdf` — a serverless-targeted PDF.js
build. Heavier, and it puts a parser in the Worker bundle. Do not reach for
`pdf-parse` or raw `pdfjs-dist`; both fight the runtime.

**Only after that spike** decide whether Workflows is still warranted. If
`toMarkdown` is a single binding call, the long pole becomes embedding — a
50-page PDF is perhaps 200 chunks, roughly 7 batched calls, tens of seconds.
That fits `waitUntil`. Workflows still buys per-step retries and survival across
eviction, but it is a new binding and harder to test locally. **Measure a real
PDF end to end before committing to it.**

---

## 4. Work breakdown

1. **`supabase/008_files.sql`**
   - extend the `documents.source` check constraint with `'file'`
   - add `r2_key text`, `mime_type text`, `size_bytes integer`
   - a per-org storage cap, so one tenant cannot fill the bucket

2. **R2 bucket + binding** in `wrangler.toml`.

3. **Upload route** — multipart to the Worker for small files, or a presigned PUT
   straight to R2 for large ones. Enforce a size ceiling and a MIME allow-list,
   rejecting anything else with a specific message, the way `src/origin.ts` does
   for origins.

4. **Parse step** — `toMarkdown` if the spike passes, `unpdf` otherwise. Feed the
   result into the existing `chunkText` → embed → `replaceChunks` path in
   `src/rag/ingest.ts`. That pipeline should not need to change.

5. **Dashboard** — a file drop zone in the Add Source card
   (`dashboard/src/screens/Sources.tsx`), which currently states PDF is
   unsupported. Show upload progress separately from indexing status.

6. **Workflow** — only if §3 concluded you need it.

Realistically a week; less if `toMarkdown` works.

---

## 5. Constraints you must not break

**Embeddings are 768-dimensional platform-wide.** `chunks.embedding` is
`vector(768)`, a fixed-width column and a one-way door. `src/rag/ingest.ts`
throws a deliberate, explanatory error on a mismatch rather than letting Postgres
emit an opaque one. Changing this means re-embedding every chunk.

**Two database identities, separated at the type level** (`src/supabase.ts`).
`ServiceDb` bypasses RLS and is for the anonymous chat path only. `UserDb`
forwards the end user's JWT so RLS decides what they see. Every query function is
typed to exactly one of them, so mixing them is a compile error. **Ingestion runs
as `ServiceDb`** because chunks are derived data no tenant may write, while the
document row is created as `UserDb` so RLS validates org membership. Preserve
that split.

**`/v1/*` is embedded in customers' HTML.** Never break it — new capability goes
to new routes.

**Retrieval must never fail a turn.** No corpus, or an embedding vendor having a
bad minute, degrades to the plain knowledge-base prompt rather than a 502.

**Ingested text is untrusted.** `src/rag/retrieve.ts` frames retrieved passages
as data and instructs the model to ignore any directives inside them. A PDF is a
far more likely injection vector than pasted text — do not weaken that framing.

---

## 6. Landmines learned the hard way

These cost real time or real data on this project. None are hypothetical.

**Apply the migration before deploying code that needs it.** A Worker writing
`allowed_origins` shipped before `006` existed and broke bot creation in
production. Sequence is migration → deploy → verify.

**Never grant a test user membership in a real organization.** Doing exactly
that, and then running a cleanup that deleted "this user's org", destroyed the
live org and cascaded away every bot, conversation, lead and document. Use
`scripts/lib/testenv.mjs`, which gives each test its own user, org and bots and
tears down only ids it recorded. To exercise a *real* bot, use the dashboard
Playground or `POST /v1/admin/bots/:id/preview` — never graft membership.

**Cleanups match what they created.** Delete by recorded id, or by a name prefix
you own. Never traverse a relationship outward to find what to delete.

**Cloudflare Pages has roughly 20 seconds of edge-cache lag after a deploy.** A
stale page, or a 404 on a freshly built asset, is propagation rather than a
failed deploy. Re-check with a cache-buster before debugging.

**`Prefer: return=minimal` returns 201 with an empty body on POST** (204 on
PATCH and DELETE). `pgFetch` keys on whether a body exists rather than on the
status code — an earlier version threw on every minimal insert. Do not
"simplify" that back.

**Writing files through Python or shell string replacement mangles `\n` inside
JS string literals.** This happened repeatedly. Write whole files with a quoted
heredoc or a file tool instead of patching string literals.

**`tsc -b` run from the wrong working directory emits `.js` next to the `.ts`
sources.** The root tsconfig now sets `noEmit: true` and `.gitignore` covers
`src/**/*.js`, but take care with `npm --prefix … exec tsc`.

**The `[ai]` binding has no local simulator.** `wrangler dev` runs a remote proxy
session and requires `wrangler login`. That is the accepted cost of using Workers
AI for embeddings.

**Supabase free tier has no point-in-time recovery.** There is no undo.

---

## 7. How to verify your work

```bash
npm test                 # 97 assertions — widget markdown, sessions, RAG units
npm run verify:rls       # 25 assertions — local Postgres, no network
npm run verify:isolation # 53 assertions — end to end against the live stack
npm run type-check
```

`verify:rls` needs `psql` and a Postgres you can create databases on. It skips
`005_rag.sql` when pgvector is absent locally **and says so loudly** — never read
a green run as covering the RAG schema.

`verify:isolation` writes to the real database and cleans up after itself. Add
file-ingestion assertions there, alongside the existing RAG block.

Put unit tests for any new parsing in `scripts/test-rag-units.mjs`, which
transpiles the pure modules with esbuild and needs no network.

---

## 8. Environment facts

- Secrets live in `.dev.vars` (gitignored) and as Worker secrets: `SUPABASE_URL`,
  `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GROQ_API_KEY`, and an unused
  `GEMINI_API_KEY`.
- Supabase uses the **new API key format** (`sb_publishable_…` / `sb_secret_…`).
  The legacy `eyJ…` keys were disabled when JWT signing keys were enabled. User
  JWTs are **ES256 via JWKS**, so no `SUPABASE_JWT_SECRET` is needed.
- The dashboard lives in `dashboard/` (Vite + React + Tailwind) and **builds into**
  `public/admin/`. Edit the source, never the build output. `npm run deploy:pages`
  builds and deploys in one step so the two cannot drift.
- `public/` also carries `widget.js` and `test.html`, which is why there is a
  single Pages deploy rather than two.
- Live: Worker at `conversekit.mukeremshifa.workers.dev`, Pages at
  `conversekit-widget.pages.dev`.

---

## 9. Suggested first session

1. Spike `env.AI.toMarkdown()` against a real PDF. Record output quality, size
   ceiling and cost. **This decides the architecture** — do not write the upload
   route first.
2. Decide Workflows vs `waitUntil` from a measured end-to-end time.
3. Write `008_files.sql`, apply it, *then* deploy the code that uses it.
4. Build upload → parse → the existing pipeline.
5. Dashboard drop zone last, once a script has proven the backend.
