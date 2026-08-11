# ConverseKit — Embeddable AI Chatbot for Any Website

A drop-in AI chat widget that answers visitor questions from a business's own
knowledge base and captures leads — installable on any site with a single
`<script>` tag.

**Stack:** Cloudflare Workers · Hono · Cloudflare Pages · Supabase (Postgres) ·
pluggable AI vendors (OpenAI, Anthropic, Gemini, Groq, OpenRouter, Mistral,
DeepSeek, Together, Workers AI, Ollama, LM Studio, or any OpenAI-compatible endpoint)

> Building this out into a full platform — see [PLAN.md](PLAN.md).

---

## What it is

ConverseKit is **multi-tenant**. One Worker (the API) and one Pages site (the
widget + admin dashboard) serve an unlimited number of client bots. Each bot is
a single row in the Supabase `bots` table, identified by its `botId`, with its
own:

- **Branding** — name, primary color
- **Knowledge base** — business description, services, FAQ, hours, contact, custom instructions
- **Origin lock** — the widget only answers requests from the bot's configured `allowed_origin`
- **Lead capture** — the model collects name/email/phone during the chat and stores it

Onboarding a new client is just inserting a row and handing them a script tag —
no redeploy required.

---

## Live URLs

| What | URL |
|------|-----|
| API Worker | https://conversekit.mukeremshifa.workers.dev |
| Widget script | https://conversekit-widget.pages.dev/widget.js |
| Demo page | https://conversekit-widget.pages.dev/test.html |
| Admin dashboard | https://conversekit-widget.pages.dev/admin/ |

---

## Architecture

```
                 ┌─────────────────────────────┐
                 │   Client's website           │
                 │   <script src=".../widget.js"│
                 │           data-bot-id="…">    │
                 └──────────────┬──────────────┘
                                │  POST /v1/chat
                                ▼
   Cloudflare Pages       Cloudflare Worker (Hono API)        External
 ┌──────────────────┐    ┌───────────────────────────┐    ┌──────────────┐
 │ widget.js        │    │  GET  /                    │    │  Supabase    │
 │ test.html (demo) │    │  GET  /v1/bots/:id/health  │──▶ │  bots        │
 │ admin/ dashboard │──▶ │  POST /v1/chat             │    │  conversations│
 └──────────────────┘    │  POST /v1/chat/stream      │    │  leads       │
        admin UI         │  /v1/admin/*               │    └──────────────┘
      Bearer <jwt>       └─────────────┬──────────────┘
                                       │  resolveChatProvider(bot)
                                       ▼
                          ┌────────────────────────────┐
                          │  src/providers — adapter    │
                          ├────────────────────────────┤
                          │ OpenAI · Anthropic · Gemini │
                          │ Groq · OpenRouter · Mistral │
                          │ DeepSeek · Together         │
                          │ Workers AI                  │
                          │ Ollama · LM Studio · custom │
                          └────────────────────────────┘
```

- **Visitor flow:** `widget.js` (served from Pages) → `POST /v1/chat/stream` on the Worker →
  Worker loads the bot + session history from Supabase, resolves the bot's configured AI
  vendor, streams the reply back token by token, saves the conversation (and any captured
  lead). Falls back to the buffered `POST /v1/chat` if streaming is unavailable.
- **Admin flow:** the dashboard (served from Pages) calls `/v1/admin/*` on the Worker with the
  signed-in user's Supabase JWT, which is forwarded to PostgREST so RLS decides what they see.

---

## Repo layout

```
conversekit/
├── dashboard/            # Admin dashboard — React + Vite + Tailwind
│   └── src/              # builds into public/admin/
├── src/                  # Cloudflare Worker (the API)
│   ├── index.ts          # Hono app — all routes (chat + admin)
│   ├── providers/        # AI vendor adapters — see "AI vendors" below
│   ├── supabase.ts       # Supabase REST helpers (raw fetch, no SDK)
│   ├── prompt.ts         # System-prompt builder from a bot's knowledge base
│   ├── leads.ts          # Extracts the [[LEAD:{…}]] marker from replies
│   ├── lead-stream.ts    # Holds that marker back while streaming
│   └── types.ts          # Shared TypeScript types (Env, Bot, Lead, …)
├── public/               # Frontend — deployed to Cloudflare Pages
│   ├── widget.js         # The embeddable chat widget
│   ├── test.html         # Demo site (Pearl Dental) with the widget installed
│   └── admin/            # Dashboard build output (generated — edit dashboard/)
├── supabase/             # Migrations, applied in numeric order
│   ├── 001_init.sql      # bots, conversations + demo seed
│   ├── 002_phase1.sql    # Knowledge-base columns + leads table
│   ├── 003_tenancy.sql   # Orgs, memberships, RLS
│   ├── 004_provider_config.sql
│   ├── 005_rag.sql       # documents, chunks, pgvector
│   ├── 006_client_ready.sql   # allowed_origins[], suggestions[]
│   └── 007_org_recovery.sql   # create_organization RPC
├── wrangler.toml         # Worker config
├── PLAN.md               # Platform roadmap + locked architecture decisions
├── tsconfig.json
└── package.json
```

---

## AI vendors

Every vendor is normalised onto one interface — `generate`, `stream`, `embed` —
so swapping providers is configuration, not code. Most vendors speak the OpenAI
chat-completions shape and are therefore catalog entries rather than adapters;
only Anthropic, Google and Workers AI need their own translation.

Selection resolves most-specific-first:

1. the bot's own `provider_config` (per tenant, supports BYOK)
2. Worker env — `AI_VENDOR`, `AI_MODEL`, `AI_BASE_URL`, …
3. the vendor preset in [`src/providers/catalog.ts`](src/providers/catalog.ts)

| Vendor id | Notes |
|---|---|
| `openai` `anthropic` `google` | The majors |
| `groq` `openrouter` `mistral` | Have usable free tiers |
| `deepseek` `together` | Cheap hosted |
| `workers-ai` | No key needed; requires the `[ai]` binding |
| `ollama` `lmstudio` | Local, no key |
| `custom` | Any OpenAI-compatible server — vLLM, llama.cpp, LiteLLM |

Embeddings resolve separately from chat (`EMBEDDING_VENDOR`), because a tenant
will often want a strong hosted chat model alongside cheap local embeddings —
and re-embedding a corpus just to follow a chat-model change is pointless.
Anthropic has no embeddings API and fails with a clear error if selected.

### Running for free

Platform defaults in [wrangler.toml](wrangler.toml) are **Groq for chat**
(`llama-3.3-70b-versatile`) and **Workers AI for embeddings**
(`@cf/baai/bge-base-en-v1.5`). Both have free tiers, so a bot with no
`provider_config` costs nothing to run, RAG included.

The constraint that decides the embedding half: the pgvector column is
`vector(768)`, and only Workers AI, Ollama and LM Studio produce 768 dimensions
for free. Mistral's are 1024 and will be rejected at ingest — the Providers
screen warns before you can pick it. Ollama is free and unlimited but the
deployed Worker cannot reach `localhost`, so it is a local-development option
only.

---

## Tenancy and auth

Every bot belongs to an **organization**; every user belongs to organizations
through **memberships** carrying a role (`owner` / `admin` / `viewer`). Signing
up creates your organization automatically, via a Postgres trigger.

Isolation is enforced by **Row Level Security in Postgres**, not by application
code. The Worker uses two distinct identities, and they are separated at the type
level — `getLeads(serviceDb(env), …)` is a compile error:

| Path | Caller | Identity | Enforced by |
|---|---|---|---|
| `/v1/chat`, `/v1/chat/stream`, `/v1/bots/:id/health` | anonymous visitor | `service_role` (bypasses RLS) | origin lock + `botId` |
| `/v1/admin/*` | signed-in user | that user's JWT, forwarded to PostgREST | RLS policies |

A bot in another org returns `404`, not `403` — RLS returns no rows, which is
genuinely indistinguishable from absent and avoids confirming the id exists.

---

## Knowledge sources (RAG)

Beyond the free-text knowledge-base fields, a bot can be given **documents** —
an uploaded PDF or Word file, pasted text, markdown, or a fetched web page. Each
is chunked, embedded, and searched by cosine similarity at chat time; the top
matches are injected into the system prompt as clearly-labelled reference
material.

| Piece | Where |
|---|---|
| Schema, `match_chunks`, RLS | [supabase/005_rag.sql](supabase/005_rag.sql) |
| File sources, storage cap | [supabase/008_files.sql](supabase/008_files.sql) |
| Chunker, extractor, ingest, retrieve | [src/rag/](src/rag/) |
| Upload, conversion, type sniffing | [src/rag/files.ts](src/rag/files.ts) |
| Dashboard | Knowledge Sources tab, with a chunk inspector |

Per-bot settings live in `bots.rag_config`:

```json
{ "enabled": true, "top_k": 5, "min_similarity": 0.3,
  "chunk_size": 800, "chunk_overlap": 120 }
```

Three things worth knowing:

- **Embeddings are 768-dimensional, everywhere.** The pgvector column is fixed
  width, so this is a one-way door per deployment. 768 was chosen because every
  vendor in the catalog can produce it; 1536 would have excluded local models.
- **Retrieval never fails a turn.** No corpus, or an embedding vendor being
  down, degrades to the plain prompt rather than a 502.
- **Retrieved text is framed as data, not instructions.** Ingested pages are
  attacker-controlled in the general case, so the prompt explicitly tells the
  model to ignore any directives inside them.

**File uploads** go through `POST /v1/admin/bots/:id/documents/upload` as
multipart, are stored in the `DOCS` R2 bucket, and are converted by Workers AI's
`toMarkdown()` — so there is no PDF parser in the Worker bundle. `.pdf` and
`.docx`, 10 MB per file, 100 MB per organization. Two things that are easy to
get wrong and are guarded in [src/rag/files.ts](src/rag/files.ts):

- **The converter validates nothing.** Handed a `.zip` it returns the bytes back
  as "markdown". The upload route is the only gate, so it checks the extension,
  the declared content type and the file's actual leading bytes, and rejects any
  disagreement between them.
- **A PDF can convert successfully and contain no text.** Scanned pages and
  fillable forms yield metadata only. Those are failed with an explanation
  rather than indexed, which would otherwise put XMP uuids in the corpus.

Requires R2 enabled on the account and the bucket created:
`wrangler r2 bucket create conversekit-documents`. Without the binding the
upload route answers `501` and every other source type keeps working.
Measurements behind these choices: [scripts/spike/FINDINGS.md](scripts/spike/FINDINGS.md).

---

Three tests guard the platform:

```bash
npm run test:rag           # chunker, extractor and SSRF guard — pure, no network
```

```bash
npm run verify:rls         # local, no network — applies every migration to a
                           # throwaway Postgres and asserts the policies isolate
npm run verify:isolation    # end-to-end against a real Supabase project + Worker
```

Run `verify:rls` after touching any policy; it is the fast inner loop and needs
nothing but `psql`.

**`verify:rls` skips `005_rag.sql` and `008_files.sql` where pgvector is not
installed, and says so loudly.** A stock Postgres does not ship the extension.
Those two are covered by `verify:isolation`, which runs against the real project
where it exists. Never read a green `verify:rls` as having covered the RAG or
file schema — check the output for the skip.

---

## Database migrations

`supabase/*.sql` is applied in numeric order by a runner, not by hand:

```bash
npm run db:status      # what is applied, what is pending
npm run db:migrate     # apply everything pending
npm run db:migrate -- --dry-run
npm run db:baseline    # record existing files as applied WITHOUT running them
```

Add **one** credential to `.dev.vars`; the project ref is read from
`SUPABASE_URL`, so nothing else needs configuring:

| Variable | Where it comes from |
|---|---|
| `SUPABASE_ACCESS_TOKEN=sbp_…` | [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) — preferred: revocable, and never needs the database password |
| `SUPABASE_DB_URL=postgresql://…` | Project Settings → Database → Connection string. Runs through `psql` |

On a database that was migrated by hand — which is every ConverseKit project up
to and including `008` — run `npm run db:baseline` once. That records the
existing files as applied without re-running them, so the first real `db:migrate`
only touches what is genuinely new.

Three behaviours worth knowing, each verified against a throwaway Postgres:

- **A migration that fails is not recorded**, and `--single-transaction` means it
  leaves the schema exactly as it was rather than half-applied. Fix it and run
  again; every migration in this repo is written to be safely re-runnable.
- **Editing a migration that already ran is refused.** Postgres has the old
  version, so the difference belongs in a new file rather than in edited history.
- **The target is printed from the transport in use**, never from whichever
  config happens to be set — printing a production project ref above a local
  migration is how someone talks themselves into believing the wrong thing.

The sequence is still **migration → deploy → verify**, for the reason recorded in
[PHASE-2B.md](PHASE-2B.md) §6: a Worker once shipped ahead of its schema and
broke bot creation in production.

---

## Secrets

| Name | Purpose |
|------|---------|
| `SUPABASE_URL` | Your Supabase project URL, e.g. `https://xxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase anon key. Browser-safe once RLS is on. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Bypasses RLS.** Public chat path only — never send it to a browser. |
| `SUPABASE_JWT_SECRET` | Optional. Only for projects still signing JWTs with a legacy HS256 secret; omit to verify via JWKS. |
| `<VENDOR>_API_KEY` | e.g. `GEMINI_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY` |

Optional tuning: `AI_VENDOR`, `AI_MODEL`, `AI_BASE_URL`, `AI_MAX_TOKENS`,
`AI_TEMPERATURE`, and the `EMBEDDING_*` equivalents. Full list in [PLAN.md](PLAN.md).

**Local** — put them in `.dev.vars` (git-ignored):

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
GEMINI_API_KEY=...
```

**Production** — set them as Worker secrets:

```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY          # publishable key
wrangler secret put SUPABASE_SERVICE_ROLE_KEY  # secret key
wrangler secret put GEMINI_API_KEY
```

> **Both Supabase keys are load-bearing, in different places.** The chat path
> uses the service key; the admin path sends the publishable key as `apikey`
> alongside the user's JWT. Rotating only one leaves half the API broken —
> and the half that breaks (admin) is not the half you notice first.

If you migrate the project to **JWT signing keys**, Supabase also disables the
legacy `eyJ…` API keys. Swap both values for the new `sb_publishable_…` /
`sb_secret_…` pair, update [public/admin/admin.js](public/admin/admin.js), and
redeploy the Worker *and* Pages. No code changes are required.

---

## First-run setup

1. Run the migrations in order in the Supabase SQL Editor: `001_init.sql`,
   `002_phase1.sql`, `004_provider_config.sql`, then `003_tenancy.sql`.
   **Read the header of `003` first** — it revokes the anon key's table access,
   so the Worker must already be deployed with `SUPABASE_SERVICE_ROLE_KEY`.
2. Fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY` at the top of
   [public/admin/admin.js](public/admin/admin.js). Both are browser-safe once
   `003` has run — the anon key can then only reach `/auth/v1/*`.
3. Open the dashboard and **Create an account**. A trigger gives you an
   organization and an `owner` membership.
4. Claim any bots that existed before tenancy — `003` parks them in an
   `unclaimed` holding org. Run the snippet at the bottom of `003_tenancy.sql`
   with your email, then confirm it reports zero stranded bots.

Do not commit a filled-in copy of that claim snippet.

---

## Local development

```bash
# 1. Install dependencies
npm install

# 2. Run the migrations (Supabase SQL Editor), in order:
#    supabase/001_init.sql   then   supabase/002_phase1.sql
#    001 seeds a "Demo Clinic Bot" — copy its UUID from the bots table.

# 3. Add your secrets to .dev.vars (see above)

# 4. Start the Worker locally
npm run dev          # Wrangler at http://localhost:8787

# Type-check anytime
npm run type-check
```

The widget and admin dashboard in `public/` are static files — open
`public/test.html` directly, or serve `public/` with any static server, to test
against your local or deployed Worker (set the API base in `widget.js` /
`admin/admin.js`).

---

## API reference

### `GET /`
Liveness check → `{ "status": "ok", "service": "conversekit api" }`

### `GET /v1/bots/:id/health`
Public. Returns the bot's display config (name, business name, contact, primary
color). Used by the widget to theme itself. `404` if the bot doesn't exist.

### `POST /v1/chat`
Public. Sends a visitor message and returns the assistant reply.

```json
{
  "botId": "<uuid>",
  "message": "What are your opening hours?",
  "sessionId": "session-abc-123"
}
```

```json
{ "reply": "We're open Monday to Friday, 8 AM to 6 PM.", "sessionId": "session-abc-123" }
```

- **`sessionId` is optional and server-issued.** Omit it on the first call; the
  response carries one, and sending it back keeps multi-turn context. Ids are
  HMAC-signed and bound to a bot — an unsigned or forged one is not rejected,
  it simply starts a fresh conversation with no history. That is what stops a
  visitor reading another visitor's transcript by guessing an id.
- **Origin lock:** if the request carries an `Origin` header that doesn't match
  the bot's `allowed_origin`, the Worker responds `403`. Requests with no
  `Origin` (e.g. curl, server-to-server) are allowed for testing.

### `POST /v1/chat/stream`
Public. Same request body as `/v1/chat`, streamed back as Server-Sent Events.
The widget uses this and falls back to `/v1/chat` on any transport failure.

| Event | Payload |
|-------|---------|
| `delta` | `{ "text": "…" }` — incremental, lead marker already stripped |
| `done`  | `{ "sessionId": "…", "usage": { "inputTokens": n, "outputTokens": n } }` |
| `error` | `{ "error": "AI service error", "kind": "rate_limit" }` |

Validation, origin lock and bot lookup all run **before** the stream opens, so
those failures still arrive as normal JSON status codes rather than mid-stream.

### Admin routes
All require `Authorization: Bearer <supabase access token>`; otherwise `401`.
Rows are filtered by RLS, so these only ever return the caller's own orgs.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/v1/admin/me` | Current user + organizations + role |
| `GET` | `/v1/admin/providers` | Vendor catalog + which keys this deployment holds |
| `GET` | `/v1/admin/bots` | List every bot the caller can see |
| `POST` | `/v1/admin/bots` | Create a bot (`201`) |
| `GET` | `/v1/admin/bots/:id` | Fetch a bot. BYOK keys are redacted. |
| `PUT` | `/v1/admin/bots/:id` | Update settings / knowledge base / provider config |
| `DELETE` | `/v1/admin/bots/:id` | Delete a bot (`204`) |
| `GET` | `/v1/admin/bots/:id/leads` | List captured leads |
| `GET` | `/v1/admin/bots/:id/conversations` | List recent conversation messages |

The old `/admin/*` routes return `410 Gone`.

**BYOK keys are never returned.** `provider_config.apiKey` is stripped from every
response and replaced with `hasApiKey` + `apiKeyLast4`. On update, an absent
`apiKey` means "keep the stored one" — so saving settings cannot wipe a key.

---

## Lead capture

When a visitor expresses intent to book or be contacted, the system prompt
instructs the model to collect their details and append a hidden marker to the
end of its reply:

```
[[LEAD:{"name":"…","email":"…","phone":"…","inquiry":"…"}]]
```

[`src/leads.ts`](src/leads.ts) strips this marker from the visible reply (the
visitor never sees it) and, if it contains at least a name and a valid email,
saves a row to the `leads` table. Leads show up in the admin dashboard's **Leads**
tab.

---

## Deployment

### Worker (API)
```bash
# Set secrets once (see Secrets section), then:
npm run deploy        # wrangler deploy
```

### Dashboard

React + Vite + Tailwind, shadcn-style components owned in
[dashboard/src/components/ui](dashboard/src/components/ui). It builds **into**
`public/admin/`, so one Pages deploy ships the dashboard, the widget and the
demo page together.

```bash
npm run dashboard        # dev server against the live API
npm run build:dashboard  # → public/admin/
npm run deploy:pages     # build, then deploy public/ to Pages
```

`public/admin/` is generated — edit `dashboard/src/`, never the build output.

### Frontend (`public/`)
The widget, demo, and admin dashboard are deployed to **Cloudflare Pages**
(`conversekit-widget.pages.dev`). Deploy the `public/` directory:

```bash
wrangler pages deploy public
```

> The Worker serves **only** the API — it does not serve static files. Any change
> to `widget.js`, the demo, or the admin dashboard requires redeploying `public/`
> to Pages.

---

## Onboarding a new client (the workflow)

1. **Create the bot.** In Supabase, insert a new row into `bots` (or clone the
   demo row). Set `allowed_origin` to the client's exact site URL — no trailing
   slash, e.g. `https://acmedental.com`.
2. **Fill the knowledge base.** Open the admin dashboard, sign in with the bot's
   UUID + `ADMIN_SECRET`, and fill in services, FAQ, hours, contact, branding,
   and custom instructions.
3. **Hand over the snippet.** Give the client one line to paste before
   `</body>`:

   ```html
   <script src="https://conversekit-widget.pages.dev/widget.js"
           data-bot-id="THE_BOT_UUID" defer></script>
   ```

4. **Monitor.** Watch incoming **Leads** and **Conversations** in the dashboard.

---

## Testing with curl

```bash
# Liveness
curl https://conversekit.mukeremshifa.workers.dev/

# Bot health (replace with a real bot UUID)
curl https://conversekit.mukeremshifa.workers.dev/v1/bots/YOUR_BOT_ID/health

# Chat
curl -X POST https://conversekit.mukeremshifa.workers.dev/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"botId":"YOUR_BOT_ID","message":"What services do you offer?","sessionId":"test-001"}'
```
