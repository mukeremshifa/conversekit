<div align="center">

<img src="docs/media/landing.png" alt="The ConverseKit landing page: the headline 'Drop-in chat for any website' inside a slowly turning ring of AI vendor logos, above a screenshot of the dashboard" width="820">

# ConverseKit

**Drop-in AI chat for any website.** Answers from your own docs, captures leads
while it talks, installs with one `<script>` tag.

[![License](https://img.shields.io/badge/license-proprietary-0A0A0C)](LICENSE)

[Live site](https://conversekit.mukeremshifa.com) ·
[Dashboard](https://app.conversekit.mukeremshifa.com) ·
[Documentation](#documentation)

</div>

---

## What it is

A multi-tenant conversational AI platform, deployed as four Cloudflare Workers —
the API, the dashboard, the widget CDN and the landing page — each with its own
hostname, cache policy and blast radius. Together they support an unlimited
number of client bots. Each bot is a row in Postgres with its own branding,
knowledge base, allowed origins and AI provider.

Tiers, when they exist, will be rows in that table too. There is one API Worker
for every plan and one widget artifact for every plan; see
[`apps/api/src/entitlements.ts`](apps/api/src/entitlements.ts) for why.

Onboarding a client is inserting a row and handing them a script tag. No
redeploy, and no build step on their side.

```html
<script
  src="https://cdn.conversekit.mukeremshifa.com/v1/widget.js"
  data-bot-id="YOUR_BOT_ID"
  defer></script>
```

<img src="docs/media/widget.png" alt="The chat widget open, answering a question about supported AI vendors with a formatted list" width="320" align="right">

### What it does

- **Answers from your documents.** Text, markdown and URLs become a searchable
  corpus. At question time the query is embedded and matched against that bot's
  chunks by cosine similarity, and the best passages go into the prompt.
- **Eleven AI vendors, one interface.** OpenAI, Anthropic, Gemini, Groq,
  OpenRouter, Mistral, Workers AI, DeepSeek, Together, Ollama and LM Studio,
  plus any OpenAI-compatible endpoint. Switching is a dropdown, per bot.
- **Runs at no cost.** Gemini Flash Lite for chat and Workers AI for
  embeddings cover the whole loop on free tiers. That is the platform default,
  and it is verified rather than theoretical.
- **Captures leads.** The model collects a name, email or phone number
  mid-conversation and files it for CSV export.
- **Streams, with a net.** Replies arrive over SSE; a transport failure falls
  back to a buffered endpoint and the visitor still gets an answer.
- **Isolated by the database.** Row-level security keyed off organization
  membership, not application code that a refactor can quietly drop.
- **Origin-locked.** Each bot allows an explicit list of origins; a request from
  anywhere else is refused before the model is ever called.

<br clear="right">

## Stack

Cloudflare Workers (four of them, static assets and all) · Hono ·
Supabase Postgres · pgvector · React + Vite + Tailwind v4 · npm workspaces

## Documentation

| Guide | What's in it |
|---|---|
| [Architecture](docs/architecture.md) | How the pieces fit together, and the repo layout |
| [AI providers](docs/providers.md) | The vendor catalog, resolution order, running for free |
| [Knowledge sources](docs/knowledge.md) | Chunking, embedding, retrieval, and its failure modes |
| [Tenancy and leads](docs/tenancy.md) | Organizations, RLS, the origin lock, lead capture |
| [API reference](docs/api.md) | Every route, with request and response shapes |
| [Operations](docs/operations.md) | Migrations, secrets, local dev, deploying, onboarding a client |
| [Roadmap](docs/roadmap.md) | What is built, what is deferred, and why |

Everything under [`docs/`](docs/) is indexed in [docs/README.md](docs/README.md),
including [`docs/history/`](docs/history/) — narratives of work already finished,
kept for the reasoning rather than as instructions.

## Quick start

```bash
npm install          # one lockfile, all four workspaces
npm run dev          # all four on localhost, one terminal, one Ctrl-C
```

|  | Port |  |
|---|---|---|
| `api` | 8787 | the Worker, through `wrangler dev` |
| `app` | 5173 | the dashboard, Vite with HMR |
| `site` | 8788 | the landing page, live reload |
| `cdn` | 8789 | `widget.js`, fonts, brand assets |

The four are wired to each other rather than to production, so a change to a
route or to `widget.js` shows up in the page in front of you. Run a subset with
`npm run dev -- app`, or list them with `npm run dev -- --list`.

```bash
npm run type-check   # the Worker and the dashboard
npm run build        # all four deploy targets
npm run deploy       # publish all four, api first
```

Full setup — secrets, migrations and the first bot — is in
[Operations](docs/operations.md).

## One environment

**There is no staging.** One Supabase project, one set of four Workers, one
branch, deployed from a laptop. What `npm run dev` runs is what is deployed,
pointed at localhost.

That is a deliberate trade while there is no customer data to protect: a second
environment costs a second project, a second set of secrets and a second thing
to be wrong. The rule that replaces it is that the database is real — nothing
you do locally is a rehearsal.

## Repo map

```
apps/api        the Hono Worker. Routes, auth, RAG, providers, entitlements
apps/app        the dashboard. React + Vite, deployed as an assets-only Worker
apps/cdn        widget.js, fonts and brand assets. Serves bytes, knows no tenants
apps/site       the landing page. Hand-written HTML, no bundler

config/         origins.js — the ONLY place a hostname is written
                demo-bot.js — the landing page's live demo bot, as data
packages/brand  favicons, logos and web fonts. One copy, built into each target
supabase/       the schema, as numbered migrations applied by scripts/migrate.mjs

scripts/        six, and each one is load-bearing:
                  dev.mjs           `npm run dev` — spawns the four servers
                  build-assets.mjs  token substitution for site + cdn
                  dev-static.mjs    the static server dev.mjs drives
                  migrate.mjs       applies supabase/*.sql
                  secrets.mjs       pushes Worker secrets to Cloudflare
                  seed-demo-bot.mjs provisions the demo bot on the landing page
```

## Live URLs

| What | Worker | URL |
|---|---|---|
| Landing page | `ck-site` | https://conversekit.mukeremshifa.com |
| Admin dashboard | `ck-app` | https://app.conversekit.mukeremshifa.com |
| Widget script | `ck-cdn` | https://cdn.conversekit.mukeremshifa.com/v1/widget.js |
| API | `ck-api` | https://api.conversekit.mukeremshifa.com |

Hostnames are written in exactly one place,
[`config/origins.js`](config/origins.js), which is also what swaps them for
`localhost` under `npm run dev`. Moving to another zone is an edit to `ZONE`
there plus a redeploy.

## Widget API

Once loaded, the widget exposes a small global so a host page can drive it from
its own button:

```js
window.ConverseKit.open();      // open the panel
window.ConverseKit.close();
window.ConverseKit.toggle();
window.ConverseKit.isOpen();    // -> boolean
window.ConverseKit.version;     // -> "0.8.0"
```

## License

Proprietary — see [LICENSE](LICENSE). The source is public to read; it is not
open source, and no rights to use, deploy or redistribute it are granted.

Changes are recorded in [CHANGELOG.md](CHANGELOG.md).
