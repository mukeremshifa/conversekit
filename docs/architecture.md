# Architecture

How the pieces fit together, and where each one lives in the repo.

[← Back to the README](../README.md)

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
 │ index.html (site)│    │  GET  /v1/bots/:id/health  │──▶ │  bots        │
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
│   ├── index.html        # Landing page, with the live widget on it
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
├── docs/                 # Guides, roadmap, brand assets
├── tsconfig.json
└── package.json
```

---
