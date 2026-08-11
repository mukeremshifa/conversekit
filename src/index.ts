import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import {
  serviceDb,
  userDb,
  getMemberships,
  createOrganization,
  getBotForChat,
  getBotForAdmin,
  listBots,
  createBot,
  updateBot,
  deleteBot,
  getSessionHistory,
  logMessage,
  getConversations,
  saveLead,
  getLeads,
  listDocuments,
  createDocument,
  getDocumentForAdmin,
  deleteDocument,
  listDocumentKeys,
  orgStorageBytes,
  listChunks,
  hasChunks,
  getStatMessages,
  getStatLeads,
  getStatDocuments,
  STATS_MESSAGE_CAP,
  STATS_LEAD_CAP,
  type ServiceDb,
  type UserDb,
} from './supabase';
import { ingestDocument } from './rag/ingest';
import {
  detectFileType,
  objectKeyFor,
  supportedList,
  MAX_FILE_BYTES,
  ORG_STORAGE_CAP_BYTES,
  SNIFF_BYTES,
} from './rag/files';
import { retrieve, renderContext } from './rag/retrieve';
import { buildSystemPrompt } from './prompt';
import { verifyToken, bearerFrom, AuthError } from './auth';
import {
  resolveChatProvider,
  ProviderError,
  httpStatusFor,
  VENDORS,
  type ChatProvider,
  type Message,
  type Usage,
} from './providers';
import { extractLead } from './leads';
import { buildStats } from './stats';
import { LeadStreamFilter } from './lead-stream';
import { issueSessionId, verifySessionId } from './session';
import { isOriginAllowed, validateOrigins, validateSuggestions } from './origin';
import type { Env, Bot, Document, ChatRequest, BotUpdatePayload, BotCreatePayload } from './types';

type Vars = { db: UserDb; userId: string; email: string | null };

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// ================================================================
// CORS
// ================================================================
app.use('*', cors({
  origin: (origin) => origin,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}));

// ================================================================
// Auth middleware
//
// Replaces the old global ADMIN_SECRET. Every /v1/admin route runs
// as the calling user: the middleware verifies their Supabase JWT
// and hands the route a Db bound to that token, so PostgREST applies
// RLS. A route cannot accidentally reach across tenants because it
// never holds a privileged client.
// ================================================================
app.use('/v1/admin/*', async (c, next) => {
  const token = bearerFrom(c.req.header('authorization'));
  if (!token) return c.json({ error: 'Missing bearer token' }, 401);

  try {
    const actor = await verifyToken(c.env, token);
    c.set('db', userDb(c.env, actor.jwt));
    c.set('userId', actor.userId);
    c.set('email', actor.email);
  } catch (err) {
    if (err instanceof AuthError) return c.json({ error: err.message }, 401);
    console.error(err);
    return c.json({ error: 'Authentication failed' }, 401);
  }

  return next();
});

/**
 * Tenant-supplied API keys live in provider_config/embedding_config.
 * The dashboard needs to know a key is set without being handed it.
 *
 * The key is REMOVED rather than replaced with a placeholder. An
 * earlier version sent back "••••1234" and treated that string on the
 * way in as "unchanged" — which quietly destroyed the stored key the
 * moment anything re-encoded those multi-byte bullets. Absence is not
 * encoding-dependent, so absence is the signal.
 */
function redactBotSecrets(bot: Bot): Record<string, unknown> {
  const scrub = (cfg: { apiKey?: string } | null | undefined) => {
    if (!cfg) return cfg;
    const { apiKey, ...rest } = cfg;
    return { ...rest, hasApiKey: !!apiKey, apiKeyLast4: apiKey ? apiKey.slice(-4) : null };
  };
  return {
    ...bot,
    provider_config:  scrub(bot.provider_config),
    embedding_config: scrub(bot.embedding_config),
  };
}

// ================================================================
// GET /
// ================================================================
app.get('/', (c) => c.json({ status: 'ok', service: 'conversekit api' }));

// ================================================================
// Removed routes
//
// The old ADMIN_SECRET-guarded surface. A cached copy of the previous
// dashboard should fail loudly and legibly rather than 404 into a
// generic "not found" that reads like a bug. Delete a release later.
// ================================================================
app.all('/admin/*', (c) => c.json({
  error: 'Removed. Use /v1/admin/* with a Supabase bearer token.',
}, 410));

// ================================================================
// GET /v1/bots/:id/health
// Public — the widget themes itself from this. Fixed field list, so
// knowledge base and provider config can never leak through it.
// ================================================================
app.get('/v1/bots/:id/health', async (c) => {
  let bot: Bot | null;
  try { bot = await getBotForChat(serviceDb(c.env), c.req.param('id')); }
  catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }

  if (!bot) return c.json({ error: 'Bot not found' }, 404);
  return c.json({
    status:       'ok',
    botId:        bot.id,
    name:         bot.name,
    businessName: bot.business_name,
    contact:      bot.contact_phone ?? bot.contact ?? null,
    primaryColor: bot.primary_color,
    // Null means the widget uses its own neutral defaults. Before this
    // every bot on the platform asked visitors about dental insurance.
    suggestions:  bot.suggestions ?? null,
    streaming:    true,
  });
});

// ================================================================
// Shared chat preflight
//
// Everything that can fail with a meaningful HTTP status happens here,
// before either handler commits to a response body. That matters for
// the streaming route: once SSE starts, the status is already 200.
//
// Runs as service_role: the caller is an anonymous visitor with no
// Supabase identity. Tenancy is the origin lock plus the botId.
// ================================================================
type Preflight =
  | { ok: false; status: 400 | 403 | 404 | 502; error: string }
  | { ok: true; bot: Bot; db: ServiceDb; provider: ChatProvider; system: string; messages: Message[]; sessionId: string; userMessage: string };

interface PreflightOptions {
  /** Set by the dashboard preview route, where the caller's origin is
   *  the dashboard rather than the client's site and auth is the gate. */
  skipOriginCheck?: boolean;
  /** Preview traffic is authenticated and must not touch a visitor's
   *  real transcript, nor be persisted as one. */
  ephemeral?: boolean;
}

async function preflight(
  c: { env: Env; req: { json: <T>() => Promise<T>; header: (n: string) => string | undefined } },
  opts: PreflightOptions = {},
): Promise<Preflight> {
  let body: ChatRequest;
  try { body = await c.req.json<ChatRequest>(); }
  catch { return { ok: false, status: 400, error: 'Invalid JSON body' }; }

  const { botId, message, sessionId } = body;
  if (!botId     || typeof botId     !== 'string') return { ok: false, status: 400, error: '`botId` is required' };
  if (!message   || typeof message   !== 'string' || !message.trim()) return { ok: false, status: 400, error: '`message` must be a non-empty string' };
  if (sessionId !== undefined && typeof sessionId !== 'string') {
    return { ok: false, status: 400, error: '`sessionId` must be a string' };
  }

  let db: ServiceDb;
  try { db = serviceDb(c.env); }
  catch (err) { console.error(err); return { ok: false, status: 502, error: 'Database not configured' }; }

  let bot: Bot | null;
  try { bot = await getBotForChat(db, botId); }
  catch (err) { console.error(err); return { ok: false, status: 502, error: 'Database error' }; }
  if (!bot) return { ok: false, status: 404, error: 'Bot not found' };

  // Origin lock. Matched against a list now: a client with both an
  // apex and a www host is the norm, not the exception.
  if (!opts.skipOriginCheck) {
    const requestOrigin = c.req.header('origin');
    if (requestOrigin && !isOriginAllowed(bot, requestOrigin)) {
      return { ok: false, status: 403, error: `Origin '${requestOrigin}' is not allowed` };
    }
  }

  // A session id decides whose transcript gets loaded, so it must be
  // one we signed. An unsigned or expired one is not an error — it is
  // simply a new conversation, and the caller gets a valid id back.
  let resolvedSession: string;
  let trusted = false;
  if (opts.ephemeral) {
    // Preview turns are stateless: they never load a visitor's history
    // and persistTurn is skipped, so trying a bot cannot pollute real
    // transcripts or leads.
    resolvedSession = sessionId ?? 'preview';
  } else if (sessionId && await verifySessionId(c.env, botId, sessionId)) {
    resolvedSession = sessionId;
    trusted = true;
  } else {
    resolvedSession = await issueSessionId(c.env, botId);
  }

  let history: Message[] = [];
  if (trusted) {
    try { history = await getSessionHistory(db, botId, resolvedSession); }
    catch (err) { console.error(err); return { ok: false, status: 502, error: 'Database error' }; }
  }

  const userMessage = message.trim();

  // Resolution failures (unknown vendor, missing key) are config errors,
  // not runtime ones — surface them before any tokens are generated.
  let provider: ChatProvider;
  try { provider = resolveChatProvider(c.env, bot.provider_config); }
  catch (err) {
    console.error(err);
    if (err instanceof ProviderError) return { ok: false, status: 502, error: `AI provider misconfigured: ${err.message}` };
    return { ok: false, status: 502, error: 'AI provider misconfigured' };
  }

  // Retrieval. Never fatal: a bot with no corpus, or an embedding
  // vendor having a bad minute, falls back to the plain knowledge-base
  // prompt rather than failing the visitor's turn.
  let context = '';
  try {
    if (await hasChunks(db, botId)) {
      const outcome = await retrieve(c.env, db, bot, userMessage);
      context = renderContext(outcome.chunks);
    }
  } catch (err) {
    console.error('[rag] skipped (non-fatal):', err);
  }

  return {
    ok:       true,
    bot,
    db,
    provider,
    system:   buildSystemPrompt(bot, context),
    // The current turn is not yet persisted, so append it to the window.
    messages: [...history, { role: 'user', content: userMessage }],
    sessionId: resolvedSession,
    userMessage,
  };
}

/**
 * Persist the exchange and any captured lead. Never throws — a logging
 * failure must not cost the visitor their answer.
 */
async function persistTurn(
  db: ServiceDb,
  botId: string,
  sessionId: string,
  userMessage: string,
  reply: string,
  rawReply: string,
): Promise<void> {
  const { lead } = extractLead(rawReply);
  if (lead) {
    try { await saveLead(db, botId, sessionId, lead); }
    catch (err) { console.error('saveLead failed (non-fatal):', err); }
  }
  try {
    await logMessage(db, { bot_id: botId, session_id: sessionId, role: 'user',      content: userMessage });
    await logMessage(db, { bot_id: botId, session_id: sessionId, role: 'assistant', content: reply });
  } catch (err) { console.error('logMessage failed (non-fatal):', err); }
}

/**
 * Abuse guard for the public chat path.
 *
 * Not monetisation — every bot now shares one Groq key and one Workers
 * AI allocation, so an unthrottled endpoint lets anyone holding a bot
 * UUID drain the platform's free tier from a script. Keyed per bot per
 * client so one noisy visitor cannot starve another tenant.
 *
 * Absent binding = no limiting, which is the pre-existing behaviour;
 * this must never be the reason a deploy fails.
 */
async function rateLimited(c: { env: Env; req: { header: (n: string) => string | undefined } }, botId: string): Promise<boolean> {
  const limiter = c.env.CHAT_LIMITER;
  if (!limiter) return false;

  const client = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? 'unknown';
  try {
    const { success } = await limiter.limit({ key: `${botId}:${client}` });
    return !success;
  } catch (err) {
    // Fail open: a limiter outage must not take chat down.
    console.error('[ratelimit] check failed, allowing:', err);
    return false;
  }
}

// ================================================================
// POST /v1/chat — buffered reply
// Kept as-is for embedded widgets that predate streaming, and for
// server-to-server callers that just want a string back.
// ================================================================
app.post('/v1/chat', async (c) => {
  const pre = await preflight(c);
  if (!pre.ok) return c.json({ error: pre.error }, pre.status);
  if (await rateLimited(c, pre.bot.id)) {
    return c.json({ error: 'Too many messages — please slow down.' }, 429);
  }

  const { provider, system, messages, sessionId, userMessage, bot, db } = pre;

  let rawReply: string;
  try {
    const result = await provider.generate({ system, messages });
    rawReply = result.text;
  } catch (err) {
    console.error(err);
    if (err instanceof ProviderError) {
      return c.json({ error: 'AI service error', kind: err.kind }, httpStatusFor(err));
    }
    return c.json({ error: 'AI service error' }, 502);
  }

  const { cleanReply } = extractLead(rawReply);
  await persistTurn(db, bot.id, sessionId, userMessage, cleanReply, rawReply);

  return c.json({ reply: cleanReply, sessionId });
});

// ================================================================
// POST /v1/chat/stream — Server-Sent Events
//
// Events:
//   delta  { text }               incremental, lead marker already stripped
//   done   { sessionId, usage }
//   error  { error, kind }        mid-stream failure
// ================================================================
app.post('/v1/chat/stream', async (c) => {
  const pre = await preflight(c);
  if (!pre.ok) return c.json({ error: pre.error }, pre.status);
  if (await rateLimited(c, pre.bot.id)) {
    return c.json({ error: 'Too many messages — please slow down.' }, 429);
  }

  const { provider, system, messages, sessionId, userMessage, bot, db } = pre;

  return streamSSE(c, async (stream) => {
    const filter = new LeadStreamFilter();
    let usage: Usage = { inputTokens: null, outputTokens: null };
    let visible = '';

    try {
      for await (const ev of provider.stream({ system, messages })) {
        if (ev.type === 'text') {
          const safe = filter.push(ev.delta);
          if (safe) {
            visible += safe;
            await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: safe }) });
          }
        } else if (ev.type === 'done') {
          usage = ev.usage;
        }
      }
    } catch (err) {
      console.error(err);
      const kind = err instanceof ProviderError ? err.kind : 'unknown';
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ error: 'AI service error', kind }) });
      return;
    }

    // Release anything held back that turned out not to be a marker.
    const { tail, raw } = filter.flush();
    if (tail) {
      visible += tail;
      await stream.writeSSE({ event: 'delta', data: JSON.stringify({ text: tail }) });
    }

    const reply = visible.trim();
    await persistTurn(db, bot.id, sessionId, userMessage, reply, raw);

    await stream.writeSSE({ event: 'done', data: JSON.stringify({ sessionId, usage }) });
  });
});

// ================================================================
// ADMIN ROUTES — all behind the auth middleware above.
//
// A bot in another org is invisible to RLS, so these return 404
// rather than 403. That is both simpler and better: a 403 would
// confirm the id exists.
// ================================================================

app.get('/v1/admin/me', async (c) => {
  try {
    const memberships = await getMemberships(c.get('db'));
    return c.json({
      userId: c.get('userId'),
      email:  c.get('email'),
      orgs:   memberships.map((m) => ({
        id:   m.organizations?.id ?? m.org_id,
        name: m.organizations?.name ?? null,
        slug: m.organizations?.slug ?? null,
        plan: m.organizations?.plan ?? null,
        role: m.role,
      })),
    });
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
});

/**
 * POST /v1/admin/orgs
 *
 * A user whose only organization is deleted used to be stranded: the
 * signup trigger fires on INSERT to auth.users and never again, and
 * RLS forbids inserting an org without a membership to authorise it.
 * The RPC is SECURITY DEFINER and derives the owner from auth.uid(),
 * so it can only ever mint a fresh empty org for the caller.
 */
app.post('/v1/admin/orgs', async (c) => {
  const body = await c.req.json<{ name?: string }>().catch(() => null);
  const name = body?.name?.trim();
  if (!name) return c.json({ error: '`name` is required' }, 400);
  if (name.length > 120) return c.json({ error: 'Name must be 120 characters or fewer' }, 400);

  try {
    const org = await createOrganization(c.get('db'), name);
    return c.json(org, 201);
  } catch (err) {
    console.error(err);
    return c.json({ error: 'Could not create organization' }, 502);
  }
});

// Vendor catalog — populates the provider picker in the dashboard.
app.get('/v1/admin/providers', (c) => {
  return c.json({
    vendors: Object.values(VENDORS).map((v) => ({
      id:                v.id,
      label:             v.label,
      costTier:          v.costTier,
      defaultChatModel:  v.defaultChatModel,
      defaultEmbedModel: v.defaultEmbedModel ?? null,
      embedDimensions:   v.embedDimensions ?? null,
      supportsEmbeddings: !!v.defaultEmbedModel,
      requiresKey:       !!v.keyEnv && !v.keyless,
      requiresBaseUrl:   !v.baseUrl && v.kind !== 'workers-ai',
      // Whether this deployment already holds a usable key.
      keyConfigured:     v.keyless || (!!v.keyEnv && !!(c.env as unknown as Record<string, string | undefined>)[v.keyEnv]),
    })),
  });
});

app.get('/v1/admin/bots', async (c) => {
  try {
    const bots = await listBots(c.get('db'));
    return c.json({ bots: bots.map(redactBotSecrets) });
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
});

app.post('/v1/admin/bots', async (c) => {
  let payload: BotCreatePayload;
  try { payload = await c.req.json<BotCreatePayload>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  for (const field of ['org_id', 'name', 'business_name'] as const) {
    if (!payload[field] || typeof payload[field] !== 'string') {
      return c.json({ error: `\`${field}\` is required` }, 400);
    }
  }

  // Validate origins at the source. A trailing slash or a stray path
  // breaks the exact match at request time, and from the widget side
  // that presents as an unexplained 403.
  const origins = validateOrigins(payload.allowed_origins);
  if (!origins.ok) return c.json({ error: origins.error }, 400);
  payload.allowed_origins = origins.origins;

  try {
    const bot = await createBot(c.get('db'), payload);
    return c.json(redactBotSecrets(bot), 201);
  } catch (err) {
    console.error(err);
    // RLS rejects an insert into an org the caller cannot write to.
    return c.json({ error: 'Could not create bot in that organization' }, 403);
  }
});

app.get('/v1/admin/bots/:id', async (c) => {
  try {
    const bot = await getBotForAdmin(c.get('db'), c.req.param('id'));
    if (!bot) return c.json({ error: 'Bot not found' }, 404);
    return c.json(redactBotSecrets(bot));
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
});

app.put('/v1/admin/bots/:id', async (c) => {
  let payload: BotUpdatePayload;
  try { payload = await c.req.json<BotUpdatePayload>(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  if ('allowed_origins' in payload) {
    const origins = validateOrigins(payload.allowed_origins);
    if (!origins.ok) return c.json({ error: origins.error }, 400);
    payload.allowed_origins = origins.origins;
  }
  if ('suggestions' in payload) {
    const chips = validateSuggestions(payload.suggestions);
    if (!chips.ok) return c.json({ error: chips.error }, 400);
    payload.suggestions = chips.suggestions;
  }

  try {
    // Masked/absent apiKeys are reconciled against what is stored inside
    // updateBot, so a settings save can never wipe a tenant's BYOK key.
    const updated = await updateBot(c.get('db'), c.req.param('id'), payload);
    if (!updated) return c.json({ error: 'Bot not found' }, 404);
    return c.json(redactBotSecrets(updated));
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
});

app.delete('/v1/admin/bots/:id', async (c) => {
  const botId = c.req.param('id');

  // Collected BEFORE the delete: documents cascade from the bot, so
  // after it there is nothing left to say which objects were theirs.
  // RLS is what makes this safe — a bot in another org lists nothing.
  const keys = c.env.DOCS
    ? await listDocumentKeys(c.get('db'), botId).catch((err) => {
        console.error('[r2] could not list objects for the deleted bot:', err);
        return [] as string[];
      })
    : [];

  try {
    const removed = await deleteBot(c.get('db'), botId);
    if (!removed) return c.json({ error: 'Bot not found' }, 404);
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }

  if (keys.length && c.env.DOCS) {
    const bucket = c.env.DOCS;
    // R2 takes at most 1000 keys per delete, and a bot with a corpus of
    // small PDFs can hold more than that inside the org storage cap.
    const batches: string[][] = [];
    for (let i = 0; i < keys.length; i += 1000) batches.push(keys.slice(i, i + 1000));

    c.executionCtx.waitUntil(
      Promise.all(batches.map((batch) =>
        bucket.delete(batch).catch((err) => console.error('[r2] bot object sweep failed:', err)),
      )),
    );
  }

  return c.body(null, 204);
});

app.get('/v1/admin/bots/:id/leads', async (c) => {
  try {
    const leads = await getLeads(c.get('db'), c.req.param('id'));
    return c.json({ leads });
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
});

// ================================================================
// POST /v1/admin/bots/:id/preview
//
// Try a bot without deploying it. Before this there was no way to test
// one at all: the chat endpoint enforces the origin lock, so you had to
// paste the snippet onto a site you controlled at the right hostname.
//
// Auth replaces the origin lock as the gate, and the turn is ephemeral
// — no history is read, nothing is persisted, and a lead cannot be
// captured from your own testing.
// ================================================================
app.post('/v1/admin/bots/:id/preview', async (c) => {
  const botId = c.req.param('id');

  // RLS decides whether this user may see the bot at all; without this
  // the service-role preflight below would happily run any bot by id.
  const owned = await getBotForAdmin(c.get('db'), botId).catch(() => null);
  if (!owned) return c.json({ error: 'Bot not found' }, 404);

  const body = await c.req.json<{ message?: string; history?: Message[] }>().catch(() => null);
  if (!body?.message?.trim()) return c.json({ error: '`message` must be a non-empty string' }, 400);

  const pre = await preflight(
    { env: c.env, req: { json: async <T,>() => ({ botId, message: body.message }) as T, header: c.req.header.bind(c.req) } },
    { skipOriginCheck: true, ephemeral: true },
  );
  if (!pre.ok) return c.json({ error: pre.error }, pre.status);

  // The client owns preview history, so a multi-turn test works without
  // writing anything to the conversations table.
  const history = Array.isArray(body.history)
    ? body.history.filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string').slice(-20)
    : [];

  try {
    const result = await pre.provider.generate({
      system: pre.system,
      messages: [...history, { role: 'user', content: pre.userMessage }],
    });
    const { cleanReply } = extractLead(result.text);
    return c.json({
      reply: cleanReply,
      usage: result.usage,
      model: result.model,
      vendor: pre.provider.vendor,
    });
  } catch (err) {
    console.error(err);
    if (err instanceof ProviderError) {
      return c.json({ error: err.message, kind: err.kind }, httpStatusFor(err));
    }
    return c.json({ error: 'AI service error' }, 502);
  }
});

// ================================================================
// Knowledge sources (RAG)
//
// Creation runs as the user so RLS validates org membership; ingestion
// then runs as service_role because chunks are derived data no tenant
// may write. Ingestion is kicked off with waitUntil so the request
// returns immediately — the client polls document.status.
// ================================================================
app.get('/v1/admin/bots/:id/documents', async (c) => {
  try {
    const docs = await listDocuments(c.get('db'), c.req.param('id'));
    return c.json({ documents: docs });
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
});

app.post('/v1/admin/bots/:id/documents', async (c) => {
  const botId = c.req.param('id');

  let body: { source?: string; title?: string; url?: string; content?: string };
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  const source = body.source;
  if (source !== 'text' && source !== 'url' && source !== 'markdown') {
    return c.json({ error: "`source` must be 'text', 'url' or 'markdown'" }, 400);
  }
  if (source === 'url' && !body.url?.trim())      return c.json({ error: '`url` is required for a url source' }, 400);
  if (source !== 'url' && !body.content?.trim())  return c.json({ error: '`content` is required' }, 400);

  const title = (body.title?.trim() || body.url?.trim() || 'Untitled').slice(0, 300);

  // The bot must be visible to this user before anything is created —
  // RLS would reject the insert anyway, but a 404 is clearer than the
  // generic constraint error PostgREST returns.
  const bot = await getBotForAdmin(c.get('db'), botId).catch(() => null);
  if (!bot) return c.json({ error: 'Bot not found' }, 404);

  let doc: Document;
  try {
    doc = await createDocument(c.get('db'), {
      bot_id:  botId,
      source,
      title,
      url:     source === 'url' ? body.url!.trim() : null,
      content: source === 'url' ? null : body.content!.trim(),
    });
  } catch (err) {
    console.error(err);
    return c.json({ error: 'Could not create document' }, 403);
  }

  // Fire-and-forget: embedding a document takes seconds to minutes and
  // must not hold the request open.
  c.executionCtx.waitUntil(
    ingestDocument(c.env, serviceDb(c.env), doc.id, bot)
      .catch((err) => console.error('[rag] ingest failed:', err)),
  );

  return c.json(doc, 202);
});

// ================================================================
// POST /v1/admin/bots/:id/documents/upload
//
// A file source. Multipart rather than a presigned PUT straight to R2:
// the ceiling is 10 MB (see MAX_FILE_BYTES for why that number), which
// is small enough that going through the Worker costs nothing and
// avoids putting S3 credentials and a bucket CORS policy in the browser.
//
// The order below is load-bearing. Validation happens before the object
// is written, the object is written before the row exists, and a failed
// insert deletes the object again — otherwise a rejected upload leaves
// bytes in the bucket that nothing references and no tenant can reach.
// ================================================================
app.post('/v1/admin/bots/:id/documents/upload', async (c) => {
  const botId = c.req.param('id');

  const bucket = c.env.DOCS;
  if (!bucket)   return c.json({ error: 'File uploads are not enabled on this deployment' }, 501);
  if (!c.env.AI) return c.json({ error: 'File conversion is not enabled on this deployment' }, 501);

  // Reject an oversized body before Hono buffers it into memory. The
  // slack covers multipart framing, which is a few hundred bytes.
  const declaredLength = Number(c.req.header('content-length') ?? 0);
  if (declaredLength > MAX_FILE_BYTES + 64 * 1024) {
    return c.json({ error: `That file is too large. The limit is ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB.` }, 413);
  }

  const bot = await getBotForAdmin(c.get('db'), botId).catch(() => null);
  if (!bot) return c.json({ error: 'Bot not found' }, 404);

  // `c.req.raw`, not `c.req.formData()`: Hono types its own helper for
  // validated string forms, so its `get` returns `string | null` and the
  // uploaded file narrows away to never. The underlying Request gives
  // the runtime's real FormData, where a part can be a File.
  let form: FormData;
  try { form = await c.req.raw.formData(); }
  catch { return c.json({ error: 'Expected a multipart/form-data upload with a `file` part' }, 400); }

  // Narrowed by shape rather than `instanceof File`: which ambient File
  // is in scope depends on lib settings, and this needs neither.
  const file = form.get('file');
  if (!file || typeof file === 'string') return c.json({ error: '`file` is required' }, 400);
  if (file.size === 0)                   return c.json({ error: 'That file is empty' }, 400);
  if (file.size > MAX_FILE_BYTES) {
    return c.json({ error: `That file is ${Math.round(file.size / 1024 / 1024)} MB. The limit is ${Math.floor(MAX_FILE_BYTES / 1024 / 1024)} MB.` }, 413);
  }

  const bytes = await file.arrayBuffer();

  // Three signals must agree before these bytes are stored anywhere:
  // toMarkdown will happily hand back a .zip as "markdown", so this is
  // the only thing keeping binary noise out of the corpus.
  const detected = detectFileType(file.name, file.type, new Uint8Array(bytes.slice(0, SNIFF_BYTES)));
  if (!detected.ok) return c.json({ error: detected.error, supported: supportedList() }, 415);

  // Advisory: the authority is the trigger in 008_files.sql. Checked
  // here so a tenant over quota reads a sentence rather than a
  // constraint violation, and so nothing is written for a doomed insert.
  try {
    const used = await orgStorageBytes(c.get('db'), bot.org_id);
    if (used + file.size > ORG_STORAGE_CAP_BYTES) {
      return c.json({
        error: `Storage limit reached — ${mb(used)} of ${mb(ORG_STORAGE_CAP_BYTES)} used. Delete a source to free space.`,
        usedBytes: used,
        capBytes:  ORG_STORAGE_CAP_BYTES,
      }, 413);
    }
  } catch (err) {
    // The trigger still backstops this, so a failed pre-check is not
    // a reason to refuse the upload.
    console.error('[upload] storage pre-check failed (non-fatal):', err);
  }

  const title = ((form.get('title') as string | null)?.trim() || file.name).slice(0, 300);
  const key   = objectKeyFor(bot.org_id, botId, detected.type.extensions[0]);

  try {
    await bucket.put(key, bytes, {
      httpMetadata:   { contentType: detected.type.mime },
      // Not read by anything — it is here so an operator staring at a
      // bucket listing can tell whose object they are looking at.
      customMetadata: { orgId: bot.org_id, botId, filename: file.name.slice(0, 200) },
    });
  } catch (err) {
    console.error('[upload] R2 put failed:', err);
    return c.json({ error: 'Could not store that file' }, 502);
  }

  let doc: Document;
  try {
    doc = await createDocument(c.get('db'), {
      bot_id:     botId,
      source:     'file',
      title,
      url:        null,
      content:    null,
      r2_key:     key,
      mime_type:  detected.type.mime,
      size_bytes: file.size,
    });
  } catch (err) {
    // Nothing references the object now, so it must not survive.
    await bucket.delete(key).catch((e) => console.error('[upload] orphan cleanup failed:', e));

    const message = err instanceof Error ? err.message : String(err);
    console.error('[upload] document insert failed:', message);

    if (/Storage limit reached/.test(message)) {
      return c.json({ error: message.replace(/^.*?(Storage limit reached)/s, '$1').slice(0, 300) }, 413);
    }
    // Deployed ahead of its migration. Say so — the generic 403 below
    // reads like a permissions problem and sends whoever is debugging
    // it looking at RLS instead of at the schema.
    if (/r2_key|mime_type|size_bytes|documents_source_check/.test(message)) {
      return c.json({ error: 'File uploads need database migration 008_files.sql, which has not been applied yet.' }, 501);
    }
    return c.json({ error: 'Could not create document' }, 403);
  }

  c.executionCtx.waitUntil(
    ingestDocument(c.env, serviceDb(c.env), doc.id, bot)
      .catch((err) => console.error('[rag] file ingest failed:', err)),
  );

  return c.json(doc, 202);
});

/** Bytes as a round number of MB, for messages a tenant reads. */
function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024)} MB`;
}

app.post('/v1/admin/documents/:docId/reindex', async (c) => {
  const docId = c.req.param('docId');

  const doc = await getDocumentForAdmin(c.get('db'), docId).catch(() => null);
  if (!doc) return c.json({ error: 'Document not found' }, 404);

  const bot = await getBotForAdmin(c.get('db'), doc.bot_id).catch(() => null);
  if (!bot) return c.json({ error: 'Bot not found' }, 404);

  c.executionCtx.waitUntil(
    ingestDocument(c.env, serviceDb(c.env), docId, bot)
      .catch((err) => console.error('[rag] reindex failed:', err)),
  );

  return c.json({ ...doc, status: 'pending' }, 202);
});

app.get('/v1/admin/documents/:docId/chunks', async (c) => {
  try {
    const doc = await getDocumentForAdmin(c.get('db'), c.req.param('docId'));
    if (!doc) return c.json({ error: 'Document not found' }, 404);
    const chunks = await listChunks(c.get('db'), c.req.param('docId'));
    return c.json({ chunks });
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
});

app.delete('/v1/admin/documents/:docId', async (c) => {
  let removed: Document | null;
  try {
    // Chunks cascade from the document row.
    removed = await deleteDocument(c.get('db'), c.req.param('docId'));
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }

  if (!removed) return c.json({ error: 'Document not found' }, 404);

  // Postgres cannot cascade into a bucket. Deleted after the row rather
  // than before it, so a failed delete leaves a readable document
  // instead of a row pointing at bytes that are gone.
  if (removed.r2_key && c.env.DOCS) {
    const key = removed.r2_key;
    c.executionCtx.waitUntil(
      c.env.DOCS.delete(key).catch((err) => console.error(`[r2] could not delete ${key}:`, err)),
    );
  }

  return c.body(null, 204);
});

app.get('/v1/admin/bots/:id/stats', async (c) => {
  const botId = c.req.param('id');

  // Clamped: the window drives how many rows are pulled, and an
  // unbounded `days` would let one request try to read the whole table.
  const raw = Number(c.req.query('days') ?? 30);
  const days = Number.isFinite(raw) ? Math.min(90, Math.max(7, Math.trunc(raw))) : 30;

  // Reach back two windows so the comparison period can be counted from
  // the same fetch; buildStats sorts rows into current vs prior.
  const since = new Date(Date.now() - days * 2 * 86_400_000).toISOString();

  try {
    const db = c.get('db');
    const [messages, leads, documents] = await Promise.all([
      getStatMessages(db, botId, since),
      getStatLeads(db, botId, since),
      getStatDocuments(db, botId),
    ]);
    return c.json(buildStats({
      days, messages, leads, documents,
      caps: { messages: STATS_MESSAGE_CAP, leads: STATS_LEAD_CAP },
    }));
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
});

app.get('/v1/admin/bots/:id/conversations', async (c) => {
  try {
    const convos = await getConversations(c.get('db'), c.req.param('id'));
    return c.json({ conversations: convos });
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
});


export default app;
