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
