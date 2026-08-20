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
  setBotLogoKey,
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
  listFaqItems,
  getFaqItem,
  createFaqItem,
  updateFaqItem,
  deleteFaqItem,
  reorderFaqItems,
  getFaqDocument,
  ensureFaqDocument,
  setKnowledgeMigrated,
  countSessionMessages,
  countTrailingMisses,
  getStatMessages,
  getStatLeads,
  getStatDocuments,
  logRetrieval,
  getRetrievalLog,
  pruneRetrievalLog,
  STATS_MESSAGE_CAP,
  STATS_LEAD_CAP,
  RETRIEVAL_LOG_CAP,
  type ServiceDb,
  type UserDb,
  type RetrievalLogInsert,
} from './supabase';
import {
  ingestDocument, ingestFaq, ragConfigFor, AlreadyIndexing, CLAIM_STALE_MS,
} from './rag/ingest';
import {
  detectFileType,
  objectKeyFor,
  supportedList,
  MAX_FILE_BYTES,
  ORG_STORAGE_CAP_BYTES,
  SNIFF_BYTES,
} from './rag/files';
import {
  retrieve, renderContext, selectContext, retrievalLogRow,
  type RetrievedChunk, type RetrievalOutcome,
} from './rag/retrieve';
import { parseFaqText } from './rag/chunk';
import {
  validateWidgetConfig, validateBehaviorConfig, validateLeadConfig, validateFaqItem,
  behaviorConfigFor, widgetConfigFor, widgetPublicConfig, leadConfigFor,
  capPromptText, LIMITS,
} from './config';
import {
  detectLogoType,
  logoKeyFor,
  logoUrlFor,
  supportedLogoList,
  LOGO_SNIFF_BYTES,
  MAX_LOGO_BYTES,
} from './logo';
import { buildSystemPrompt } from './prompt';
import { verifyToken, bearerFrom, AuthError } from './auth';
import {
  resolveChatProvider,
  resolveEmbeddingProvider,
  ProviderError,
  httpStatusFor,
  VENDORS,
  type ChatProvider,
  type Message,
  type Usage,
} from './providers';
import { extractLead, defangLeadMarker, type ExtractedLead } from './leads';
import { notifyLead, webhookHost } from './notify';
import { buildStats, buildMissReport } from './stats';
import { LeadStreamFilter } from './lead-stream';
import { issueSessionId, verifySessionId } from './session';
import { isOriginAllowed, validateOrigins, validateSuggestions } from './origin';
import type {
  Env, Bot, Document, ChatRequest, BotUpdatePayload, BotCreatePayload, LeadConfig,
} from './types';

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
 * This deployment's own origin, taken from the request rather than
 * configured. The Worker answers on workers.dev, on a custom domain and
 * on localhost under `wrangler dev`, and a logo URL has to be right on
 * all three without a var to keep in step.
 */
const origin = (c: { req: { url: string } }): string => new URL(c.req.url).origin;

/**
 * Tenant-supplied API keys live in provider_config/embedding_config.
 * The dashboard needs to know a key is set without being handed it.
 *
 * The key is REMOVED rather than replaced with a placeholder. An
 * earlier version sent back "••••1234" and treated that string on the
 * way in as "unchanged" — which quietly destroyed the stored key the
 * moment anything re-encoded those multi-byte bullets. Absence is not
 * encoding-dependent, so absence is the signal.
 *
 * widget_config.logo_key gets the same treatment for a different
 * reason: it names an object in a bucket shared with every tenant's
 * documents, and the dashboard has no use for it — what a settings
 * screen needs is a URL it can put in an <img>. Sending the URL instead
 * of the key also keeps the key out of the form's round-trip, which is
 * what validateWidgetConfig rejects on the way back in.
 */
function redactBotSecrets(bot: Bot, origin: string): Record<string, unknown> {
  const scrub = (cfg: { apiKey?: string } | null | undefined) => {
    if (!cfg) return cfg;
    const { apiKey, ...rest } = cfg;
    return { ...rest, hasApiKey: !!apiKey, apiKeyLast4: apiKey ? apiKey.slice(-4) : null };
  };

  const widget = bot.widget_config
    ? (() => { const { logo_key, ...rest } = bot.widget_config; void logo_key; return rest; })()
    : bot.widget_config;

  // lead_config.webhook_url is a third case, and the one with the
  // sharpest edge: a Slack or Teams incoming-webhook URL is a bearer
  // credential — anyone who has it can post into that channel — so it
  // is removed for the same reason apiKey is, not merely tidied away
  // like logo_key. What the settings screen needs is enough to say
  // "posting to hooks.slack.com" and offer a Remove button, which is
  // exactly these two derived fields and nothing more.
  const lead = bot.lead_config
    ? (() => {
        const { webhook_url, ...rest } = bot.lead_config;
        return { ...rest, has_webhook: !!webhook_url, webhook_host: webhookHost(webhook_url) };
      })()
    : bot.lead_config;

  return {
    ...bot,
    provider_config:  scrub(bot.provider_config),
    embedding_config: scrub(bot.embedding_config),
    widget_config:    widget,
    lead_config:      lead,
    logo_url:         logoUrlFor(bot, origin),
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
    // Only the keys a tenant actually set. Defaults are widget.js's to
    // own — a second copy of them here is a second thing to keep in
    // sync, and an older widget ignores this object entirely.
    widget:       widgetPublicConfig(bot, logoUrlFor(bot, origin(c))),
  });
});

// ================================================================
// GET /v1/bots/:id/logo
//
// Public, and the only route in this Worker that hands a browser bytes
// a tenant uploaded. Knowledge-base files are converted to text and
// never served, so R2 has no public read path — this route is it.
//
// Cached immutably and for a year, which is safe because a replacement
// logo is written under a NEW key (see logoKeyFor): the URL changes, so
// no cache anywhere ever has to be invalidated.
// ================================================================
app.get('/v1/bots/:id/logo', async (c) => {
  const bucket = c.env.DOCS;
  if (!bucket) return c.json({ error: 'Not found' }, 404);

  let bot: Bot | null;
  try { bot = await getBotForChat(serviceDb(c.env), c.req.param('id')); }
  catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }

  const key = bot && widgetConfigFor(bot).logo_key;
  if (!key) return c.json({ error: 'Not found' }, 404);

  let object: R2Object | R2ObjectBody | null;
  // onlyIf handles the conditional request, so a repeat visitor pays
  // for a 304 rather than for the image again.
  try { object = await bucket.get(key, { onlyIf: c.req.raw.headers }); }
  catch (err) { console.error('[logo] R2 get failed:', err); return c.json({ error: 'Not found' }, 404); }
  if (!object) return c.json({ error: 'Not found' }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  // These bytes came from a tenant. Never let a browser decide for
  // itself what they are — the upload sniffed them, that stands.
  headers.set('x-content-type-options', 'nosniff');

  // No body means the precondition matched: nothing to send.
  if (!('body' in object) || !object.body) return new Response(null, { status: 304, headers });
  return new Response(object.body, { headers });
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
  | {
      ok: true; bot: Bot; db: ServiceDb; provider: ChatProvider; system: string;
      messages: Message[]; sessionId: string; userMessage: string;
      /** Document titles behind the retrieved context, when the bot has
       *  citations switched on. Empty otherwise — including when
       *  retrieval ran and simply found nothing. */
      citations: string[];
      /** True when the bot HAS a corpus and this turn retrieved nothing
       *  above the similarity threshold. Recorded on the assistant row
       *  so the escalation counter has something deterministic to count;
       *  undefined when escalation is off, so a Worker running ahead of
       *  009 never writes the column. */
      retrievalMiss?: boolean;
      /** One row for the retrieval log, or undefined when retrieval did
       *  not run at all. Computed here because preparePrompt is the only
       *  place that knows all of it; written from `waitUntil` by the
       *  routes, never on the request path. See logRetrieval. */
      retrieval?: RetrievalLogInsert;
      /** This bot's lead settings, read once here. The routes need them
       *  for the marker shape, the tag and the webhook, and all three
       *  have to agree with the prompt that was actually sent. */
      lead: LeadConfig;
    };

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
  // Length is checked on the raw string, before the trim below: a
  // megabyte of whitespace costs the same to receive as a megabyte of
  // prose. Ahead of every database call on purpose — nothing about
  // this needs to know which bot it is.
  if (message.length > LIMITS.chatMessage) {
    return { ok: false, status: 400, error: `\`message\` must be ${LIMITS.chatMessage} characters or fewer` };
  }
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

  const userMessage = defangLeadMarker(message.trim());

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
  //
  // The OUTCOME is kept now, not just the rendered text. "This bot has
  // documents and none of them cleared the similarity threshold" is the
  // only deterministic, language-independent signal available that the
  // bot could not answer — everything in behavior_config is built on it.
  let context = '';
  let hasCorpus = false;
  // The chunks that were actually RENDERED, in the order they were
  // numbered — not everything retrieval returned. The context budget
  // can drop a low-ranked chunk, and a citation list built from the
  // full result set would then name a document the model never saw.
  // Everything downstream reads this one. See docs/rag-hardening.md B6.
  let rendered: RetrievedChunk[] = [];
  let outcome: RetrievalOutcome | null = null;
  try {
    // S2: a field read, not a round trip. `chunk_count` is maintained
    // by a statement-level trigger on `chunks` (013), and the bot row
    // was already fetched above — so the "does this bot have a corpus"
    // query that ran before every single turn is now free.
    //
    // UNDEFINED IS UNKNOWN, NOT ZERO. A Worker running ahead of 013
    // gets no column back, and reading that as "no corpus" would switch
    // retrieval off for every bot on the platform. It falls back to the
    // query, which is exactly the pre-013 behaviour.
    hasCorpus = typeof bot.chunk_count === 'number'
      ? bot.chunk_count > 0
      : await hasChunks(db, botId);
    if (hasCorpus) {
      // `retrieve` already tried the lexical fallback by the time it
      // returns, so its outcome is the final answer for this turn. That
      // ordering is load-bearing: computing the miss from the vector
      // search alone would count every lexical save as a miss, and the
      // escalation below would then fire on questions the bot has just
      // answered correctly.
      outcome = await retrieve(c.env, db, bot, userMessage);
      const budget = ragConfigFor(bot).context_chars;
      rendered = selectContext(outcome.chunks, budget);
      // Already selected, so this re-budgets nothing.
      context = renderContext(rendered, budget);
    }
  } catch (err) {
    console.error('[rag] skipped (non-fatal):', err);
  }

  // A STALE INDEX IS NOT A MISS, and getting that wrong is worse than
  // the drift it reports. The corpus was built by a different embedding
  // model, so nothing was searched at all — counting it as a miss would
  // fire `fallback_message` on literally every turn and escalate every
  // conversation, on a bot that is otherwise answering perfectly well
  // from its knowledge-base fields. Drift is closer to "this bot has no
  // corpus" than to "this bot could not answer", and it is logged as
  // its own thing rather than folded into the miss rate. See B2.
  const staleIndex = outcome?.skipped === 'stale-index';

  // "The model was shown nothing from this business's own material" —
  // which is what the fallback message and the escalation below both
  // mean by a miss, and which is now reachable: before B1 the floor sat
  // below the embedder's noise floor and never rejected anything, so
  // this was permanently false and all three features were dead.
  const missedRetrieval = hasCorpus && !staleIndex && rendered.length === 0;

  // The retrieval log row (M1). Which turns get logged is decided in
  // retrievalLogRow, next to the outcome it describes and unit-tested
  // there — a greeting logged as a miss and a drifted index logged as a
  // miss are both silent corruptions of the only number the report
  // exists to produce.
  //
  // Preview traffic gets a null session rather than the literal
  // 'preview': it is a real query worth counting, but it belongs to no
  // visitor's conversation.
  const retrievalRow = retrievalLogRow(outcome, {
    botId:      bot.id,
    sessionId:  opts.ephemeral ? null : resolvedSession,
    query:      userMessage,
    renderedCount: rendered.length,
  }) ?? undefined;

  const behavior = behaviorConfigFor(bot);
  const widget = widgetConfigFor(bot);
  const lead = leadConfigFor(bot);
  const situational: string[] = [];

  // The `after_messages` lead trigger, resolved to a threshold or to 0.
  // Zero for every other trigger — `intent` and `always` are settled
  // entirely inside buildSystemPrompt, because they are standing rules
  // rather than facts about this particular turn.
  const leadAfter = lead.enabled !== false && lead.trigger === 'after_messages'
    ? (lead.trigger_after_messages ?? 0)
    : 0;

  // ── Configurable fallback wording ──────────────────────────────
  // Appended as a preference, never substituted for the model's reply:
  // replacing output wholesale would break streaming and answer a
  // Spanish question in English.
  if (missedRetrieval && behavior.fallback_message) {
    situational.push(
      'Nothing in this business\'s own material answers the visitor\'s question. Do not guess. '
      + `Convey this, adapted to their language: "${behavior.fallback_message}"`,
    );
  }

  // ── Length and escalation ──────────────────────────────────────
  // Both are off by default and both cost a query, so neither runs
  // unless a tenant switched it on. Failures are non-fatal: an
  // escalation that does not fire is a missed nicety, not a broken
  // conversation.
  if (!opts.ephemeral && trusted) {
    const capMessages = behavior.max_messages ?? 0;

    // ONE count for both settings that need it. The cap has to cover
    // whichever threshold is higher: countSessionMessages stops reading
    // at the cap, so sizing it to the lower one would hand the higher
    // one a number that can never reach it.
    let sessionMessages = 0;
    if (capMessages > 0 || leadAfter > 0) {
      try {
        sessionMessages = await countSessionMessages(
          db, botId, resolvedSession, Math.max(capMessages, leadAfter) + 1,
        );
      } catch (err) { console.error('[behavior] message count failed (non-fatal):', err); }
    }

    if (capMessages > 0 && sessionMessages >= capMessages) {
      situational.push(
        'This conversation has run long without resolving. Warmly offer to put the visitor '
        + 'in touch with a member of the team, and ask for the best way to reach them.',
      );
    }

    // The one lead trigger that is a fact rather than an instruction:
    // the row count is real, so this fires whether or not the model
    // would have judged the moment right on its own.
    if (leadAfter > 0 && sessionMessages >= leadAfter) {
      situational.push(
        'The visitor has been talking for a while now. If you do not already have their contact '
        + 'details, this is a good moment to follow the Lead Capture steps — offer once, warmly, '
        + 'and do not press if they would rather keep browsing.',
      );
    }

    if (behavior.escalate_after_misses && behavior.escalate_after_misses > 0 && missedRetrieval) {
      try {
        const threshold = behavior.escalate_after_misses;
        // The stored streak covers previous turns; this one is the
        // current miss, which is not persisted yet.
        const previous = await countTrailingMisses(db, botId, resolvedSession, threshold);
        if (previous + 1 >= threshold) {
          situational.push(
            'Several questions in a row now have had no answer in this business\'s material. '
            + 'Say so plainly, apologise once, and offer to connect the visitor with a person.',
          );
        }
      } catch (err) { console.error('[behavior] miss streak failed (non-fatal):', err); }
    }
  }

  // ── Citations ──────────────────────────────────────────────────
  // Off by default, and since 012 free: the title rides on the row
  // match_chunks already returned, so this is no longer a second round
  // trip on the hot path of every turn with citations on. That fold is
  // the half of S2 B6 could not take without changing the signature of
  // a versioned SQL function.
  //
  // ONE ENTRY PER RENDERED EXCERPT, in marker order: citations[n-1] is
  // what the model's "[n]" refers to. Duplicates are kept on purpose —
  // three chunks from one document are three markers pointing at that
  // document, and collapsing them would renumber the list out of step
  // with the prompt the model was given.
  //
  // An absent title reads as '' exactly as the lookup version did, so
  // a Worker running ahead of 012 degrades to unnamed citations rather
  // than to a crash.
  const citations: string[] = widget.show_citations
    ? rendered.map((ch) => ch.document_title ?? '')
    : [];

  return {
    ok:       true,
    bot,
    db,
    provider,
    system:   buildSystemPrompt(bot, context, situational),
    // The current turn is not yet persisted, so append it to the window.
    messages: [...history, { role: 'user', content: userMessage }],
    sessionId: resolvedSession,
    userMessage,
    citations,
    // Carried out of here rather than re-read in the routes: it decides
    // the marker shape extractLead parses, so both must come from the
    // same snapshot of the bot.
    lead,
    // Only recorded when the feature that reads it is on — which also
    // guarantees behavior_config exists, and therefore that 009 ran.
    retrievalMiss: behavior.escalate_after_misses ? missedRetrieval : undefined,
    retrieval: retrievalRow,
  };
}

/**
 * Persist the exchange and any captured lead. Never throws — a logging
 * failure must not cost the visitor their answer.
 *
 * Returns the lead it saved, or null. The caller needs it to send the
 * notification, and the notification deliberately does NOT happen here:
 * this function is awaited on the request path, so a webhook fetch
 * inside it would put a third party's latency on the visitor's reply.
 * See the note at the top of src/notify.ts.
 */
async function persistTurn(
  db: ServiceDb,
  botId: string,
  sessionId: string,
  userMessage: string,
  reply: string,
  rawReply: string,
  leadConfig: LeadConfig,
  retrievalMiss?: boolean,
): Promise<ExtractedLead | null> {
  const { lead } = extractLead(rawReply, leadConfig.fields);
  // Recorded per lead rather than read back from the bot at display
  // time, because a tenant who later edits the consent wording must not
  // retroactively change what every past lead was asked.
  const consentGiven = leadConfig.consent_text ? true : null;
  let saved: ExtractedLead | null = null;

  if (lead) {
    try {
      await saveLead(db, botId, sessionId, lead, { tag: leadConfig.tag ?? null, consentGiven });
      saved = lead;
    } catch (err) { console.error('saveLead failed (non-fatal):', err); }
  }
  try {
    await logMessage(db, { bot_id: botId, session_id: sessionId, role: 'user',      content: userMessage });
    await logMessage(db, {
      bot_id: botId, session_id: sessionId, role: 'assistant', content: reply,
      // Omitted entirely unless escalation is on, so this insert stays
      // valid against a database that has not had 009 applied.
      ...(retrievalMiss !== undefined && { retrieval_miss: retrievalMiss }),
    });
  } catch (err) { console.error('logMessage failed (non-fatal):', err); }

  // Only a lead that actually reached Postgres is announced. Notifying
  // on a failed insert would tell a sales team about a lead they will
  // never find in the dashboard.
  return saved;
}

/**
 * Hand a captured lead to the configured webhook, off the request path.
 *
 * Returns a promise for waitUntil rather than being called for effect,
 * so the Worker stays alive until the POST finishes. notifyLead itself
 * never rejects, so nothing downstream needs a catch.
 */
function announceLead(
  env: Env, bot: Bot, cfg: LeadConfig, lead: ExtractedLead, sessionId: string,
): Promise<void> {
  return notifyLead(cfg, {
    botName: bot.name,
    businessName: bot.business_name,
    lead,
    sessionId,
    tag: cfg.tag ?? null,
    consentGiven: cfg.consent_text ? true : null,
    bookingUrl: cfg.booking_url ?? null,
    capturedAt: new Date().toISOString(),
  }, { apiKey: env.RESEND_API_KEY, from: env.LEAD_EMAIL_FROM });
}

/**
 * Abuse guard for the public chat path.
 *
 * Not monetisation — every bot now shares one Gemini key and one Workers
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

  const {
    provider, system, messages, sessionId, userMessage, bot, db,
    citations, retrievalMiss, retrieval, lead,
  } = pre;

  // Off the request path, beside announceLead and for the same reason
  // the note at the top of src/notify.ts gives: a visitor's reply must
  // never wait on bookkeeping. Dispatched before generation because the
  // row is already known and an AI failure below is not a reason to
  // lose the record that the question was asked.
  if (retrieval) c.executionCtx.waitUntil(logRetrieval(db, retrieval));

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

  const { cleanReply } = extractLead(rawReply, lead.fields);
  const captured = await persistTurn(
    db, bot.id, sessionId, userMessage, cleanReply, rawReply, lead, retrievalMiss,
  );
  if (captured) c.executionCtx.waitUntil(announceLead(c.env, bot, lead, captured, sessionId));

  // Additive: a widget that predates citations ignores the field.
  return c.json({ reply: cleanReply, sessionId, citations });
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

  const {
    provider, system, messages, sessionId, userMessage, bot, db,
    citations, retrievalMiss, retrieval, lead,
  } = pre;

  // Dispatched before the stream opens rather than inside it: once
  // streamSSE has started, the response is committed, and there is
  // nothing to be gained by holding a row that is already complete.
  if (retrieval) c.executionCtx.waitUntil(logRetrieval(db, retrieval));

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
    const captured = await persistTurn(
      db, bot.id, sessionId, userMessage, reply, raw, lead, retrievalMiss,
    );
    // Dispatched before `done` is written rather than after: waitUntil
    // registers the work, it does not wait for it, so the visitor sees
    // the stream close at exactly the same moment either way.
    if (captured) c.executionCtx.waitUntil(announceLead(c.env, bot, lead, captured, sessionId));

    // Citations ride on `done` rather than as their own event: they are
    // known before the first token and belong to the finished reply, so
    // a new event type would only give older widgets something else to
    // ignore.
    await stream.writeSSE({ event: 'done', data: JSON.stringify({ sessionId, usage, citations }) });
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
    return c.json({ bots: bots.map((b) => redactBotSecrets(b, origin(c))) });
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

  // One bot per organization (supabase/014). Signup provisions it, so
  // this path only ever runs as recovery — an org whose bot was
  // deleted. Checked here as well as by the unique index because that
  // index is skipped on a database that already holds a second bot,
  // and because a 409 with a sentence in it beats PostgREST's
  // duplicate-key error reaching the dashboard verbatim.
  //
  // RLS scopes listBots to the caller's own orgs, so this cannot be
  // used to probe whether some other tenant exists.
  try {
    const existing = await listBots(c.get('db'));
    if (existing.some((b) => b.org_id === payload.org_id)) {
      return c.json({ error: 'This organization already has a bot.' }, 409);
    }
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }

  try {
    const bot = await createBot(c.get('db'), payload);
    return c.json(redactBotSecrets(bot, origin(c)), 201);
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
    return c.json(redactBotSecrets(bot, origin(c)));
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
  if ('widget_config' in payload) {
    const widget = validateWidgetConfig(payload.widget_config);
    if (!widget.ok) return c.json({ error: widget.error }, 400);
    payload.widget_config = widget.value;
  }
  if ('behavior_config' in payload) {
    const behavior = validateBehaviorConfig(payload.behavior_config);
    if (!behavior.ok) return c.json({ error: behavior.error }, 400);
    payload.behavior_config = behavior.value;
  }
  if ('lead_config' in payload) {
    const lead = validateLeadConfig(payload.lead_config);
    if (!lead.ok) return c.json({ error: lead.error }, 400);
    payload.lead_config = lead.value;
  }

  // The two text fields still inlined into every system prompt. Trimmed
  // and truncated rather than rejected — a settings save that fails on
  // length takes every other edit in the form down with it — but the
  // truncation is reported, because storing something other than what
  // was sent and saying nothing is the worse half of that trade.
  const truncated = capPromptText(payload as unknown as Record<string, unknown>);

  try {
    // Masked/absent apiKeys are reconciled against what is stored inside
    // updateBot, so a settings save can never wipe a tenant's BYOK key.
    const updated = await updateBot(c.get('db'), c.req.param('id'), payload);
    if (!updated) return c.json({ error: 'Bot not found' }, 404);
    return c.json({
      ...redactBotSecrets(updated, origin(c)),
      ...(truncated.length && { truncated }),
    });
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

  // The logo is not a document, so it is not in that list — and it
  // would otherwise sit in the bucket forever with nothing naming it.
  if (c.env.DOCS) {
    const bot = await getBotForAdmin(c.get('db'), botId).catch(() => null);
    const logoKey = bot && widgetConfigFor(bot).logo_key;
    if (logoKey) keys.push(logoKey);
  }

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

// ================================================================
// POST /v1/admin/bots/:id/logo
//
// Narrower than the document upload on purpose: three raster formats,
// 512 KB, no SVG (see src/logo.ts for why). Unlike a document, this is
// not a knowledge source — it gets a `logos/` prefix and is deliberately
// not counted against the org storage cap, whose whole mechanism lives
// on the documents table.
// ================================================================
app.post('/v1/admin/bots/:id/logo', async (c) => {
  const botId = c.req.param('id');

  const bucket = c.env.DOCS;
  if (!bucket) return c.json({ error: 'File storage is not enabled on this deployment' }, 501);

  // Refuse an oversized body before Hono buffers it. The slack covers
  // multipart framing.
  const declaredLength = Number(c.req.header('content-length') ?? 0);
  if (declaredLength > MAX_LOGO_BYTES + 64 * 1024) {
    return c.json({ error: `That image is too large. The limit is ${Math.floor(MAX_LOGO_BYTES / 1024)} KB.` }, 413);
  }

  const bot = await getBotForAdmin(c.get('db'), botId).catch(() => null);
  if (!bot) return c.json({ error: 'Bot not found' }, 404);

  let form: FormData;
  try { form = await c.req.raw.formData(); }
  catch { return c.json({ error: 'Expected a multipart/form-data upload with a `file` part' }, 400); }

  const file = form.get('file');
  if (!file || typeof file === 'string') return c.json({ error: '`file` is required' }, 400);
  if (file.size === 0) return c.json({ error: 'That file is empty' }, 400);
  if (file.size > MAX_LOGO_BYTES) {
    return c.json({ error: `That image is ${Math.round(file.size / 1024)} KB. The limit is ${Math.floor(MAX_LOGO_BYTES / 1024)} KB.` }, 413);
  }

  const bytes = await file.arrayBuffer();

  // The leading bytes decide, not the filename and not the declared
  // content type — both are supplied by whoever is uploading.
  const detected = detectLogoType(new Uint8Array(bytes.slice(0, LOGO_SNIFF_BYTES)));
  if (!detected.ok) return c.json({ error: detected.error, supported: supportedLogoList() }, 415);

  const key = logoKeyFor(bot.org_id, botId, detected.type.extension);

  try {
    await bucket.put(key, bytes, {
      httpMetadata:   { contentType: detected.type.mime },
      customMetadata: { orgId: bot.org_id, botId, kind: 'logo' },
    });
  } catch (err) {
    console.error('[logo] R2 put failed:', err);
    return c.json({ error: 'Could not store that image' }, 502);
  }

  let result: Awaited<ReturnType<typeof setBotLogoKey>>;
  try {
    result = await setBotLogoKey(c.get('db'), botId, key);
  } catch (err) {
    // Nothing references the object now, so it must not survive.
    await bucket.delete(key).catch((e) => console.error('[logo] orphan cleanup failed:', e));

    const message = err instanceof Error ? err.message : String(err);
    console.error('[logo] widget_config write failed:', message);
    // Deployed ahead of its migration. Say so — the generic error reads
    // like a permissions problem and sends the reader to RLS instead.
    if (/widget_config/.test(message)) {
      return c.json({ error: 'Logos need database migration 009_bot_configuration.sql, which has not been applied yet.' }, 501);
    }
    return c.json({ error: 'Could not save that logo' }, 502);
  }

  if (!result) {
    await bucket.delete(key).catch((e) => console.error('[logo] orphan cleanup failed:', e));
    return c.json({ error: 'Bot not found' }, 404);
  }

  // The replaced object is garbage the moment the row stops pointing at
  // it, and no cache depends on it — every logo gets its own key.
  if (result.previousKey && result.previousKey !== key) {
    c.executionCtx.waitUntil(
      bucket.delete(result.previousKey)
        .catch((err) => console.error('[logo] replacing the old object failed:', err)),
    );
  }

  return c.json(redactBotSecrets(result.bot, origin(c)));
});

app.delete('/v1/admin/bots/:id/logo', async (c) => {
  const botId = c.req.param('id');

  let result: Awaited<ReturnType<typeof setBotLogoKey>>;
  try { result = await setBotLogoKey(c.get('db'), botId, null); }
  catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
  if (!result) return c.json({ error: 'Bot not found' }, 404);

  const bucket = c.env.DOCS;
  if (bucket && result.previousKey) {
    c.executionCtx.waitUntil(
      bucket.delete(result.previousKey)
        .catch((err) => console.error('[logo] object delete failed:', err)),
    );
  }

  return c.json(redactBotSecrets(result.bot, origin(c)));
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
    const { cleanReply } = extractLead(result.text, pre.lead.fields);
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
// The `embedding` block is what makes drift visible to the tenant
// (B2). Each document already carries the model it was indexed with;
// what nothing could see was the model that would resolve TODAY, so a
// row saying `bge-base-en-v1.5` looked correct whatever the bot had
// since been switched to.
//
// Per document rather than per bot, because a mixed corpus is real —
// bots.embedding_model_indexed is the last ingest, and the per-document
// column is the detail. It also covers the case the bot column cannot:
// changing the platform default EMBEDDING_VENDOR in wrangler.toml
// alters no bot row at all, and every corpus on the deployment goes
// stale at once.
//
// Resolution failure is reported as `null`, not as a 502: a bot with a
// broken embedding_config still has a Sources list worth showing, and
// the Providers screen is where that gets fixed.
app.get('/v1/admin/bots/:id/documents', async (c) => {
  const botId = c.req.param('id');
  try {
    const docs = await listDocuments(c.get('db'), botId);

    let embedding: { vendor: string; model: string } | null = null;
    try {
      const bot = await getBotForAdmin(c.get('db'), botId);
      if (bot) {
        const embedder = resolveEmbeddingProvider(c.env, bot.embedding_config);
        embedding = { vendor: embedder.vendor, model: embedder.model };
      }
    } catch (err) {
      console.error('[documents] could not resolve the embedder (non-fatal):', err);
    }

    return c.json({ documents: docs, embedding });
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

// TWO CHECKS, AND THEY DO DIFFERENT JOBS.
//
// The one below is a courtesy and is racy by construction: it reads the
// document, decides nobody is indexing it, and returns 409 if someone
// is — but two clicks a millisecond apart both read "free" and both
// pass. It exists so the common case (a tenant clicking Reindex twice)
// gets told what happened instead of a 202 for work that will not
// happen.
//
// The CORRECTNESS guarantee is the claim inside ingestDocument, which
// is a single conditional UPDATE and therefore atomic. The loser there
// throws AlreadyIndexing and touches nothing — which is the actual bug
// B4 describes: before it, the loser marked a document `failed` while
// the winner's chunks sat there indexed and working.
app.post('/v1/admin/documents/:docId/reindex', async (c) => {
  const docId = c.req.param('docId');

  const doc = await getDocumentForAdmin(c.get('db'), docId).catch(() => null);
  if (!doc) return c.json({ error: 'Document not found' }, 404);

  const bot = await getBotForAdmin(c.get('db'), doc.bot_id).catch(() => null);
  if (!bot) return c.json({ error: 'Bot not found' }, 404);

  // Bounded by the same stale window the claim uses, so a run that died
  // mid-`waitUntil` and left the row at `processing` is still
  // re-indexable. Without that, a crashed ingest would turn Reindex —
  // the only remedy this screen offers — into a permanent 409.
  const runningSince = Date.parse(doc.updated_at);
  const running = (doc.status === 'processing' || doc.status === 'pending')
    && Number.isFinite(runningSince)
    && Date.now() - runningSince < CLAIM_STALE_MS;
  if (running) {
    return c.json({ error: 'This source is already being indexed. Wait for that to finish.' }, 409);
  }

  c.executionCtx.waitUntil(
    ingestDocument(c.env, serviceDb(c.env), docId, bot)
      .catch((err) => {
        // Expected whenever the pre-check above lost its race. Not an
        // error to shout about: the document is being indexed, which is
        // what the caller asked for.
        if (err instanceof AlreadyIndexing) {
          console.log('[rag] reindex skipped, already claimed:', docId);
          return;
        }
        console.error('[rag] reindex failed:', err);
      }),
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

// ================================================================
// FAQ items
//
// A curated Q&A list, stored as rows and indexed like any other
// source. The items hang off one synthetic `documents` row per bot
// (source='faq'), which is what lets them reuse status, reindex, the
// chunk inspector, citations and the delete cascade unchanged.
//
// Every mutation below re-indexes THAT BOT'S FAQ DOCUMENT and nothing
// else. Chunks are replaced per document, so one edit re-embeds the
// bot's items — a handful of batched calls under the 200-item cap, and
// the price of not running a second ingestion state machine.
// ================================================================

/**
 * Re-embed a bot's FAQ in the background. Never awaited on a request:
 * embedding takes seconds and the editor must stay responsive.
 *
 * THIS ONE RETRIES A LOST CLAIM, and the reindex route deliberately
 * does not. The difference is whether the refused run was redundant.
 * Clicking Reindex twice asks for the same work twice, so refusing the
 * second is the right answer and 409 says so. But an FAQ re-index is
 * triggered by an EDIT, and a tenant fixing three answers in a row is
 * the ordinary case — the second run reads different items from the
 * first. Refusing it outright would leave the corpus one edit behind
 * while the editor showed `ready`, which is a quieter version of
 * exactly the lie B4 is about.
 *
 * Retrying rather than queueing because ingestFaq re-reads every item
 * when it starts: one later run subsumes any number of edits made
 * while it was blocked, so the work never needs to be done twice.
 */
function reindexFaq(c: { env: Env; executionCtx: ExecutionContext }, botId: string, bot: Bot): void {
  c.executionCtx.waitUntil((async () => {
    for (let attempt = 1; attempt <= FAQ_CLAIM_ATTEMPTS; attempt++) {
      try {
        await ingestFaq(c.env, serviceDb(c.env), botId, bot);
        return;
      } catch (err) {
        if (!(err instanceof AlreadyIndexing) || attempt === FAQ_CLAIM_ATTEMPTS) {
          if (err instanceof AlreadyIndexing) {
            // Out of attempts. The run that beat us is still going and
            // may not have seen this edit — say so, because the next
            // symptom is a tenant swearing their answer is not live.
            console.error('[rag] FAQ ingest gave up waiting for the claim:', botId);
          } else {
            console.error('[rag] FAQ ingest failed:', err);
          }
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, FAQ_CLAIM_RETRY_MS));
      }
    }
  })());
}

/** Long enough to outlast a small FAQ re-embed, short enough to stay
 *  well inside the `waitUntil` this runs in. */
const FAQ_CLAIM_ATTEMPTS = 4;
const FAQ_CLAIM_RETRY_MS = 2500;

app.get('/v1/admin/bots/:id/faq', async (c) => {
  const botId = c.req.param('id');
  try {
    // The document may not exist yet — a bot with no FAQ has never had
    // one created. That is not an error, it is an empty list.
    const [items, document] = await Promise.all([
      listFaqItems(c.get('db'), botId),
      getFaqDocument(c.get('db'), botId),
    ]);
    return c.json({ items, document, limits: {
      items: LIMITS.faqItems, question: LIMITS.faqQuestion, answer: LIMITS.faqAnswer,
    } });
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
});

app.post('/v1/admin/bots/:id/faq', async (c) => {
  const botId = c.req.param('id');

  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  const parsed = validateFaqItem(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  const bot = await getBotForAdmin(c.get('db'), botId).catch(() => null);
  if (!bot) return c.json({ error: 'Bot not found' }, 404);

  try {
    const existing = await listFaqItems(c.get('db'), botId);
    if (existing.length >= LIMITS.faqItems) {
      return c.json({ error: `A bot can have at most ${LIMITS.faqItems} FAQ items.` }, 400);
    }

    const doc = await ensureFaqDocument(c.get('db'), botId);
    const item = await createFaqItem(c.get('db'), {
      botId,
      documentId: doc.id,
      question: parsed.value.question!,
      answer: parsed.value.answer!,
      // Appended, not inserted. Reordering is its own endpoint.
      position: parsed.value.position ?? (existing.at(-1)?.position ?? -1) + 1,
      enabled: parsed.value.enabled,
    });

    reindexFaq(c, botId, bot);
    return c.json(item, 201);
  } catch (err) {
    console.error(err);
    return c.json({ error: 'Could not add that FAQ item' }, 403);
  }
});

app.put('/v1/admin/faq/:itemId', async (c) => {
  const itemId = c.req.param('itemId');

  let body: unknown;
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  const parsed = validateFaqItem(body, { partial: true });
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);

  // Read first: RLS makes this a 404 for another tenant's item, which
  // is a clearer answer than a PATCH that silently updates no rows.
  const current = await getFaqItem(c.get('db'), itemId).catch(() => null);
  if (!current) return c.json({ error: 'FAQ item not found' }, 404);

  const bot = await getBotForAdmin(c.get('db'), current.bot_id).catch(() => null);
  if (!bot) return c.json({ error: 'Bot not found' }, 404);

  try {
    const item = await updateFaqItem(c.get('db'), itemId, parsed.value);
    if (!item) return c.json({ error: 'FAQ item not found' }, 404);
    reindexFaq(c, current.bot_id, bot);
    return c.json(item);
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
});

app.delete('/v1/admin/faq/:itemId', async (c) => {
  const itemId = c.req.param('itemId');

  let removed;
  try { removed = await deleteFaqItem(c.get('db'), itemId); }
  catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }

  if (!removed) return c.json({ error: 'FAQ item not found' }, 404);

  const bot = await getBotForAdmin(c.get('db'), removed.bot_id).catch(() => null);
  // The row is already gone. A missing bot here would mean it was
  // deleted underneath us, in which case its chunks cascaded too and
  // there is nothing left to re-index.
  if (bot) reindexFaq(c, removed.bot_id, bot);

  return c.body(null, 204);
});

app.post('/v1/admin/bots/:id/faq/reorder', async (c) => {
  const botId = c.req.param('id');

  let body: { order?: unknown };
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  if (!Array.isArray(body.order) || body.order.some((id) => typeof id !== 'string')) {
    return c.json({ error: '`order` must be an array of FAQ item ids' }, 400);
  }
  if (body.order.length > LIMITS.faqItems) {
    return c.json({ error: `At most ${LIMITS.faqItems} FAQ items` }, 400);
  }

  try {
    const items = await reorderFaqItems(c.get('db'), botId, body.order as string[]);
    // No re-index: position decides the order chunks are written in and
    // nothing else. Retrieval ranks by relevance, so re-embedding here
    // would spend a vendor call to change nothing an answer can see.
    return c.json({ items });
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
});

// ================================================================
// Knowledge cutover
//
// Moves a bot's `services` and `faq` columns into the corpus and, only
// once that has actually succeeded, stamps knowledge_migrated_at — at
// which point buildSystemPrompt stops inlining them and retrieval
// takes over.
//
// The ORDER is the whole safety property. Rows are created, then
// embedded, then the flag is set. A failure anywhere before the last
// step leaves the flag NULL and therefore leaves the bot answering
// exactly as it did this morning, with some unreferenced chunks in the
// corpus that the next attempt replaces.
//
// Ingestion is AWAITED here rather than pushed to waitUntil, unlike
// every other ingest in this file. That is the point: "did it work" is
// the question the flag answers, and waitUntil cannot report back.
// ================================================================
app.post('/v1/admin/bots/:id/knowledge/migrate', async (c) => {
  const botId = c.req.param('id');
  const dryRun = c.req.query('dry_run') === '1' || c.req.query('dry_run') === 'true';

  const bot = await getBotForAdmin(c.get('db'), botId).catch(() => null);
  if (!bot) return c.json({ error: 'Bot not found' }, 404);

  if (bot.knowledge_migrated_at) {
    return c.json({
      error: 'This bot has already been migrated. Reindex its sources instead, or revert first.',
      migrated_at: bot.knowledge_migrated_at,
    }, 409);
  }

  const db = c.get('db');

  try {
    const existingItems = await listFaqItems(db, botId);

    // Only parse the legacy blob when there is nothing to lose by it.
    // A bot whose tenant has already used the new editor keeps what
    // they typed; re-parsing would duplicate every answer.
    const parsed = existingItems.length === 0
      ? parseFaqText(bot.faq ?? '')
      : { items: [], unparsed: '' };

    const plan = {
      faq_items_existing: existingItems.length,
      faq_items_to_create: parsed.items.length,
      // Prose that belonged to no Q/A pair. It becomes an ordinary text
      // document rather than one enormous FAQ item — an item is capped
      // at 2000 characters, and unstructured prose is what the
      // recursive splitter is for.
      faq_notes: parsed.unparsed ? parsed.unparsed.length : 0,
      services: bot.services?.trim() ? bot.services.trim().length : 0,
    };

    if (dryRun) return c.json({ dry_run: true, plan });

    const faqDoc = await ensureFaqDocument(db, botId);

    for (const [index, draft] of parsed.items.entries()) {
      await createFaqItem(db, {
        botId,
        documentId: faqDoc.id,
        // Truncated rather than skipped: a question over the cap is
        // still the tenant's content, and losing it silently during a
        // migration is the failure this whole endpoint exists to avoid.
        question: draft.question.slice(0, LIMITS.faqQuestion),
        answer:   draft.answer.slice(0, LIMITS.faqAnswer),
        position: index,
      });
    }

    const extraDocs: Document[] = [];
    if (parsed.unparsed) {
      extraDocs.push(await createDocument(db, {
        bot_id: botId, source: 'text', title: 'FAQ notes', content: parsed.unparsed,
      }));
    }
    if (bot.services?.trim()) {
      extraDocs.push(await createDocument(db, {
        bot_id: botId, source: 'text', title: 'Services', content: bot.services.trim(),
      }));
    }

    // Embed everything before committing to the cutover.
    const service = serviceDb(c.env);
    const faqResult = await ingestFaq(c.env, service, botId, bot);
    for (const doc of extraDocs) await ingestDocument(c.env, service, doc.id, bot);

    const updated = await setKnowledgeMigrated(db, botId, new Date().toISOString());

    return c.json({
      bot: updated ? redactBotSecrets(updated, origin(c)) : null,
      plan,
      faq_chunks: faqResult.chunkCount,
      documents: extraDocs.map((d) => ({ id: d.id, title: d.title })),
    });
  } catch (err) {
    console.error('[knowledge] migrate failed:', err);
    // The flag is untouched, so the bot is still answering from its
    // prompt. Say that, because "migration failed" on its own reads
    // like the bot is now broken.
    return c.json({
      error: err instanceof Error ? err.message : 'Migration failed',
      detail: 'Nothing was cut over — this bot still answers from its Knowledge Base fields.',
    }, 502);
  }
});

/** Undo the cutover. The chunks stay — harmless, and there if the
 *  tenant tries again — and the prompt goes back to inlining the two
 *  columns, which were never deleted. */
app.post('/v1/admin/bots/:id/knowledge/revert', async (c) => {
  try {
    const updated = await setKnowledgeMigrated(c.get('db'), c.req.param('id'), null);
    if (!updated) return c.json({ error: 'Bot not found' }, 404);
    return c.json(redactBotSecrets(updated, origin(c)));
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
});

// ================================================================
// POST /v1/admin/bots/:id/retrieve-preview
//
// "What would this retrieve?" — the query side of the chunk inspector.
//
// The roadmap's note that the chunk inspector matters more than it
// sounds applies double here: when a bot answers badly the first
// question is always what it retrieved, and until now the only way to
// find out was to read the Worker's logs. It is also what makes the
// knowledge cutover safe to perform — a tenant can prove their bot
// still finds its FAQ answers BEFORE flipping the flag that stops
// inlining them.
//
// Runs the real retrieval path, fallback and all, rather than a
// reimplementation of it. A preview that is only approximately what
// happens in production is worse than none.
// ================================================================
app.post('/v1/admin/bots/:id/retrieve-preview', async (c) => {
  const botId = c.req.param('id');

  let body: { query?: string };
  try { body = await c.req.json(); }
  catch { return c.json({ error: 'Invalid JSON body' }, 400); }

  const query = (body.query ?? '').trim();
  if (!query) return c.json({ error: '`query` is required' }, 400);
  if (query.length > 1000) return c.json({ error: '`query` must be 1000 characters or fewer' }, 400);

  const bot = await getBotForAdmin(c.get('db'), botId).catch(() => null);
  if (!bot) return c.json({ error: 'Bot not found' }, 404);

  const cfg = ragConfigFor(bot);

  try {
    // service_role for the search itself, exactly as the chat path
    // does. The tenant check already happened: getBotForAdmin ran under
    // RLS, so reaching this line proves they own the bot.
    const db = serviceDb(c.env);
    const outcome = await retrieve(c.env, db, bot, query);

    return c.json({
      query,
      channel: outcome.channel ?? null,
      skipped: outcome.skipped ?? null,
      error: outcome.error ?? null,
      settings: {
        top_k: cfg.top_k,
        // The floor THAT RAN, from the outcome — not a second guess at
        // it. It depends on the resolved embedding model, so a config
        // rebuilt here without one would report a different number from
        // the one the query was filtered by, which is exactly the kind
        // of plausible-looking wrong reading this inspector exists to
        // prevent. Falls back to the model-less config only when
        // retrieval never got as far as resolving an embedder.
        min_similarity: outcome.effective?.min_similarity ?? cfg.min_similarity,
        priority_boost: cfg.priority_boost,
        lexical_fallback: cfg.lexical_fallback,
        context_chars: cfg.context_chars,
        // Both added by 013. The mode is what decides whether the
        // `channel` above can read 'hybrid' at all, and re-rank is the
        // one setting that changes the ORDER of what came back without
        // changing what came back — so an inspector that omitted them
        // would be showing a result it could not explain.
        retrieval_mode: cfg.retrieval_mode,
        rerank: cfg.rerank,
      },
      // Which embedding model ran, and where its floor came from:
      // 'tenant' an explicit override, 'model' a value calibrated for
      // that model, 'default' the unmeasured fallback. A tenant
      // debugging "why did it find nothing" needs all three.
      effective: outcome.effective ?? null,
      chunks: outcome.chunks.map((ch) => ({
        id: ch.id,
        document_id: ch.document_id,
        // Carried by both RPCs since 012, so the preview and the chat
        // path now name a source from exactly the same field. This is
        // also what scripts/eval-rag.mjs asserts on, which makes the
        // golden set an unchanged regression test for the join.
        document_title: ch.document_title ?? null,
        ordinal: ch.ordinal,
        content: ch.content,
        // A cosine score on the vector channel and a ts_rank on the
        // lexical one. Reported with the channel rather than rescaled,
        // because a made-up common scale would be a lie that reads
        // like a measurement.
        score: ch.similarity,
        kind: ch.kind ?? 'prose',
        priority: ch.priority ?? 0,
        channel: ch.channel ?? outcome.channel ?? null,
      })),
      // What the model would actually be handed, budget applied.
      context: renderContext(outcome.chunks, cfg.context_chars),
      // How many of the chunks above survive that budget — i.e. how
      // many markers the model actually sees, and therefore how many
      // citations the widget would show.
      rendered_count: selectContext(outcome.chunks, cfg.context_chars).length,
    });
  } catch (err) {
    console.error(err);
    return c.json({ error: err instanceof Error ? err.message : 'Retrieval failed' }, 502);
  }
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

// ================================================================
// GET /v1/admin/bots/:id/retrieval — the miss report (M1)
//
// Modelled on the stats route above and sharing its shape deliberately:
// same day clamping, same UserDb so RLS scopes it to the caller's own
// orgs, same row cap surfaced rather than hidden.
//
// The report is two things at once, and the second is the reason it
// stores scores as well as questions. For a tenant it answers "what
// should I write next". For whoever tunes this pipeline it is the
// similarity floor measured continuously against real traffic, rather
// than once against a fixture corpus — which is the gap that let a
// floor below the embedder's noise floor survive four months of looking
// like it worked.
// ================================================================
app.get('/v1/admin/bots/:id/retrieval', async (c) => {
  const botId = c.req.param('id');

  const raw = Number(c.req.query('days') ?? 30);
  const days = Number.isFinite(raw) ? Math.min(90, Math.max(7, Math.trunc(raw))) : 30;

  // One window, not two: there is no comparison period here, so the
  // fetch reaches back exactly as far as the report shows.
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  try {
    const rows = await getRetrievalLog(c.get('db'), botId, since);
    return c.json(buildMissReport({ days, rows, cap: RETRIEVAL_LOG_CAP }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Deployed ahead of its migration. The generic 502 sends whoever is
    // debugging it looking at RLS instead of at the schema — the same
    // trap the upload route names 008 for.
    if (/retrieval_log/.test(message)) {
      console.error('[retrieval] 012 not applied:', message);
      return c.json({ error: 'The retrieval report needs database migration 012_retrieval.sql, which has not been applied yet.' }, 501);
    }
    console.error(err);
    return c.json({ error: 'Database error' }, 502);
  }
});

// `?session_id=` narrows to one transcript, which is what the drawer on
// the Leads screen asks for. Additive: without it the route returns the
// bot's last 100 messages exactly as before.
app.get('/v1/admin/bots/:id/conversations', async (c) => {
  try {
    const sessionId = c.req.query('session_id') || undefined;
    const convos = await getConversations(c.get('db'), c.req.param('id'), 100, sessionId);
    return c.json({ conversations: convos });
  } catch (err) { console.error(err); return c.json({ error: 'Database error' }, 502); }
});


// ================================================================
// Scheduled — retention for retrieval_log, and NOTHING ELSE
//
// This is the only cron on the deployment and it must stay that way.
// A "daily maintenance" handler accretes: the next thing that wants a
// timer lands here, then the one after it, and a single failure takes
// down work that has nothing to do with the failure. When something
// else needs a schedule, it gets its own cron expression and its own
// branch on `event.cron`, not another line in this function.
//
// retrieval_log is the first table on this platform whose PURPOSE is
// keeping what visitors typed, so retention is not housekeeping — it is
// the thing that makes storing the query verbatim defensible. The
// 90-day window is documented in docs/tenancy.md.
//
// The day count is clamped inside prune_retrieval_log, not here. A
// scheduled handler holding a service-role key is exactly the caller
// that should not be trusted with a number that can truncate a table.
// ================================================================
const RETRIEVAL_LOG_RETENTION_DAYS = 90;

const scheduled: ExportedHandlerScheduledHandler<Env> = async (event, env, ctx) => {
  ctx.waitUntil((async () => {
    try {
      const deleted = await pruneRetrievalLog(serviceDb(env), RETRIEVAL_LOG_RETENTION_DAYS);
      console.log(`[cron ${event.cron}] pruned ${deleted} retrieval_log row(s) older than ${RETRIEVAL_LOG_RETENTION_DAYS} days`);
    } catch (err) {
      // Logged, never thrown. A failed prune is a retention window that
      // slipped by a day, and Cloudflare retries the schedule; throwing
      // here buys an alert nobody has wired up.
      console.error('[cron] retrieval_log prune failed:', err);
    }
  })());
};

// `app.fetch` rather than the app itself, because a Worker with a
// scheduled handler exports an object rather than a Hono instance.
export default { fetch: app.fetch, scheduled };
