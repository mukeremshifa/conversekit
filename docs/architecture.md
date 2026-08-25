# Architecture

How the pieces fit together, and where each one lives in the repo.

[← Back to the README](../README.md)

---

## Architecture

```
                    ┌──────────────────────────────────┐
                    │  Client's website                 │
                    │  <script src="https://cdn.…/v1/   │
                    │          widget.js" data-bot-id>  │
                    └────────────────┬─────────────────┘
                                     │  POST /v1/chat/stream
    ck-cdn                           ▼                          External
 ┌────────────────┐   ck-api  ┌────────────────────────────┐  ┌───────────────┐
 │ /v1/widget.js  │──┐        │  GET  /                     │  │  Supabase     │
 │ /0.11.0/…      │  │        │  GET  /v1/bots/:id/health   │─▶│  bots         │
 │ /fonts /brand  │  ├───────▶│  POST /v1/chat              │  │  conversations│
 └────────────────┘  │        │  POST /v1/chat/stream       │  │  leads        │
    ck-app           │        │  /v1/admin/*                │  │  documents    │
 ┌────────────────┐  │        └──────────────┬─────────────┘  │  chunks       │
 │ dashboard SPA  │──┘                       │                └───────────────┘
 └────────────────┘   Bearer <jwt>           │ resolveChatProvider(bot)
    ck-site                                  ▼
 ┌────────────────┐          ┌──────────────────────────────┐
 │ landing page   │          │  apps/api/src/providers      │
 └────────────────┘          ├──────────────────────────────┤
                             │ OpenAI · Anthropic · Gemini  │
                             │ Groq · OpenRouter · Mistral  │
                             │ DeepSeek · Together          │
                             │ Workers AI                   │
                             │ Ollama · LM Studio · custom  │
                             └──────────────────────────────┘

 Four Workers, four hostnames. ck-api is the only one with a script;
 the other three serve static assets and nothing else.
```

- **Visitor flow:** `widget.js` (served from `ck-cdn`) → `POST /v1/chat/stream` on `ck-api` →
  Worker loads the bot + session history from Supabase, resolves the bot's configured AI
  vendor, streams the reply back token by token, saves the conversation (and any captured
  lead). Falls back to the buffered `POST /v1/chat` if streaming is unavailable.
- **Admin flow:** the dashboard (`ck-app`) calls `/v1/admin/*` on `ck-api` with the
  signed-in user's Supabase JWT, which is forwarded to PostgREST so RLS decides what they see.

---

## Repo layout

npm workspaces, one lockfile, four deploy targets. The split is the point:
landing, dashboard, widget CDN and API have different change rates, cache
policies and blast radii, so a marketing typo no longer redeploys the script
that runs on customers' sites.

```
conversekit/
├── apps/
│   ├── api/              # ck-api — the Hono app. The one with a script.
│   │   ├── wrangler.jsonc
│   │   └── src/
│   │       ├── index.ts          # all routes (chat + admin)
│   │       ├── entitlements.ts   # what a plan may do — the tier seam
│   │       ├── providers/        # AI vendor adapters
│   │       ├── rag/              # chunk, embed, retrieve
│   │       ├── supabase.ts       # PostgREST helpers (raw fetch, no SDK)
│   │       ├── prompt.ts         # system prompt from a bot's knowledge
│   │       ├── leads.ts          # extracts the [[LEAD:{…}]] marker
│   │       └── types.ts          # Env, Bot, Lead, …
│   ├── app/              # ck-app — dashboard, React + Vite + Tailwind
│   │   ├── wrangler.jsonc        # assets only, SPA routing, no main
│   │   ├── src/                  # builds into apps/app/dist/
│   │   └── vite.config.ts        # reads config/origins.js via `define`
│   ├── cdn/              # ck-cdn — widget.js, fonts, brand. Bytes only.
│   │   ├── wrangler.jsonc
│   │   └── assets/{widget.js,_headers}   → dist/{,v1/,0.11.0/}widget.js
│   └── site/             # ck-site — the landing page
│       ├── wrangler.jsonc
│       └── assets/{index.html,404.html,shots/,_headers}
├── config/
│   ├── origins.js        # hostnames — and the CK_DEV switch to localhost
│   └── demo-bot.js       # the landing page's live demo bot, as data
├── packages/brand/assets/  # the single copy of favicons, logos, fonts
├── scripts/              # six, each load-bearing
│   ├── dev.mjs           # `npm run dev` — spawns all four servers
│   ├── build-assets.mjs  # token substitution + widget placement
│   ├── dev-static.mjs    # the static server with live reload dev.mjs drives
│   ├── migrate.mjs       # the only thing that applies supabase/*.sql
│   ├── secrets.mjs       # pushes Worker secrets to Cloudflare
│   └── seed-demo-bot.mjs # provisions the demo bot from config/demo-bot.js
├── supabase/             # six migrations — see supabase/README.md
└── docs/                 # current docs, plus docs/history/ for finished work
```

The build targets are all generated: `apps/*/dist/` is gitignored and rebuilt
from tracked sources by `npm run build` — and by `npm run dev`, which builds
before it serves. The dashboard bundle used to be committed under
`public/admin/`, which meant the deployed artifact was whichever copy was on
someone's laptop.

There is **one** environment. `config/origins.js` names the four deployed
hostnames, and swaps them for four `localhost` ports when `npm run dev` sets
`CK_DEV=1` — see [operations.md](operations.md).

---
