import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  getBotById,
  updateBot,
  getSessionHistory,
  logMessage,
  getConversations,
  saveLead,
  getLeads,
} from './supabase';
import { buildSystemPrompt } from './prompt';
import { chat } from './claude';
import { extractLead } from './leads';
import type { Env, ChatRequest, BotUpdatePayload } from './types';

const app = new Hono<{ Bindings: Env }>();

// ================================================================
// CORS
// ================================================================
app.use('*', cors({
  origin: (origin) => origin,
  allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'x-admin-secret'],
  maxAge: 86400,
}));

// ================================================================
// Admin auth
// ================================================================
function requireAdmin(env: Env, secret: string | undefined): boolean {
  return !!env.ADMIN_SECRET && secret === env.ADMIN_SECRET;
}

// ================================================================
// GET /
// ================================================================
app.get('/', (c) => c.json({ status: 'ok', service: 'conversekit api' }));

// ================================================================
// GET /v1/bots/:id/health
// ================================================================
app.get('/v1/bots/:id/health', async (c) => {
  const bot = await getBotById(c.env, c.req.param('id'));
  if (!bot) return c.json({ error: 'Bot not found' }, 404);
  return c.json({
    status:       'ok',
    botId:        bot.id,
    name:         bot.name,
    businessName: bot.business_name,
    contact:      bot.contact_phone ?? bot.contact ?? null,
    primaryColor: bot.primary_color,
  });
});

// ================================================================
// POST /v1/chat
// ================================================================
app.post('/v1/chat', async (c) => {
  let body: ChatRequest;
  try { body = await c.req.json<ChatRequest>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  const { botId, message, sessionId } = body;
  if (!botId   || typeof botId    !== 'string') return c.json({ error: '`botId` is required' }, 400);
  if (!message || typeof message  !== 'string' || !message.trim()) return c.json({ error: '`message` must be a non-empty string' }, 400);
  if (!sessionId || typeof sessionId !== 'string') return c.json({ error: '`sessionId` is required' }, 400);

  // Fetch bot
  let bot;
  try { bot = await getBotById(c.env, botId); }
  catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
  if (!bot) return c.json({ error: 'Bot not found' }, 404);

  // CORS enforcement
  const requestOrigin = c.req.header('origin');
  if (requestOrigin) {
    const norm    = requestOrigin.replace(/\/$/, '');
    const allowed = bot.allowed_origin.replace(/\/$/, '');
    if (norm !== allowed) return c.json({ error: `Origin '${requestOrigin}' is not allowed` }, 403);
  }

  // Build prompt + history
  const systemPrompt = buildSystemPrompt(bot);
  let history: Array<{ role: 'user' | 'assistant'; content: string }>;
  try { history = await getSessionHistory(c.env, botId, sessionId); }
  catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }

  // Call Gemini
  let rawReply: string;
  try { rawReply = await chat(c.env.GEMINI_API_KEY, systemPrompt, history, message.trim()); }
  catch (err) { console.error(err); return c.json({ error: 'AI service error' }, 502); }

  // Extract lead
  const { cleanReply, lead } = extractLead(rawReply);
  if (lead) {
    try { await saveLead(c.env, botId, sessionId, lead); }
    catch (err) { console.error('saveLead failed (non-fatal):', err); }
  }

  // Log conversation
  try {
    await logMessage(c.env, { bot_id: botId, session_id: sessionId, role: 'user',      content: message.trim() });
    await logMessage(c.env, { bot_id: botId, session_id: sessionId, role: 'assistant', content: cleanReply });
  } catch (err) { console.error('logMessage failed (non-fatal):', err); }

  return c.json({ reply: cleanReply, sessionId });
});

// ================================================================
// ADMIN ROUTES
// ================================================================
app.get('/admin/bots/:id', async (c) => {
  if (!requireAdmin(c.env, c.req.header('x-admin-secret'))) return c.json({ error: 'Unauthorized' }, 401);
  const bot = await getBotById(c.env, c.req.param('id'));
  if (!bot) return c.json({ error: 'Bot not found' }, 404);
  return c.json(bot);
});

app.put('/admin/bots/:id', async (c) => {
  if (!requireAdmin(c.env, c.req.header('x-admin-secret'))) return c.json({ error: 'Unauthorized' }, 401);
  let payload: BotUpdatePayload;
  try { payload = await c.req.json<BotUpdatePayload>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }
  try {
    const updated = await updateBot(c.env, c.req.param('id'), payload);
    return c.json(updated);
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
});

app.get('/admin/bots/:id/leads', async (c) => {
  if (!requireAdmin(c.env, c.req.header('x-admin-secret'))) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const leads = await getLeads(c.env, c.req.param('id'));
    return c.json({ leads });
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
});

app.get('/admin/bots/:id/conversations', async (c) => {
  if (!requireAdmin(c.env, c.req.header('x-admin-secret'))) return c.json({ error: 'Unauthorized' }, 401);
  try {
    const convos = await getConversations(c.env, c.req.param('id'));
    return c.json({ conversations: convos });
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
});


export default app;


