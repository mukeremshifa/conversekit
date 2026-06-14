# clinica-bot — AI Website Chatbot Backend

Cloudflare Workers · Hono · Supabase · Anthropic Claude

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Set up secrets
Edit `.dev.vars` with your real credentials:
```
ANTHROPIC_API_KEY=sk-ant-...
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
```

### 3. Run the Supabase migration
Open the Supabase SQL Editor → paste and run `supabase/001_init.sql`.
Copy the UUID of the seeded demo bot from the `bots` table.

### 4. Start local dev server
```bash
npm run dev
# Wrangler starts at http://localhost:8787
```

---

## API Endpoints

### `GET /`
Liveness check.

### `GET /v1/bots/:id/health`
Verify a bot exists and the DB connection is live.

### `POST /v1/chat`
Send a message. Returns the assistant reply.

**Body:**
```json
{
  "botId": "<uuid>",
  "message": "What are your opening hours?",
  "sessionId": "session-abc-123"
}
```

**Response:**
```json
{
  "reply": "We are open Monday to Friday, 8 AM to 6 PM.",
  "sessionId": "session-abc-123"
}
```

---

## Testing with curl

> Replace `YOUR_BOT_ID` with the UUID from the `bots` table.

### Liveness
```bash
curl http://localhost:8787/
```

### Health check
```bash
curl http://localhost:8787/v1/bots/YOUR_BOT_ID/health
```

### Chat (no Origin header — allowed for backend testing)
```bash
curl -X POST http://localhost:8787/v1/chat \
  -H "Content-Type: application/json" \
  -d '{
    "botId": "YOUR_BOT_ID",
    "message": "What services do you offer?",
    "sessionId": "test-session-001"
  }'
```

### Chat (simulating a browser from the allowed origin)
```bash
curl -X POST http://localhost:8787/v1/chat \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:3000" \
  -d '{
    "botId": "YOUR_BOT_ID",
    "message": "Where are you located?",
    "sessionId": "test-session-001"
  }'
```

### CORS rejection test (wrong origin → should return 403)
```bash
curl -X POST http://localhost:8787/v1/chat \
  -H "Content-Type: application/json" \
  -H "Origin: https://evil.com" \
  -d '{
    "botId": "YOUR_BOT_ID",
    "message": "Hello",
    "sessionId": "test-session-001"
  }'
```

### Multi-turn conversation (same sessionId keeps context)
```bash
# Turn 1
curl -X POST http://localhost:8787/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"botId":"YOUR_BOT_ID","message":"Hi, what is your contact number?","sessionId":"session-multi"}'

# Turn 2 — Claude will remember the conversation
curl -X POST http://localhost:8787/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"botId":"YOUR_BOT_ID","message":"Can I book an appointment?","sessionId":"session-multi"}'
```

---

## Deploy to Cloudflare

```bash
# Add secrets to your Worker (one-time)
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY

# Deploy
npm run deploy
```

---

## Project Structure

```
clinica-bot/
├── src/
│   ├── index.ts       # Hono app, all routes
│   ├── supabase.ts    # DB helpers (getBotById, logMessage, getSessionHistory)
│   ├── claude.ts      # Anthropic API call
│   ├── prompt.ts      # System prompt builder
│   └── types.ts       # Shared TypeScript types
├── supabase/
│   └── 001_init.sql   # DB migration (run in Supabase SQL Editor)
├── .dev.vars          # Local secrets (git-ignored)
├── wrangler.toml      # Cloudflare Workers config
├── tsconfig.json
└── package.json
```
