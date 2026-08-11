# ConverseKit — Platform Plan

Turning the single-tenant-ish chatbot into a multi-tenant conversational AI
platform with configurable RAG, pluggable AI vendors, and a real dashboard.

**Status:** Phase 0 (provider adapter) is done. Everything below it is planned.

---

## Locked decisions

These are settled unless something concrete changes. Re-litigating them costs
more than living with them.

| Decision | Pick | Why |
|---|---|---|
| Vector store | **pgvector in Supabase** | Postgres is already the tenant store. RLS gives cross-tenant isolation for free, metadata filtering is a plain `WHERE`, and chunks join to `bots` directly. Vectorize only wins once Postgres stops coping — revisit at ~1M chunks, not before. |
| Auth | **Supabase Auth** | Already in the stack. Issues JWTs the Worker can verify statelessly and that RLS understands natively. Building custom auth here buys nothing. |
| Vendor abstraction | **Narrow interface, config-driven catalog** | `generate` / `stream` / `embed`. Most vendors speak the OpenAI shape, so they are catalog rows, not code. Done — see Phase 0. |
| Streaming | **In from day one** | Retrofitting streaming through a synchronous stack is painful, and RAG makes prompts big enough that time-to-first-token becomes the UX. Done — see Phase 0. |
| Ingestion | **Cloudflare Workflows + R2** | Durable retries across fetch → parse → chunk → embed → upsert. Parsing a 200-page PDF inside a request-scoped Worker will hit CPU limits. |
| Dashboard | **React + Vite + shadcn/ui + Tailwind** | Copy-in components (no version lock), with TanStack Table and react-hook-form for the tables and forms that make up most of an admin UI. |
| API contract | **Version, never break** | `/v1/*` is embedded in customers' HTML. New capability goes to new routes. |

---

## Phase 0 — Provider adapter ✅ done

Any vendor, one interface. Chat, streaming chat, and embeddings.

```
src/providers/
├── types.ts           ChatProvider / EmbeddingProvider, StreamEvent, ProviderConfig
├── errors.ts          ProviderError + kind normalisation + HTTP mapping
├── sse.ts             shared SSE reader (handles split frames, CRLF, comments)
├── catalog.ts         vendor presets — the config-not-code layer
├── openai-compat.ts   OpenAI, Groq, OpenRouter, DeepSeek, Mistral, Together,
│                      Ollama, LM Studio, vLLM, llama.cpp, any custom endpoint
├── anthropic.ts       Messages API
├── google.ts          Gemini REST (no SDK — same reasoning as supabase.ts)
├── workers-ai.ts      Cloudflare AI binding
└── index.ts           resolveChatProvider / resolveEmbeddingProvider
```

**Resolution order:** tenant config (`bots.provider_config`) → Worker env
(`AI_VENDOR`, `AI_MODEL`, …) → vendor preset default.

**Also landed:** `POST /v1/chat/stream` (SSE), `GET /admin/providers` (catalog
for the dashboard picker), `src/lead-stream.ts` (holds back the `[[LEAD:` marker
so it can't flash on screen mid-stream), widget streaming with automatic
fallback to the buffered endpoint.

**Deliberately not done:** cross-vendor failover on `retryable` errors. The
plumbing exists (`ProviderError.retryable`) but no policy uses it yet — see
Phase 6.

---

## Phase 1 — Tenancy and auth ✅ code complete, migrations not yet applied

**Why first:** everything downstream needs an owner. Build RAG before this and
every document, chunk and embedding gets migrated to a new ownership model later.

The global `ADMIN_SECRET` — one shared secret that unlocks any bot by UUID — is
fundamentally incompatible with real tenancy and is the thing to remove.

1. **Schema** (`supabase/003_tenancy.sql`)
   - `organizations` — id, name, plan, created_at
   - `memberships` — user_id → org_id, role (`owner` | `admin` | `viewer`)
   - `bots.org_id` → organizations, backfilled and then `NOT NULL`
   - RLS on every tenant-scoped table, keyed off `auth.uid()` through memberships
2. **Worker auth** — verify the Supabase JWT, resolve org + role, drop
   `requireAdmin`. `/admin/*` becomes `/v1/admin/*` behind real auth.
3. **Provider config columns** (`supabase/004_provider_config.sql`) —
   `bots.provider_config jsonb`, `bots.embedding_config jsonb`. The Worker
   already reads these; they just don't exist in the DB yet.
4. **Tenant API keys** — encrypted at rest, never returned to the client
   (write-only field; the UI shows `sk-…last4`).

**Done when:** two orgs cannot see each other's bots, leads, or conversations —
proven by a test that authenticates as org A and queries org B's ids directly.
That test is `npm run verify:isolation`; it must pass against a real Supabase
project, since RLS policy behaviour is the thing under test and cannot be mocked.

**Deployment order matters** — `003_tenancy.sql` revokes the anon key's table
access, so the service-role Worker must be deployed first or the live widget
goes down. Full sequence in the migration header and the README.

**Deferred out of Phase 1, deliberately:**

- **Encryption at rest for BYOK keys.** They are redacted from every API
  response but still stored as plaintext JSONB. Fine while the operator is the
  only one with database access; not fine with staff.
- **A narrower chat identity.** `service_role` has `BYPASSRLS`, so a bug on the
  public chat path is unbounded. The upgrade is a Worker-signed JWT with a
  `chat_worker` Postgres role granted only `select` on bots and `insert` on
  conversations/leads — a change confined to `serviceDb()`. See Phase 5.

---

## Phase 2a — RAG ✅ code complete, 005 not yet applied

Shipped: `supabase/005_rag.sql` (documents, chunks, pgvector, `match_chunks`,
RLS), `src/rag/` (chunker, extractor, ingest, retrieve), retrieval wired into
both chat routes, document routes under `/v1/admin`, and a Knowledge Sources
tab with a chunk inspector.

**Embedding width is fixed at 768** platform-wide. Every vendor in the catalog
can produce it — Gemini and OpenAI by truncation, bge/nomic/mistral natively.
Choosing 1536 would have locked out every local model. Changing it later means
re-embedding every chunk, so `embedding_model` is recorded per document.

**Verified on the free stack.** Groq chat + Workers AI embeddings
(`@cf/baai/bge-base-en-v1.5`, 768) run the whole loop — ingest, retrieve,
answer — at no cost, and are now the platform defaults. This was also the first
real execution of the Workers AI adapter, which had only ever been exercised
against mocks.

**Sources: text, markdown, URL.** Retrieval failure is never fatal — a bot with
no corpus, or an embedding vendor having a bad minute, falls back to the plain
knowledge-base prompt rather than failing the visitor's turn.

## Phase 2b — deferred, as one unit

**PDF/DOCX + R2 + Cloudflare Workflows.** These belong together and none of them
earns its complexity without the others: Workflows exists to survive slow binary
parsing, and R2 exists to hold the binaries. With only text/markdown/URL
sources, ingestion completes in seconds inside `waitUntil`, and the document
`status` column plus the reindex endpoint already cover the failure that
actually happens — a vendor rate-limit part-way through a batch.

This is a deliberate deviation from the locked "Workflows + R2" decision above.
Revisit when PDF ingestion is actually wanted.

**Ready to build:** see [PHASE-2B.md](PHASE-2B.md) — a self-contained brief with
the architecture-deciding spike (`env.AI.toMarkdown()`), the work breakdown, the
constraints that must not break, and the landmines this project hit the hard way.

## Phase 2 — original scope (reference)

**Scope discipline:** ship *one* opinionated pipeline with a few knobs. Not a
pipeline builder. "Configurable RAG" expands without limit (rerankers, hybrid
search, graph RAG, eval harnesses) and none of it matters before the basic
retrieve-and-cite loop is good.

1. **Schema** (`supabase/005_rag.sql`)
   - `documents` — bot_id, source (`upload` | `url` | `text`), title, r2_key,
     status, error, token_count
   - `chunks` — document_id, bot_id (denormalised for the RLS predicate),
     ordinal, content, `embedding vector(N)`, metadata jsonb
   - HNSW index on `embedding`; RLS on both tables
   - Dimension `N` is fixed per deployment — changing embedding model means
     re-embedding, so store `embedding_model` on the document and refuse mixed
     dimensions in one bot.
2. **Ingestion Workflow** — fetch → parse → chunk → embed → upsert, each step
   retryable. Raw files in R2, text in Postgres.
   - Parsers: plain text and HTML first, then PDF. DOCX last.
   - Chunking: recursive character split, ~800 tokens, ~15% overlap.
3. **Retrieval** (`src/rag/retrieve.ts`) — embed the query, cosine top-k over
   the tenant's chunks, similarity floor, assemble into the prompt.
   - Tenant filter enforced by **RLS**, not by an application `.eq()`. See Risks.
4. **Prompt assembly** — `buildSystemPrompt` grows a retrieved-context section
   with source labels, plus a rule to cite or admit ignorance. Budget the
   context window: retrieved chunks compete with conversation history, so trim
   history before chunks.
5. **Per-tenant knobs:** `top_k`, `similarity_threshold`, `chunk_size`,
   `embedding_model`. That's the whole surface for now.

**Done when:** a PDF uploaded through the API answers a question it alone
contains, cites its source, and a second org asking the same question gets
nothing.

---

## Phase 3 — Dashboard rewrite ✅ shipped

React + Vite + TypeScript + Tailwind v4, with shadcn-style primitives owned in
`dashboard/src/components/ui` on Radix. Source in `dashboard/`, building into
`public/admin/` — one Pages deploy, because the same project also serves
`widget.js` and `test.html`.

Built in the order that mattered: **AI Providers and Retrieval first**, because
those exposed capability that existed since Phase 0 and Phase 2 but had no UI at
all. The five existing tabs were ported after.

Notable improvements over the vanilla version: responsive with a real mobile
drawer (the old one had zero media queries), hash routing so deep links work
without server rewrites, dark mode, keyboard-accessible Radix primitives, lead
CSV export, and conversation transcripts rendered as chat bubbles.

```
npm run dashboard        # vite dev server
npm run build:dashboard  # → public/admin/
npm run deploy:pages     # build + wrangler pages deploy
```

## Phase 3 — original scope (reference)

Scaffold this **during Phase 1**, not after — otherwise there's nothing to
demo for months. Vanilla `public/admin/` gets replaced, not migrated.

```
dashboard/          Vite + React + TypeScript, deployed to Pages
├── auth            Supabase Auth session, protected routes
├── bots            list, create, settings, knowledge base
├── providers       vendor picker driven by GET /admin/providers, BYOK entry,
│                   "test connection" button
├── knowledge       document upload, ingestion status, chunk inspector
├── conversations   transcript viewer, search
├── leads           table, filter, CSV export
└── analytics       volume, resolution rate, token spend per tenant
```

Order: auth shell → port the existing four screens → provider config →
knowledge base → analytics.

**The chunk inspector matters more than it sounds.** When a bot answers badly,
the first question is always "what did it retrieve?" Without that view, every
support conversation is guesswork.

---

## Phase 4 — Widget v2

- ✅ **Markdown rendering** — replies now render bold, italic, code, links and
  lists. Deliberately escape-first: reply text is model output that may have
  ingested attacker-controlled documents through RAG, so nothing it produces can
  become live HTML, and link protocols are allow-listed. Guarded by
  `npm run test:widget` (13 XSS cases).
- Per-tenant suggestion chips (currently hardcoded in `widget.js`)
- Conversation persistence across visits (`localStorage`, resumable thread)
- Streaming cursor, stop-generation button
- Bundle-size budget: it loads on customers' sites, so keep it under ~15KB gzipped

---

## Phase 5 — Operations

- **Usage metering** — token counts already flow back through `Usage` on every
  call and are currently discarded. Persist per-org and per-bot.
- **Rate limiting** — per-bot and per-session, at the edge
- **Retention policy** — conversations and leads are PII stored forever today.
  Per-org retention window + delete endpoint.
- **Alerting** — ingestion failures, provider error-rate spikes

---

## Phase 6 — Reliability (once traffic justifies it)

- Cross-vendor failover using `ProviderError.retryable` (e.g. Groq → OpenAI on
  429). Needs a per-tenant fallback chain in `provider_config`.
- Prompt caching for the system prompt, which is large and mostly static
- Semantic cache for repeated visitor questions

---

## Client-ready pass ✅ shipped

Four things that blocked onboarding anyone who was not a dental clinic on a
single-hostname site:

- **Per-tenant suggestion chips.** They were hardcoded and dental-specific, so
  every bot on the platform asked its visitors about insurance.
- **`allowed_origins` is a list** (`006`). Apex + www + staging. Validated in
  `src/origin.ts`, because a bad origin presents to the widget as an
  unexplained 403.
- **Playground** — `POST /v1/admin/bots/:id/preview`, auth-gated and ephemeral.
  There was previously no way to test a bot without owning the domain in its
  origin lock.
- **Rate limiting** on the public chat path. Not monetisation: every bot shares
  one Groq key and one Workers AI allocation, so an unthrottled endpoint let
  anyone with a bot UUID drain the free tier.

**Stranded users** (`007`). Deleting an org used to be unrecoverable: the signup
trigger fires only on INSERT, and RLS forbids creating an org without a
membership. `create_organization` (SECURITY DEFINER, owner derived from
`auth.uid()`) plus a NoOrg screen closes it.

---

## Operational lessons

**Never graft a test user into a real organization.** A cleanup that deleted
"this user's org" destroyed the live one, cascading away every bot, conversation
and lead, because earlier scripts had added throwaway users to it so they could
exercise a real bot. [scripts/lib/testenv.mjs](scripts/lib/testenv.mjs) now
gives each test its own user, org and bots, and tears down only ids it recorded.
The Playground removed the reason anyone would graft membership again.

**Migrations before the code that needs them.** A Worker writing
`allowed_origins` shipped before `006` existed and broke bot creation. The same
sequencing discipline that Phase 1 got right was skipped here because the change
looked small.

**Cleanups must match what they created, never traverse relationships.** Delete
by recorded id or by a name prefix you own — never by "whatever this row points
at".

---

## Risks

**Cross-tenant retrieval leakage — the one that actually bites.** A retrieval
query that forgets its tenant filter serves org A's documents to org B's
visitors, and you find out from a customer. Enforce at the database with RLS so
a missing application-level filter fails closed. Add a regression test that runs
retrieval as org A against org B's corpus and asserts zero rows.

**Embedding dimension lock-in.** The pgvector column is fixed-width. Switching
embedding model means re-embedding every chunk. Record `embedding_model` per
document from day one so a migration is at least *possible*.

**Scope creep in "configurable".** Every knob is a support surface and a test
matrix. Four knobs, defaults that work, no pipeline builder.

**Prompt injection via ingested documents.** Once the bot reads customer-supplied
content, that content can carry instructions. Keep retrieved text clearly
delimited and subordinate to the system prompt, and never let it override the
conversation rules.

**Cross-*visitor* transcript access — CLOSED.** `getSessionHistory` used to
filter on a client-supplied `session_id` the widget generated with
`Math.random()`, so guessing or replaying one returned another visitor's
conversation. Session ids are now minted and HMAC-signed by the server
([src/session.ts](src/session.ts)) and bound to a single bot. An unsigned id is
deliberately not an error — it loads no history and the caller is handed a
signed replacement, which closes the disclosure without breaking embedded
widgets or the documented curl flow. Guarded by `npm run test:session`.

**Sentinel values in security decisions.** Recorded because it already bit once:
an early version of the BYOK redaction sent `••••1234` back to the client and
treated that string on the way in as "unchanged". Any re-encoding of those
multi-byte characters silently destroyed the stored key. Absence, not a magic
string, is the signal — the same reasoning should apply to anything similar.

---

## Environment

Existing: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ADMIN_SECRET` (removed in Phase 1).

Added by Phase 0 — all optional, only needed for vendors actually used:

```
AI_VENDOR              default vendor id (falls back to 'google')
AI_MODEL               default model override
AI_BASE_URL            default endpoint override
AI_MAX_TOKENS
AI_TEMPERATURE
EMBEDDING_VENDOR       may differ from the chat vendor, and usually should
EMBEDDING_MODEL
EMBEDDING_BASE_URL
EMBEDDING_DIMENSIONS

OPENAI_API_KEY  ANTHROPIC_API_KEY  GEMINI_API_KEY  GROQ_API_KEY
OPENROUTER_API_KEY  DEEPSEEK_API_KEY  MISTRAL_API_KEY  TOGETHER_API_KEY
CUSTOM_API_KEY
```

Workers AI needs the `[ai]` binding in `wrangler.toml`, left **commented on
purpose**: the binding has no local simulator, so enabling it forces
`wrangler dev` into a remote proxy session and every local run then requires
`wrangler login`. Uncomment when you want that vendor.

Local models need no key: point `AI_VENDOR=ollama` (or `lmstudio`) at a running
server, or use `custom` with an explicit `AI_BASE_URL`.
