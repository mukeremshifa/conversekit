import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { makeSupabase, getBotById, getSessionHistory, logMessage } from './supabase';
import { buildSystemPrompt } from './prompt';
import { chat } from './claude';
import type { Env, ChatRequest } from './types';

const app = new Hono<{ Bindings: Env }>();

// ----------------------------------------------------------------
// Global CORS middleware
// The per-bot origin check happens inside POST /v1/chat.
// This middleware lets browsers send the preflight OPTIONS request.
// ----------------------------------------------------------------
app.use(
  '*',
  cors({
    origin: (origin) => origin,   // reflect origin; actual enforcement is below
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
    maxAge: 86400,
  })
);

// ----------------------------------------------------------------
// GET /
// Simple liveness probe.
// ----------------------------------------------------------------
app.get('/', (c) => c.json({ status: 'ok', service: 'clinica-bot api' }));

// ----------------------------------------------------------------
// GET /v1/bots/:id/health
// Returns the bot name so you can verify the bot exists and the
// Supabase connection is working, without exposing sensitive data.
// ----------------------------------------------------------------
app.get('/v1/bots/:id/health', async (c) => {
  const botId = c.req.param('id');
  const supabase = makeSupabase(c.env);

  const bot = await getBotById(supabase, botId);
  if (!bot) {
    return c.json({ error: 'Bot not found' }, 404);
  }

  return c.json({
    status: 'ok',
    botId: bot.id,
    name: bot.name,
    businessName: bot.business_name,
  });
});

// ----------------------------------------------------------------
// POST /v1/chat
// Main endpoint. Validates origin, calls Claude, logs messages.
// ----------------------------------------------------------------
app.post('/v1/chat', async (c) => {
  // ── 1. Parse & validate request body ──────────────────────────
  let body: ChatRequest;
  try {
    body = await c.req.json<ChatRequest>();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { botId, message, sessionId } = body;

  if (!botId || typeof botId !== 'string') {
    return c.json({ error: '`botId` is required' }, 400);
  }
  if (!message || typeof message !== 'string' || message.trim() === '') {
    return c.json({ error: '`message` is required and must be a non-empty string' }, 400);
  }
  if (!sessionId || typeof sessionId !== 'string') {
    return c.json({ error: '`sessionId` is required' }, 400);
  }

  // ── 2. Fetch bot config ────────────────────────────────────────
  const supabase = makeSupabase(c.env);
  let bot;
  try {
    bot = await getBotById(supabase, botId);
  } catch (err) {
    console.error('Supabase getBotById failed:', err);
    return c.json({ error: 'Database error' }, 502);
  }

  if (!bot) {
    return c.json({ error: 'Bot not found' }, 404);
  }

  // ── 3. CORS / origin enforcement ──────────────────────────────
  // We enforce the allowed_origin registered per-bot.
  // Requests without an Origin header (e.g. direct curl/server calls)
  // are allowed through — restrict this if you need stricter control.
  const requestOrigin = c.req.header('origin');
  if (requestOrigin) {
    const normalised = requestOrigin.replace(/\/$/, '');
    const allowed   = bot.allowed_origin.replace(/\/$/, '');
    if (normalised !== allowed) {
      return c.json(
        { error: `Origin '${requestOrigin}' is not allowed for this bot` },
        403
      );
    }
  }

  // ── 4. Build system prompt ────────────────────────────────────
  const systemPrompt = buildSystemPrompt(bot);

  // ── 5. Retrieve session history ───────────────────────────────
  let history: Array<{ role: 'user' | 'assistant'; content: string }>;
  try {
    history = await getSessionHistory(supabase, botId, sessionId);
  } catch (err) {
    console.error('Supabase getSessionHistory failed:', err);
    return c.json({ error: 'Database error' }, 502);
  }

  // ── 6. Call Claude ────────────────────────────────────────────
  let reply: string;
  try {
    reply = await chat(c.env.ANTHROPIC_API_KEY, systemPrompt, history, message.trim());
  } catch (err) {
    console.error('Claude API error:', err);
    return c.json({ error: 'AI service error' }, 502);
  }

  // ── 7. Log both turns to Supabase (fire-and-forget is fine) ──
  try {
    await logMessage(supabase, { bot_id: botId, session_id: sessionId, role: 'user',      content: message.trim() });
    await logMessage(supabase, { bot_id: botId, session_id: sessionId, role: 'assistant', content: reply });
  } catch (err) {
    // Logging failure should NOT fail the user request
    console.error('Supabase logMessage failed (non-fatal):', err);
  }

  // ── 8. Return response ────────────────────────────────────────
  return c.json({ reply, sessionId });
});

// ----------------------------------------------------------------
// 404 catch-all
// ----------------------------------------------------------------
app.notFound((c) => c.json({ error: 'Not found' }, 404));

// ----------------------------------------------------------------
// Global error handler
// ----------------------------------------------------------------
app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
