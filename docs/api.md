# API reference

Every route the Worker serves, with request and response shapes.

[← Back to the README](../README.md)

---

## API reference

### `GET /`
Liveness check → `{ "status": "ok", "service": "conversekit api" }`

### `GET /v1/bots/:id/health`
Public. Returns the bot's display config (name, business name, contact, primary
color). Used by the widget to theme itself. `404` if the bot doesn't exist.

A `widget` object carries the Bot Configuration settings — but **only the keys a
tenant actually set**, and it is `null` when they set none. Defaults belong to
`widget.js`, not here: a second copy of them in the API is a second thing to keep
in sync, and it would freeze today's defaults into every bot.

```json
{
  "widget": {
    "position": "bottom-left",
    "theme": "auto",
    "greeting": "Hi! How can I help?",
    "greetingDelayMs": 800,
    "showTyping": false,
    "showCitations": true,
    "logoUrl": "https://…/v1/bots/<uuid>/logo?v=<token>"
  }
}
```

`logoUrl` is a URL this Worker serves, never the R2 object key.

### `GET /v1/bots/:id/logo`
Public. Streams the bot's uploaded logo from R2, or `404` when it has none. The
only route that serves tenant-uploaded bytes to a browser — knowledge-base files
are converted to text and never served.

Cached `public, max-age=31536000, immutable`, which is safe because a replacement
logo is written under a new key and therefore a new URL. Conditional requests are
honoured, so a repeat visitor gets a `304`.

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
{ "reply": "We're open Monday to Friday, 8 AM to 6 PM.", "sessionId": "session-abc-123", "citations": [] }
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
| `done`  | `{ "sessionId": "…", "usage": { … }, "citations": ["Pricing 2026"] }` |
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
| `POST` | `/v1/admin/bots/:id/logo` | Upload a logo (multipart `file`). PNG/JPEG/WebP, 512 KB |
| `DELETE` | `/v1/admin/bots/:id/logo` | Remove the logo and delete the object |
| `GET` | `/v1/admin/bots/:id/leads` | List captured leads |
| `GET` | `/v1/admin/bots/:id/conversations` | List recent conversation messages. `?session_id=` narrows to one transcript |

The old `/admin/*` routes return `410 Gone`.

`citations` is populated only when the bot has `show_citations` on and the reply
used retrieved context. Both fields are additive — a widget that predates them
ignores them.

**`widget_config.logo_key` is never returned.** Admin responses strip it and add
a top-level `logo_url` instead: the key names an object in a bucket shared with
every tenant's documents, and sending it back would also put it in the settings
form's round-trip. Posting one is a `400` — the upload route owns that field, and
an ordinary settings save carries the stored value forward untouched.

**BYOK keys are never returned.** `provider_config.apiKey` is stripped from every
response and replaced with `hasApiKey` + `apiKeyLast4`. On update, an absent
`apiKey` means "keep the stored one" — so saving settings cannot wipe a key.

**`lead_config.webhook_url` is never returned either**, and for the same reason
it is a secret rather than merely private: a Slack or Teams incoming-webhook URL
is a bearer credential — anyone holding it can post into that channel. Responses
replace it with `has_webhook` (boolean) and `webhook_host` (e.g.
`"hooks.slack.com"`), which is enough for a settings screen to say where leads
are going and offer to disconnect.

On update it has three states:

| Sent | Meaning |
|---|---|
| omitted | keep whatever is stored — what every ordinary settings save does |
| a string | replace it. Must be `https://` and a public hostname; an IP literal, `localhost`, a `.local` name, a single-label host, or embedded credentials are all `400` |
| `null` | clear it |

An empty string is treated as "omitted", never as "clear" — a form that posts
`""` for an untouched field must not destroy a tenant's integration.

`lead_config.email_recipients` is **not** treated this way — an address is not a
credential — so it round-trips normally. Sending requires `RESEND_API_KEY` and
`LEAD_EMAIL_FROM` on the deployment; without them, recipients are stored and
nothing is sent. See [operations.md](operations.md).

Notifications are dispatched from `waitUntil` after the lead is committed, with a
5s timeout and **no retries** (a retry against an endpoint with no idempotency
key posts the same lead twice). The webhook and the email run concurrently and
independently — one failing does not suppress the other — and both are logged and
swallowed, so neither can affect the chat response.

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
