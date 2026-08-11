// ----------------------------------------------------------------
// Supabase helpers using raw fetch — no SDK dependency.
// The @supabase/supabase-js client pulls in Node.js streams which
// can cause issues in the Cloudflare Workers runtime.
// PostgREST's REST API is simple enough to call directly.
//
// Two identities, deliberately separated (see docs/roadmap.md Phase 1):
//
//   serviceDb(env)      — service_role key. Bypasses RLS entirely.
//                         For the public chat path, where the caller
//                         is an anonymous visitor and tenancy is
//                         enforced by the origin lock + botId.
//
//   userDb(env, jwt)    — the end user's own token, forwarded to
//                         PostgREST so RLS decides what they can see.
//                         For every /v1/admin route.
//
// Routes never choose: the auth middleware puts a userDb on the Hono
// context, and the chat handlers build a serviceDb locally.
// ----------------------------------------------------------------
import type {
  Env, Bot, ConversationRow, Lead, BotUpdatePayload, BotCreatePayload, Membership, Organization,
  Document, DocumentCreatePayload, ChunkRow,
} from './types';
import type { ExtractedLead } from './leads';

interface DbBase {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/**
 * The scope is a literal-typed discriminant, not a boolean flag. That
 * matters: every query function below is typed to exactly ONE of these,
 * so passing a service client to an admin query is a compile error
 * rather than a code-review question.
 */
export type ServiceDb = DbBase & { readonly scope: 'service' };
export type UserDb    = DbBase & { readonly scope: 'user' };
export type AnyDb     = ServiceDb | UserDb;

export function serviceDb(env: Env): ServiceDb {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  return {
    scope: 'service',
    url: env.SUPABASE_URL,
    headers: {
      'apikey':        key,
      'Authorization': `Bearer ${key}`,
      'Content-Type':  'application/json',
    },
  };
}

export function userDb(env: Env, jwt: string): UserDb {
  return {
    scope: 'user',
    url: env.SUPABASE_URL,
    headers: {
      // apikey stays the anon key; the bearer token is what RLS reads.
      'apikey':        env.SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${jwt}`,
      'Content-Type':  'application/json',
    },
  };
}

async function pgFetch<T>(db: AnyDb, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${db.url}/rest/v1${path}`, {
    ...init,
    headers: {
      ...db.headers,
      'Prefer': 'return=representation',
      ...(init.headers as Record<string, string> ?? {}),
    },
  });
  const body = await res.text();

  if (!res.ok) {
    throw new Error(`Supabase ${init.method ?? 'GET'} ${path} → ${res.status}: ${body.slice(0, 500)}`);
  }

  // `Prefer: return=minimal` yields an empty body — as 204 on PATCH and
  // DELETE, but as *201* on POST. Keying on the status code missed that
  // and made every minimal insert throw on JSON.parse. Key on the body
  // instead: absent content is absent content whatever the status.
  if (!body) return [] as unknown as T;
  return JSON.parse(body) as T;
}

// ----------------------------------------------------------------
// Identity
// ----------------------------------------------------------------
export async function getMemberships(db: UserDb): Promise<Membership[]> {
  return pgFetch<Membership[]>(db,
    '/memberships?select=org_id,role,organizations(id,name,slug,plan)'
  );
}

/** Calls the SECURITY DEFINER RPC — a user with no membership cannot
 *  insert an organization directly, by design. */
export async function createOrganization(db: UserDb, name: string): Promise<Organization> {
  const org = await pgFetch<Organization | Organization[]>(db, '/rpc/create_organization',
    { method: 'POST', body: JSON.stringify({ p_name: name }) }
  );
  return Array.isArray(org) ? org[0] : org;
}

// ----------------------------------------------------------------
// Bots
// ----------------------------------------------------------------
async function selectBot(db: AnyDb, botId: string): Promise<Bot | null> {
  const rows = await pgFetch<Bot[]>(db,
    `/bots?select=*&id=eq.${encodeURIComponent(botId)}&limit=1`
  );
  return rows[0] ?? null;
}

/**
 * Two names for one query, on purpose. This is the only lookup both
 * access paths need, so leaving it callable from either would reopen
 * the hole the ServiceDb/UserDb split exists to close. Forcing the
 * author of a new route to name their path is the whole point.
 */
export function getBotForChat(db: ServiceDb, botId: string): Promise<Bot | null> {
  return selectBot(db, botId);
}

export function getBotForAdmin(db: UserDb, botId: string): Promise<Bot | null> {
  return selectBot(db, botId);
}

export async function listBots(db: UserDb): Promise<Bot[]> {
  // No org filter: RLS already restricts this to the caller's orgs.
  return pgFetch<Bot[]>(db, '/bots?select=*&order=created_at.desc');
}

export async function createBot(db: UserDb, payload: BotCreatePayload): Promise<Bot> {
  // Write both shapes: `allowed_origin` is the legacy NOT NULL column,
  // `allowed_origins` the list that supersedes it. Sending both means a
  // Worker deployed ahead of migration 006 still works, and one
  // deployed after it keeps older rows consistent.
  const body: Record<string, unknown> = {
    ...payload,
    allowed_origin: payload.allowed_origins[0],
  };

  try {
    const rows = await pgFetch<Bot[]>(db, '/bots', { method: 'POST', body: JSON.stringify(body) });
    if (!rows[0]) throw new Error('Bot not returned after insert');
    return rows[0];
  } catch (err) {
    // 006 not applied yet: fall back to the legacy column alone rather
    // than failing the create. Remove this branch once 006 has run
    // everywhere.
    const message = err instanceof Error ? err.message : String(err);
    if (!/allowed_origins/.test(message)) throw err;

    const { allowed_origins, ...legacy } = body as { allowed_origins?: unknown } & Record<string, unknown>;
    void allowed_origins;
    const rows = await pgFetch<Bot[]>(db, '/bots', { method: 'POST', body: JSON.stringify(legacy) });
    if (!rows[0]) throw new Error('Bot not returned after insert');
    return rows[0];
  }
}

/**
 * A PATCH replaces a jsonb column wholesale, so a naive write of the
 * config the dashboard just rendered would drop the stored apiKey —
 * the admin API never sends that key back (see redactBotSecrets).
 *
 * So: merge the incoming config over what is stored, and carry the
 * existing key forward unless the caller supplied a new, non-empty one.
 * The signal is the presence of a real value, never a sentinel string,
 * because a sentinel is only as reliable as the encoding it survives.
 */
async function mergeConfigs(db: UserDb, botId: string, payload: BotUpdatePayload): Promise<BotUpdatePayload> {
  const touchesConfig = 'provider_config' in payload || 'embedding_config' in payload;
  if (!touchesConfig) return payload;

  const current = await selectBot(db, botId);
  if (!current) return payload;

  const out = { ...payload };
  for (const field of ['provider_config', 'embedding_config'] as const) {
    if (!(field in out)) continue;
    const incoming = out[field];
    if (incoming === null) continue; // explicit clear — drop the key too

    const stored = current[field];
    const merged = { ...(stored ?? {}), ...(incoming ?? {}) } as NonNullable<typeof incoming>;

    // Strip the display-only fields the dashboard round-trips back.
    delete (merged as Record<string, unknown>).hasApiKey;
    delete (merged as Record<string, unknown>).apiKeyLast4;

    const supplied = incoming?.apiKey;
    if (typeof supplied === 'string' && supplied.trim() !== '') {
      merged.apiKey = supplied.trim();          // caller set a new key
    } else if (stored?.apiKey) {
      merged.apiKey = stored.apiKey;            // keep what is there
    } else {
      delete merged.apiKey;
    }
    out[field] = merged;
  }
  return out;
}

export async function updateBot(db: UserDb, botId: string, payload: BotUpdatePayload): Promise<Bot | null> {
  const body = await mergeConfigs(db, botId, payload);
  const rows = await pgFetch<Bot[]>(db,
    `/bots?id=eq.${encodeURIComponent(botId)}`,
    { method: 'PATCH', body: JSON.stringify(body) }
  );
  // Zero rows means RLS hid it — indistinguishable from "absent", and
  // deliberately so: callers turn this into a 404, not a 403.
  return rows[0] ?? null;
}

export async function deleteBot(db: UserDb, botId: string): Promise<boolean> {
  const rows = await pgFetch<Bot[]>(db,
    `/bots?id=eq.${encodeURIComponent(botId)}`,
    { method: 'DELETE' }
  );
  return rows.length > 0;
}

// ----------------------------------------------------------------
// Conversations
// ----------------------------------------------------------------
export async function getSessionHistory(
  db: ServiceDb,
  botId: string,
  sessionId: string
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const rows = await pgFetch<ConversationRow[]>(db,
    `/conversations?select=role,content&bot_id=eq.${encodeURIComponent(botId)}&session_id=eq.${encodeURIComponent(sessionId)}&order=created_at.asc&limit=20`
  );
  return rows;
}

export async function logMessage(
  db: ServiceDb,
  row: Omit<ConversationRow, 'id' | 'created_at'>
): Promise<void> {
  await pgFetch<unknown>(db, '/conversations',
    { method: 'POST', body: JSON.stringify(row),
      headers: { 'Prefer': 'return=minimal' } }
  );
}

export async function getConversations(
  db: UserDb,
  botId: string,
  limit = 100
): Promise<ConversationRow[]> {
  return pgFetch<ConversationRow[]>(db,
    `/conversations?select=*&bot_id=eq.${encodeURIComponent(botId)}&order=created_at.desc&limit=${limit}`
  );
}

// ----------------------------------------------------------------
// Leads
// ----------------------------------------------------------------
export async function saveLead(
  db: ServiceDb,
  botId: string,
  sessionId: string,
  lead: ExtractedLead
): Promise<void> {
  await pgFetch<unknown>(db, '/leads',
    { method: 'POST',
      body: JSON.stringify({
        bot_id:     botId,
        session_id: sessionId,
        name:       lead.name,
        email:      lead.email,
        phone:      lead.phone,
        inquiry:    lead.inquiry,
      }),
      headers: { 'Prefer': 'return=minimal' },
    }
  );
}

export async function getLeads(db: UserDb, botId: string, limit = 100): Promise<Lead[]> {
  return pgFetch<Lead[]>(db,
    `/leads?select=*&bot_id=eq.${encodeURIComponent(botId)}&order=created_at.desc&limit=${limit}`
  );
}

// ----------------------------------------------------------------
// Documents (RAG)
//
// Split by scope like everything else: tenants create and delete their
// own sources under RLS, while the ingestion pipeline writes derived
// rows with the service client.
//
// `content` is excluded from list queries — a document body can be
// hundreds of KB and the dashboard only needs metadata.
// ----------------------------------------------------------------
const DOC_FIELDS_BASE = 'id,bot_id,org_id,source,title,url,status,error,chunk_count,embedding_model,embedding_dimensions,created_at,updated_at';
/** Added by 008_files.sql. */
const DOC_FIELDS_FILE = 'r2_key,mime_type,size_bytes';
const DOC_FIELDS = `${DOC_FIELDS_BASE},${DOC_FIELDS_FILE}`;

/**
 * Select documents, degrading to the pre-008 column list if those
 * columns are not there yet.
 *
 * This is the same shape as the allowed_origins fallback in createBot,
 * and it exists for the same reason: a Worker deployed ahead of its
 * migration once broke bot creation in production. Asking PostgREST for
 * a column that does not exist fails the whole query, so without this a
 * deploy that lands before 008 does not merely lose file uploads — it
 * takes the Sources page down for every tenant, including the three
 * source types that have nothing to do with files.
 *
 * Remove once 008 has run everywhere.
 */
async function selectDocuments(db: AnyDb, query: (fields: string) => string): Promise<Document[]> {
  try {
    return await pgFetch<Document[]>(db, query(DOC_FIELDS));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/r2_key|mime_type|size_bytes/.test(message)) throw err;
    return pgFetch<Document[]>(db, query(DOC_FIELDS_BASE));
  }
}

export async function listDocuments(db: UserDb, botId: string): Promise<Document[]> {
  return selectDocuments(db, (fields) =>
    `/documents?select=${fields}&bot_id=eq.${encodeURIComponent(botId)}&order=created_at.desc`
  );
}

export async function createDocument(db: UserDb, payload: DocumentCreatePayload): Promise<Document> {
  const rows = await pgFetch<Document[]>(db, '/documents',
    { method: 'POST', body: JSON.stringify(payload) }
  );
  if (!rows[0]) throw new Error('Document not returned after insert');
  return rows[0];
}

export async function getDocumentForAdmin(db: UserDb, documentId: string): Promise<Document | null> {
  const rows = await selectDocuments(db, (fields) =>
    `/documents?select=${fields}&id=eq.${encodeURIComponent(documentId)}&limit=1`
  );
  return rows[0] ?? null;
}

/** Ingestion needs the full row, `content` included. */
export async function getDocumentForChat(db: ServiceDb, documentId: string): Promise<Document | null> {
  const rows = await pgFetch<Document[]>(db,
    `/documents?select=*&id=eq.${encodeURIComponent(documentId)}&limit=1`
  );
  return rows[0] ?? null;
}

/**
 * Returns the deleted row rather than a boolean, because a file source
 * leaves an object behind in R2 and the caller needs `r2_key` to sweep
 * it. Null still means "absent, or hidden by RLS" — callers turn that
 * into a 404 exactly as before.
 */
export async function deleteDocument(db: UserDb, documentId: string): Promise<Document | null> {
  const rows = await pgFetch<Document[]>(db,
    `/documents?id=eq.${encodeURIComponent(documentId)}`,
    { method: 'DELETE' }
  );
  return rows[0] ?? null;
}

/** Every R2 key under a bot, so deleting the bot can sweep its objects.
 *  Runs as the user: RLS is what proves they own the bot. */
export async function listDocumentKeys(db: UserDb, botId: string): Promise<string[]> {
  const rows = await pgFetch<Array<{ r2_key: string | null }>>(db,
    `/documents?select=r2_key&bot_id=eq.${encodeURIComponent(botId)}&r2_key=not.is.null`
  );
  return rows.map((r) => r.r2_key).filter((k): k is string => !!k);
}

/**
 * Bytes this org already stores. Advisory only — the real cap is a
 * trigger in 008_files.sql, because this reading races every concurrent
 * upload. It exists so the common case gets a sentence explaining the
 * problem instead of a constraint violation.
 */
export async function orgStorageBytes(db: UserDb, orgId: string): Promise<number> {
  const used = await pgFetch<number | string>(db, '/rpc/org_storage_bytes',
    { method: 'POST', body: JSON.stringify({ p_org_id: orgId }) }
  );
  return Number(used) || 0;
}

export async function updateDocument(
  db: ServiceDb,
  documentId: string,
  patch: Partial<Document>,
): Promise<void> {
  await pgFetch<unknown>(db,
    `/documents?id=eq.${encodeURIComponent(documentId)}`,
    { method: 'PATCH',
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
      headers: { 'Prefer': 'return=minimal' } }
  );
}

// ----------------------------------------------------------------
// Chunks
// ----------------------------------------------------------------
export async function listChunks(db: UserDb, documentId: string, limit = 200): Promise<ChunkRow[]> {
  // No embedding column: 768 floats per row is megabytes of JSON the
  // chunk inspector has no use for.
  return pgFetch<ChunkRow[]>(db,
    `/chunks?select=id,document_id,ordinal,content,created_at&document_id=eq.${encodeURIComponent(documentId)}&order=ordinal.asc&limit=${limit}`
  );
}

/**
 * Replace a document's chunks atomically enough for our purposes:
 * delete then insert. A re-index that fails after the delete leaves
 * the document with zero chunks and status 'failed', which is
 * recoverable by re-running and is preferable to duplicated chunks
 * silently doubling every retrieval score.
 */
export async function replaceChunks(
  db: ServiceDb,
  args: { documentId: string; botId: string; rows: Array<{ ordinal: number; content: string; embedding: number[] }> },
): Promise<void> {
  await pgFetch<unknown>(db,
    `/chunks?document_id=eq.${encodeURIComponent(args.documentId)}`,
    { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }
  );

  if (args.rows.length === 0) return;

  // pgvector accepts the '[1,2,3]' text form over PostgREST.
  const payload = args.rows.map((r) => ({
    document_id: args.documentId,
    bot_id:      args.botId,
    ordinal:     r.ordinal,
    content:     r.content,
    embedding:   `[${r.embedding.join(',')}]`,
  }));

  // Insert in batches: one request with 400 × 768 floats is large
  // enough to hit request size limits.
  const BATCH = 50;
  for (let i = 0; i < payload.length; i += BATCH) {
    await pgFetch<unknown>(db, '/chunks',
      { method: 'POST',
        body: JSON.stringify(payload.slice(i, i + BATCH)),
        headers: { 'Prefer': 'return=minimal' } }
    );
  }
}

export async function matchChunks(
  db: ServiceDb,
  args: { botId: string; embedding: number[]; matchCount: number; minSimilarity: number },
): Promise<Array<{ id: string; document_id: string; ordinal: number; content: string; similarity: number }>> {
  return pgFetch(db, '/rpc/match_chunks',
    { method: 'POST',
      body: JSON.stringify({
        p_bot_id:         args.botId,
        p_query:          `[${args.embedding.join(',')}]`,
        p_match_count:    args.matchCount,
        p_min_similarity: args.minSimilarity,
      }) }
  );
}

/** Whether a bot has anything indexed — lets the chat path skip the
 *  embedding call entirely for bots with no corpus. */
export async function hasChunks(db: ServiceDb, botId: string): Promise<boolean> {
  const rows = await pgFetch<Array<{ id: string }>>(db,
    `/chunks?select=id&bot_id=eq.${encodeURIComponent(botId)}&limit=1`
  );
  return rows.length > 0;
}
