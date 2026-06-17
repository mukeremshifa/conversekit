# ConverseKit — Embeddable AI Chatbot for Any Website

A drop-in AI chat widget that answers visitor questions from a business's own
knowledge base and captures leads — installable on any site with a single
`<script>` tag.

**Stack:** Cloudflare Workers · Hono · Cloudflare Pages · Supabase (Postgres) · Google Gemini

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
 └──────────────────┘    │  /admin/bots/:id/*         │    │  leads       │
        admin UI          └─────────────┬─────────────┘    └──────────────┘
       x-admin-secret                   │  generate reply
                                        ▼
                                 ┌──────────────┐
                                 │ Google Gemini │
                                 └──────────────┘
```

- **Visitor flow:** `widget.js` (served from Pages) → `POST /v1/chat` on the Worker → Worker
  loads the bot + session history from Supabase, calls Gemini, saves the conversation (and any
  captured lead), returns the reply.
- **Admin flow:** the dashboard (served from Pages) calls the `/admin/*` routes on the Worker,
  authenticated with the `x-admin-secret` header.

---

## Repo layout

```
conversekit/
├── src/                  # Cloudflare Worker (the API)
│   ├── index.ts          # Hono app — all routes (chat + admin)
│   ├── claude.ts         # Google Gemini call (filename is historical)
│   ├── supabase.ts       # Supabase REST helpers (raw fetch, no SDK)
│   ├── prompt.ts         # System-prompt builder from a bot's knowledge base
│   ├── leads.ts          # Extracts the [[LEAD:{…}]] marker from replies
│   └── types.ts          # Shared TypeScript types (Env, Bot, Lead, …)
├── public/               # Frontend — deployed to Cloudflare Pages
│   ├── widget.js         # The embeddable chat widget
│   ├── test.html         # Demo site (Pearl Dental) with the widget installed
│   └── admin/            # Admin dashboard (index.html, admin.js, admin.css)
├── supabase/
│   ├── 001_init.sql      # Base schema: bots, conversations + demo seed
│   └── 002_phase1.sql    # Knowledge-base columns + leads table
├── wrangler.toml         # Worker config
├── tsconfig.json
└── package.json
```

> Note: `src/claude.ts` is named from an earlier Anthropic Claude version. The
> project now uses Google Gemini — the filename was kept to avoid churn.

---

## Secrets

Four secrets are required.

| Name | Purpose |
|------|---------|
| `GEMINI_API_KEY` | Google Gemini API key (AI replies) |
| `SUPABASE_URL` | Your Supabase project URL, e.g. `https://xxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase anon key |
| `ADMIN_SECRET` | Shared secret guarding the `/admin/*` routes |

**Local** — put them in `.dev.vars` (git-ignored):

```
GEMINI_API_KEY=...
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
ADMIN_SECRET=choose-a-long-random-string
```

**Production** — set them as Worker secrets:

```bash
wrangler secret put GEMINI_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY
wrangler secret put ADMIN_SECRET
```

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

- The same `sessionId` keeps multi-turn context (history is loaded from Supabase).
- **Origin lock:** if the request carries an `Origin` header that doesn't match
  the bot's `allowed_origin`, the Worker responds `403`. Requests with no
  `Origin` (e.g. curl, server-to-server) are allowed for testing.

### Admin routes
All require the `x-admin-secret: <ADMIN_SECRET>` header; otherwise `401`.

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/admin/bots/:id` | Fetch the full bot record |
| `PUT` | `/admin/bots/:id` | Update bot settings / knowledge base |
| `GET` | `/admin/bots/:id/leads` | List captured leads |
| `GET` | `/admin/bots/:id/conversations` | List recent conversation messages |

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
