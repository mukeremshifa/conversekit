<div align="center">

<img src="docs/media/landing.png" alt="The ConverseKit landing page: the headline 'Drop-in chat for any website' inside a slowly turning ring of AI vendor logos, above a screenshot of the dashboard" width="820">

# ConverseKit

**Drop-in AI chat for any website.** Answers from your own docs, captures leads
while it talks, installs with one `<script>` tag.

[![CI](https://github.com/mukeremshifa/conversekit/actions/workflows/ci.yml/badge.svg)](https://github.com/mukeremshifa/conversekit/actions/workflows/ci.yml)
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
| [Operations](docs/operations.md) | Migrations, secrets, first-run, local dev, deploying |
| [Roadmap](docs/roadmap.md) | What is built, what is deferred, and why |

## Quick start

```bash
npm install                    # one lockfile, all four workspaces

npm run dev:app                # dashboard    → localhost:5173
npm run dev:site               # landing page → localhost:8788
npm run dev:cdn                # widget + fonts → localhost:8789
npm run dev:api                # API Worker   → localhost:8787

npm test                       # widget, session, RAG and entitlement units
npm run type-check             # the Worker and the dashboard
npm run build                  # all four deploy targets
```

Full setup — migrations, secrets and the first bot — is in
[Operations](docs/operations.md).

## Live URLs

| What | Worker | URL |
|---|---|---|
| Landing page | `ck-site` | https://conversekit.mukeremshifa.com |
| Admin dashboard | `ck-app` | https://app.conversekit.mukeremshifa.com |
| Widget script | `ck-cdn` | https://cdn.conversekit.mukeremshifa.com/v1/widget.js |
| API | `ck-api` | https://api.conversekit.mukeremshifa.com |

Staging is the same four on `.workers.dev`: `ck-<service>-staging.mukeemoha.workers.dev`.
Hostnames are written in exactly one place, [`config/origins.js`](config/origins.js).

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
