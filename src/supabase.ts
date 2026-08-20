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
  Document, DocumentCreatePayload, ChunkRow, ChunkKind, WidgetConfig,
  FaqItem, FaqItemPayload,
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
  // `profile` IS DELIBERATELY ABSENT FROM THIS LIST (015). It is
  // replaced wholesale with nothing carried forward: it holds no
  // secret, the Business Profile screen posts the whole object on every
  // section save, and a merge would make a cleared field un-clearable.
  // The next person to read this file will look for the exception
  // widget_config.logo_key and lead_config.webhook_url get — there is
  // none, and its absence is the design rather than an oversight.
  const touchesConfig = 'provider_config' in payload
    || 'embedding_config' in payload
    || 'widget_config' in payload
    || 'lead_config' in payload;
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

  // widget_config is replaced wholesale, NOT merged: it holds no secret,
  // the form posts the whole object, and a merge would make a cleared
  // field un-clearable. The one exception is logo_key, which the
  // settings form neither sends nor is allowed to send (see
  // validateWidgetConfig) — it belongs to the upload route, so it is
  // carried forward here rather than being wiped by every save.
  // Note the null case: a tenant who clears every setting still has a
  // logo, and wiping the key here would orphan the R2 object with
  // nothing left pointing at it.
  if ('widget_config' in out) {
    const storedLogo = current.widget_config?.logo_key;
    if (storedLogo) out.widget_config = { ...(out.widget_config ?? {}), logo_key: storedLogo };
  }

  // lead_config gets exactly the same treatment for exactly the same
  // reason, with webhook_url in the role logo_key plays above: the
  // settings form is never sent the URL (it is a credential — see
  // redactBotSecrets), so it cannot send it back, and a plain replace
  // would delete a tenant's Slack webhook every time they edited the
  // success message next to it.
  //
  // The difference from logo_key is that this one IS clearable, because
  // "stop notifying me" has to be expressible. A non-empty incoming
  // value replaces the stored one; an explicit null for the whole
  // object clears everything including the URL. Sending the object
  // without the key means "leave the webhook alone", which is what the
  // form does on every other save.
  if ('lead_config' in out && out.lead_config !== null) {
    const incoming = { ...(out.lead_config ?? {}) };

    if (incoming.webhook_url === null) {
      delete incoming.webhook_url;                  // explicit clear
    } else if (!incoming.webhook_url && current.lead_config?.webhook_url) {
      incoming.webhook_url = current.lead_config.webhook_url;
    }

    // Clearing the only setting a tenant had leaves {}, and an empty
    // object is stored as NULL everywhere else in this codebase so that
    // "never configured" and "configured back to defaults" read alike.
    out.lead_config = Object.keys(incoming).length ? incoming : null;
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

/**
 * Point a bot at a logo object, or clear it.
 *
 * Deliberately NOT routed through updateBot: mergeConfigs carries the
 * *stored* logo_key forward over anything the caller sends, which is
 * what protects the logo from an ordinary settings save — and would
 * equally stop this from ever replacing it. The upload route owns this
 * field, so it writes it directly.
 *
 * Returns the previous key as well, because after the write there is
 * nothing left saying which R2 object just became garbage.
 */
export async function setBotLogoKey(
  db: UserDb,
  botId: string,
  key: string | null,
): Promise<{ bot: Bot; previousKey: string | null } | null> {
  const current = await selectBot(db, botId);
  if (!current) return null;

  const previousKey = current.widget_config?.logo_key ?? null;

  const next: WidgetConfig = { ...(current.widget_config ?? {}) };
  if (key) next.logo_key = key;
  else delete next.logo_key;

  const rows = await pgFetch<Bot[]>(db,
    `/bots?id=eq.${encodeURIComponent(botId)}`,
    { method: 'PATCH', body: JSON.stringify({ widget_config: Object.keys(next).length ? next : null }) }
  );
  if (!rows[0]) return null;
  return { bot: rows[0], previousKey };
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
  row: Omit<ConversationRow, 'id' | 'created_at'> & { retrieval_miss?: boolean }
): Promise<void> {
  await pgFetch<unknown>(db, '/conversations',
    { method: 'POST', body: JSON.stringify(row),
      headers: { 'Prefer': 'return=minimal' } }
  );
}

/**
 * How long this conversation has run, capped.
 *
 * NOT derived from getSessionHistory: that ends at `limit=20`, so
 * counting what it returns stops at 20 and a threshold above that would
 * never fire. `cap` is the caller's threshold plus one — enough to
 * answer "has it passed?", which is the only question asked, without
 * dragging a long transcript over the wire on every turn.
 */
export async function countSessionMessages(
  db: ServiceDb,
  botId: string,
  sessionId: string,
  cap: number,
): Promise<number> {
  const rows = await pgFetch<Array<{ id: string }>>(db,
    `/conversations?select=id&bot_id=eq.${encodeURIComponent(botId)}&session_id=eq.${encodeURIComponent(sessionId)}&limit=${cap}`
  );
  return rows.length;
}

/**
 * How many of this session's most recent replies in a row had no
 * retrieved context to work from.
 *
 * Ordered newest-first and counted until the streak breaks, so one
 * answered question resets it — which is what "three failed answers in
 * a row" has to mean for the setting to behave the way it reads.
 */
export async function countTrailingMisses(
  db: ServiceDb,
  botId: string,
  sessionId: string,
  cap: number,
): Promise<number> {
  const rows = await pgFetch<Array<{ retrieval_miss: boolean | null }>>(db,
    `/conversations?select=retrieval_miss&bot_id=eq.${encodeURIComponent(botId)}&session_id=eq.${encodeURIComponent(sessionId)}&role=eq.assistant&order=created_at.desc&limit=${cap}`
  );

  let streak = 0;
  for (const row of rows) {
    if (row.retrieval_miss !== true) break;
    streak++;
  }
  return streak;
}

/*
 * getDocumentTitles lived here until 012. It existed because
 * match_chunks returned document_id and nothing else, so naming a
 * source cost a second round trip on the hot path of every turn with
 * citations on. 012 folds the title into both retrieval RPCs (the S2
 * title fold), which left this with no callers — deleted rather than
 * kept as an unused export, because an exported helper reads as
 * something someone is meant to use.
 */

/**
 * @param sessionId Narrow to one session. The bot filter stays in place
 *   alongside it rather than being replaced by it: session ids are not
 *   scoped to a bot, and dropping the bot_id would let a guessed id
 *   read another bot's transcript. RLS would still confine it to the
 *   caller's own orgs, but "their other bot" is not the right answer
 *   either.
 *
 *   Also serves the drawer on the Leads screen — `leads.session_id` has
 *   always matched this column; nothing ever queried across them.
 */
export async function getConversations(
  db: UserDb,
  botId: string,
  limit = 100,
  sessionId?: string,
): Promise<ConversationRow[]> {
  const session = sessionId ? `&session_id=eq.${encodeURIComponent(sessionId)}` : '';
  return pgFetch<ConversationRow[]>(db,
    `/conversations?select=*&bot_id=eq.${encodeURIComponent(botId)}${session}&order=created_at.desc&limit=${limit}`
  );
}

// ----------------------------------------------------------------
// Leads
// ----------------------------------------------------------------
/**
 * @param meta The 010 columns. Passed as an object rather than read
 *   from the bot here because the tag and the consent flag are facts
 *   about the CAPTURE, not about the lead the model produced — and
 *   because omitting the object entirely keeps this insert valid
 *   against a database that has not had 010 applied yet.
 *
 *   Each key is only sent when it has a value, for that same reason:
 *   the schema is allowed to be ahead of the code, never behind it.
 */
export async function saveLead(
  db: ServiceDb,
  botId: string,
  sessionId: string,
  lead: ExtractedLead,
  meta?: { tag?: string | null; consentGiven?: boolean | null },
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
        ...(lead.company != null    && { company: lead.company }),
        ...(meta?.tag                && { tag: meta.tag }),
        ...(meta?.consentGiven != null && { consent_given: meta.consentGiven }),
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

/**
 * Take the ingest claim on a document (012). Returns false when someone
 * else already holds it.
 *
 * ONE conditional PATCH, and that is the whole correctness argument.
 * PostgREST turns it into a single UPDATE with the filter in its WHERE
 * clause, so the compare-and-set happens inside one statement and
 * Postgres serialises the two racing writers for us. Reading the column
 * and then writing it would reintroduce exactly the window this exists
 * to close.
 *
 * `Prefer: return=representation` is what makes the result readable:
 * zero rows back means the filter matched nothing, which means the
 * claim is held.
 *
 * @param staleAfterMs A claim older than this is treated as abandoned
 *   and may be taken. A Worker can die mid-`waitUntil` with no chance
 *   to release, so without a stale window a crashed run would leave a
 *   document permanently unindexable — a worse failure than the double
 *   index this guards against.
 */
export async function claimDocument(
  db: ServiceDb,
  documentId: string,
  staleAfterMs: number,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const rows = await pgFetch<Array<{ id: string }>>(db,
    `/documents?select=id&id=eq.${encodeURIComponent(documentId)}` +
    `&or=(ingest_started_at.is.null,ingest_started_at.lt.${encodeURIComponent(cutoff)})`,
    { method: 'PATCH', body: JSON.stringify({ ingest_started_at: new Date().toISOString() }) }
  );
  return rows.length > 0;
}

/**
 * The claim is RELEASED through updateDocument, not through a function
 * of its own — `ingest_started_at: null` rides along with the terminal
 * `status` write in both the success and the failure path. One write
 * rather than two means there is no window where a document is `ready`
 * but still claimed, and no second call to forget on a new code path.
 */

/**
 * Record the embedding model a bot's corpus was last built with (012).
 *
 * Written by both ingest paths on success only, and read by `retrieve`
 * to detect drift. Never by a tenant: like knowledge_migrated_at this
 * is a statement that something succeeded, not a setting, so it is
 * deliberately absent from BotUpdatePayload.
 */
export async function setBotIndexedModel(
  db: ServiceDb, botId: string, model: string,
): Promise<void> {
  await pgFetch<unknown>(db,
    `/bots?id=eq.${encodeURIComponent(botId)}`,
    { method: 'PATCH',
      body: JSON.stringify({ embedding_model_indexed: model }),
      headers: { 'Prefer': 'return=minimal' } }
  );
}

// ----------------------------------------------------------------
// Chunks
// ----------------------------------------------------------------
export async function listChunks(db: UserDb, documentId: string, limit = 200): Promise<ChunkRow[]> {
  // No embedding column: 768 floats per row is megabytes of JSON the
  // chunk inspector has no use for. No `search` either — it is the
  // whole content again, tokenised.
  return pgFetch<ChunkRow[]>(db,
    `/chunks?select=id,document_id,ordinal,content,created_at,kind,priority,metadata&document_id=eq.${encodeURIComponent(documentId)}&order=ordinal.asc&limit=${limit}`
  );
}

/**
 * Replace a document's chunks atomically enough for our purposes:
 * delete then insert. A re-index that fails after the delete leaves
 * the document with zero chunks and status 'failed', which is
 * recoverable by re-running and is preferable to duplicated chunks
 * silently doubling every retrieval score.
 */
export interface ChunkInsert {
  ordinal: number;
  content: string;
  embedding: number[];
  /** Defaults to the column default, 'prose'. */
  kind?: ChunkKind;
  /** Defaults to 0. FAQ chunks ingest at 1 — see 011_knowledge.sql. */
  priority?: number;
  metadata?: Record<string, unknown> | null;
}

export async function replaceChunks(
  db: ServiceDb,
  args: { documentId: string; botId: string; rows: ChunkInsert[] },
): Promise<void> {
  await pgFetch<unknown>(db,
    `/chunks?document_id=eq.${encodeURIComponent(args.documentId)}`,
    { method: 'DELETE', headers: { 'Prefer': 'return=minimal' } }
  );

  if (args.rows.length === 0) return;

  // pgvector accepts the '[1,2,3]' text form over PostgREST.
  //
  // kind, priority and metadata are omitted rather than defaulted here
  // when the caller did not set them: PostgREST fills every row in one
  // insert from the union of the keys present, so a mixed batch would
  // otherwise send explicit nulls for the rows that left them out and
  // trip the NOT NULL on kind.
  const payload = args.rows.map((r) => ({
    document_id: args.documentId,
    bot_id:      args.botId,
    ordinal:     r.ordinal,
    content:     r.content,
    embedding:   `[${r.embedding.join(',')}]`,
    kind:        r.kind ?? 'prose',
    priority:    r.priority ?? 0,
    metadata:    r.metadata ?? null,
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

/** The row shape both retrieval channels return. `similarity` is a
 *  cosine score from match_chunks and a ts_rank_cd score from
 *  match_chunks_lexical — the two are NOT on the same scale, which is
 *  why the caller tracks which channel produced a row. */
export interface MatchedChunk {
  id: string;
  document_id: string;
  ordinal: number;
  content: string;
  similarity: number;
  kind?: ChunkKind;
  priority?: number;
  /** Folded into both RPCs by 012 (the S2 title fold), which is what
   *  removed getDocumentTitles from the chat path. Optional so a Worker
   *  running ahead of the migration still parses the older row shape. */
  document_title?: string | null;
}

export async function matchChunks(
  db: ServiceDb,
  args: {
    botId: string; embedding: number[]; matchCount: number;
    minSimilarity: number; priorityBoost?: number;
  },
): Promise<MatchedChunk[]> {
  return pgFetch(db, '/rpc/match_chunks',
    { method: 'POST',
      body: JSON.stringify({
        p_bot_id:         args.botId,
        p_query:          `[${args.embedding.join(',')}]`,
        p_match_count:    args.matchCount,
        p_min_similarity: args.minSimilarity,
        p_priority_boost: args.priorityBoost ?? 0,
      }) }
  );
}

/**
 * Lexical search.
 *
 * `minPriority` is what decides which of the two jobs this does, and it
 * is a parameter rather than a constant since 013:
 *
 *   1 — curated, boosted chunks only. The fallback channel, called only
 *       when the vector search returned nothing. That asymmetry is
 *       deliberate; see the note in src/rag/retrieve.ts.
 *   0 — the whole corpus. What hybrid mode asks for, because the case
 *       keyword search wins is a proper noun buried in a PDF, which is
 *       a priority-0 prose chunk by construction.
 *
 * Omitted means 1, matching both the SQL default and every caller that
 * predates hybrid.
 */
export async function matchChunksLexical(
  db: ServiceDb,
  args: { botId: string; query: string; matchCount: number; minPriority?: number },
): Promise<MatchedChunk[]> {
  return pgFetch(db, '/rpc/match_chunks_lexical',
    { method: 'POST',
      body: JSON.stringify({
        p_bot_id:       args.botId,
        p_query_text:   args.query,
        p_match_count:  args.matchCount,
        p_min_priority: args.minPriority ?? 1,
      }) }
  );
}

/** One curated Q&A that matched a visitor's message closely enough to
 *  answer it outright (016). `similarity` is a pg_trgm score, 0-1 and
 *  normalised — which is the whole reason this is a separate RPC from
 *  match_chunks_lexical, whose ts_rank is neither. */
export interface MatchedFaqItem {
  id: string;
  question: string;
  answer: string;
  similarity: number;
}

/**
 * Trigram search over a bot's curated FAQ questions.
 *
 * Reads `faq_items` directly rather than the corpus, so it works before
 * the FAQ has been ingested and on a bot whose embedding vendor is
 * misconfigured. Disabled items are excluded in SQL.
 */
export async function matchFaqItems(
  db: ServiceDb,
  args: { botId: string; query: string; matchCount?: number; minSimilarity: number },
): Promise<MatchedFaqItem[]> {
  return pgFetch(db, '/rpc/match_faq_items',
    { method: 'POST',
      body: JSON.stringify({
        p_bot_id:         args.botId,
        p_query_text:     args.query,
        p_match_count:    args.matchCount ?? 1,
        p_min_similarity: args.minSimilarity,
      }) }
  );
}

/**
 * Whether a bot has anything indexed — lets the chat path skip the
 * embedding call entirely for bots with no corpus.
 *
 * SUPERSEDED BY `bots.chunk_count` (013, S2), and kept as the fallback
 * for a Worker running ahead of that migration. Once every deployment
 * has the column this is one round trip per chat turn that nobody pays.
 * Do not add new callers.
 */
export async function hasChunks(db: ServiceDb, botId: string): Promise<boolean> {
  const rows = await pgFetch<Array<{ id: string }>>(db,
    `/chunks?select=id&bot_id=eq.${encodeURIComponent(botId)}&limit=1`
  );
  return rows.length > 0;
}

// ----------------------------------------------------------------
// FAQ items (011)
//
// Split by scope like everything else. The editor writes under RLS as
// the tenant; ingestion reads with the service client, because it runs
// from waitUntil after the request that triggered it has gone.
// ----------------------------------------------------------------
const FAQ_FIELDS = 'id,bot_id,org_id,document_id,question,answer,position,enabled,created_at,updated_at';

/** The title of every bot's FAQ document. Not tenant-editable: it is
 *  what citations name and what the Sources list shows, and letting it
 *  drift would make one concept read as two. */
export const FAQ_DOCUMENT_TITLE = 'Frequently Asked Questions';

export async function listFaqItems(db: UserDb, botId: string): Promise<FaqItem[]> {
  return pgFetch<FaqItem[]>(db,
    `/faq_items?select=${FAQ_FIELDS}&bot_id=eq.${encodeURIComponent(botId)}&order=position.asc,created_at.asc`
  );
}

/** Only the enabled items, in order — exactly what gets embedded. */
export async function listFaqItemsForIngest(db: ServiceDb, botId: string): Promise<FaqItem[]> {
  return pgFetch<FaqItem[]>(db,
    `/faq_items?select=${FAQ_FIELDS}&bot_id=eq.${encodeURIComponent(botId)}&enabled=is.true&order=position.asc,created_at.asc`
  );
}

export async function getFaqItem(db: UserDb, itemId: string): Promise<FaqItem | null> {
  const rows = await pgFetch<FaqItem[]>(db,
    `/faq_items?select=${FAQ_FIELDS}&id=eq.${encodeURIComponent(itemId)}&limit=1`
  );
  return rows[0] ?? null;
}

export async function createFaqItem(
  db: UserDb,
  args: { botId: string; documentId: string; question: string; answer: string; position: number; enabled?: boolean },
): Promise<FaqItem> {
  const rows = await pgFetch<FaqItem[]>(db, '/faq_items', {
    method: 'POST',
    body: JSON.stringify({
      bot_id:      args.botId,
      document_id: args.documentId,
      question:    args.question,
      answer:      args.answer,
      position:    args.position,
      ...(args.enabled !== undefined && { enabled: args.enabled }),
    }),
  });
  if (!rows[0]) throw new Error('FAQ item not returned after insert');
  return rows[0];
}

export async function updateFaqItem(
  db: UserDb, itemId: string, patch: FaqItemPayload,
): Promise<FaqItem | null> {
  const rows = await pgFetch<FaqItem[]>(db,
    `/faq_items?id=eq.${encodeURIComponent(itemId)}`,
    { method: 'PATCH', body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }) }
  );
  return rows[0] ?? null;
}

export async function deleteFaqItem(db: UserDb, itemId: string): Promise<FaqItem | null> {
  const rows = await pgFetch<FaqItem[]>(db,
    `/faq_items?id=eq.${encodeURIComponent(itemId)}`,
    { method: 'DELETE' }
  );
  return rows[0] ?? null;
}

/**
 * Rewrite `position` across a bot's FAQ in one request.
 *
 * The caller sends ids only. Every other column is taken from the
 * stored row rather than from the request, so the reorder path cannot
 * be used to edit an answer — an upsert needs the whole row, and the
 * whole row arriving from a browser is the difference between "move
 * item 3 up" and "replace item 3".
 *
 * Ids the bot does not own are dropped rather than rejected: RLS would
 * refuse them anyway, and a stale tab that reorders around a deleted
 * item should still reorder the rest.
 */
export async function reorderFaqItems(
  db: UserDb, botId: string, order: string[],
): Promise<FaqItem[]> {
  const stored = await listFaqItems(db, botId);
  const byId = new Map(stored.map((item) => [item.id, item]));

  const now = new Date().toISOString();
  const rows = order
    .map((id, index) => {
      const item = byId.get(id);
      if (!item) return null;
      return {
        id:          item.id,
        bot_id:      item.bot_id,
        document_id: item.document_id,
        question:    item.question,
        answer:      item.answer,
        enabled:     item.enabled,
        position:    index,
        updated_at:  now,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (rows.length === 0) return stored;

  // org_id is deliberately absent: the BEFORE INSERT trigger derives it,
  // and leaving it out of the payload keeps it out of the ON CONFLICT
  // SET list too, so an upsert can never move a row between tenants.
  await pgFetch<unknown>(db, '/faq_items', {
    method: 'POST',
    body: JSON.stringify(rows),
    headers: { 'Prefer': 'return=minimal,resolution=merge-duplicates' },
  });

  return listFaqItems(db, botId);
}

/**
 * The bot's FAQ document, or null.
 *
 * There is at most one — 011 has a partial unique index saying so,
 * because two would both index and both retrieve, doubling the weight
 * of every FAQ answer.
 */
export async function getFaqDocument(db: AnyDb, botId: string): Promise<Document | null> {
  const rows = await pgFetch<Document[]>(db,
    `/documents?select=${DOC_FIELDS}&bot_id=eq.${encodeURIComponent(botId)}&source=eq.faq&limit=1`
  );
  return rows[0] ?? null;
}

/** Get it, or make it. Called before the first item is added, and by
 *  the cutover. */
export async function ensureFaqDocument(db: UserDb, botId: string): Promise<Document> {
  const existing = await getFaqDocument(db, botId);
  if (existing) return existing;

  try {
    return await createDocument(db, {
      bot_id:  botId,
      source:  'faq',
      title:   FAQ_DOCUMENT_TITLE,
      content: null,
    });
  } catch (err) {
    // Two tabs adding their first item at once: one loses the unique
    // index and re-reads rather than failing the tenant's edit.
    const found = await getFaqDocument(db, botId);
    if (found) return found;
    throw err;
  }
}

/**
 * Stamp — or clear — the knowledge cutover flag.
 *
 * Not routed through updateBot and deliberately not in
 * BotUpdatePayload: this is not a setting a tenant edits, it is a
 * statement that an ingest succeeded. Passing null reverts the bot to
 * the pre-011 prompt.
 */
export async function setKnowledgeMigrated(
  db: UserDb, botId: string, at: string | null,
): Promise<Bot | null> {
  const rows = await pgFetch<Bot[]>(db,
    `/bots?id=eq.${encodeURIComponent(botId)}`,
    { method: 'PATCH', body: JSON.stringify({ knowledge_migrated_at: at }) }
  );
  return rows[0] ?? null;
}

// ----------------------------------------------------------------
// Retrieval log (012)
//
// Written by the chat path with the service client, read by the
// dashboard as the user so RLS scopes it. Same split as everything
// else — and here it is load-bearing rather than conventional, because
// the table has no tenant write policy at all: this is derived data,
// and a tenant forging their own miss report is not a state worth
// allowing.
// ----------------------------------------------------------------
export interface RetrievalLogInsert {
  bot_id: string;
  session_id: string | null;
  query: string;
  matched: boolean;
  /** Free text in the column on purpose (012), so a third channel needs
   *  no migration — 013 added 'hybrid'. NULL on a miss. */
  channel: 'vector' | 'lexical' | 'hybrid' | 'faq-direct' | null;
  top_score: number | null;
  chunk_count: number;
  min_similarity: number | null;
  embedding_model: string | null;
}

/**
 * Record one turn's retrieval outcome. NEVER THROWS.
 *
 * Called from `waitUntil`, so a rejection here would be an unhandled
 * one in a context the request has already left — and more to the
 * point, a bot must not have a worse conversation because its
 * analytics table is unavailable. The whole failure surface of this
 * feature is "the report is missing a row".
 *
 * `return=minimal` because nothing reads the row back, and the query
 * text is the largest field on it.
 */
export async function logRetrieval(db: ServiceDb, row: RetrievalLogInsert): Promise<void> {
  try {
    await pgFetch<unknown>(db, '/retrieval_log',
      { method: 'POST',
        body: JSON.stringify(row),
        headers: { 'Prefer': 'return=minimal' } }
    );
  } catch (err) {
    console.error('[retrieval-log] write failed (non-fatal):', err);
  }
}

/**
 * Delete rows older than `days`, returning how many went.
 *
 * The number is CLAMPED INSIDE THE FUNCTION, into [7, 365] — see
 * 012_retrieval.sql. Passing a bad value from here is not merely
 * guarded against, it is unrepresentable: the Worker holds a
 * service-role key, and this is the one table where a wrong number
 * deletes tenant data outright.
 */
export async function pruneRetrievalLog(db: ServiceDb, days: number): Promise<number> {
  const deleted = await pgFetch<number | string>(db, '/rpc/prune_retrieval_log',
    { method: 'POST', body: JSON.stringify({ p_days: days }) }
  );
  return Number(deleted) || 0;
}

/** The same ceiling reasoning as STATS_MESSAGE_CAP: past it the report
 *  would silently under-report, so it is surfaced rather than hidden. */
export const RETRIEVAL_LOG_CAP = 4000;

export interface RetrievalLogRow {
  query: string;
  matched: boolean;
  channel: string | null;
  top_score: number | null;
  chunk_count: number;
  min_similarity: number | null;
  embedding_model: string | null;
  created_at: string;
}

/**
 * Drops every logged miss of one exact question.
 *
 * ServiceDb rather than UserDb, and that is not an oversight: 012 gives
 * tenants select on retrieval_log and no write policy at all, because
 * this is derived data and a tenant editing their own measurements is
 * not a state worth allowing. Removing a question they have dealt with
 * is the one exception, so it goes through the service client with the
 * ownership check already done by the caller.
 *
 * `matched=is.false` is load bearing. Only the misses are shown and only
 * the misses are removable; the rows that DID match are the denominator
 * behind the miss rate, and deleting those would move the number the
 * tenant is trying to improve.
 */
export async function deleteMissedQuestion(
  db: ServiceDb, botId: string, query: string,
): Promise<number> {
  const rows = await pgFetch<{ id: string }[]>(db,
    `/retrieval_log?select=id` +
    `&bot_id=eq.${encodeURIComponent(botId)}` +
    `&query=eq.${encodeURIComponent(query)}` +
    `&matched=is.false`,
    { method: 'DELETE' }
  );
  return rows.length;
}

export function getRetrievalLog(
  db: UserDb, botId: string, since: string, cap = RETRIEVAL_LOG_CAP,
): Promise<RetrievalLogRow[]> {
  return pgFetch<RetrievalLogRow[]>(db,
    `/retrieval_log?select=query,matched,channel,top_score,chunk_count,min_similarity,embedding_model,created_at` +
    `&bot_id=eq.${encodeURIComponent(botId)}` +
    `&created_at=gte.${encodeURIComponent(since)}` +
    `&order=created_at.desc&limit=${cap}`
  );
}

// ----------------------------------------------------------------
// Usage log (017)
//
// Same split as retrieval_log and for the same reason: written by the
// chat, preview and ingest paths with the service client, read by the
// dashboard as the user so RLS scopes it. There is no tenant write
// policy on the table at all — this is derived data, and a tenant
// editing their own meter is not a state worth allowing.
//
// ONE ROW PER PROVIDER CALL, not per turn. See the table comment in
// 017_usage.sql.
// ----------------------------------------------------------------
export interface UsageLogInsert {
  bot_id: string;
  /** Null for ingest and preview: neither belongs to a visitor's
   *  conversation. */
  session_id: string | null;
  /** Free text in the column on purpose (017), so a fourth kind —
   *  rerank is the obvious next one — needs no migration. */
  kind: 'chat' | 'embed' | 'preview';
  vendor: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  /** 'reported' when the vendor returned these counts, 'estimated'
   *  when they came from the character estimator. The column that
   *  keeps a shape from being mistaken for a bill — see usageTokens in
   *  src/stats.ts. */
  source: 'reported' | 'estimated';
  /** Omitted means 'ok' (the column default), so a Worker running
   *  ahead of a database without the column still inserts cleanly. */
  outcome?: 'ok' | 'error';
}

/**
 * Record one provider call's token spend. NEVER THROWS.
 *
 * Byte-for-byte the logRetrieval treatment, and the reason is the same
 * one stated more strongly: A METERING FAILURE MUST NEVER COST A
 * VISITOR THEIR ANSWER. Metering is the platform's own bookkeeping;
 * the tenant's customer is mid-sentence. Called from `waitUntil` on
 * every chat path, so a rejection here would be an unhandled one in a
 * context the request has already left.
 *
 * `return=minimal` because nothing reads the row back.
 */
export async function logUsage(db: ServiceDb, row: UsageLogInsert): Promise<void> {
  try {
    await pgFetch<unknown>(db, '/usage_log',
      { method: 'POST',
        body: JSON.stringify(row),
        headers: { 'Prefer': 'return=minimal' } }
    );
  } catch (err) {
    console.error('[usage-log] write failed (non-fatal):', err);
  }
}

/**
 * Delete rows older than `days`, returning how many went.
 *
 * Clamped INSIDE the function into [30, 800] — see 017_usage.sql. The
 * bounds are wider than prune_retrieval_log's because this table is
 * billing history rather than a privacy commitment, and a tenant
 * comparing this March against last March needs more than a year of
 * rows to compare.
 */
export async function pruneUsageLog(db: ServiceDb, days: number): Promise<number> {
  const deleted = await pgFetch<number | string>(db, '/rpc/prune_usage_log',
    { method: 'POST', body: JSON.stringify({ p_days: days }) }
  );
  return Number(deleted) || 0;
}

/** Same ceiling reasoning as RETRIEVAL_LOG_CAP: past it the report
 *  would silently under-report, so it is surfaced rather than hidden.
 *  Move to an RPC when a bot regularly hits it — not before. */
export const USAGE_LOG_CAP = 4000;

export interface UsageLogRow {
  kind: string;
  vendor: string;
  model: string;
  input_tokens: number | null;
  output_tokens: number | null;
  source: string;
  outcome: string;
  created_at: string;
}

/** `cached_input_tokens` is deliberately not selected: it exists in
 *  the schema so prompt caching lands as a type change rather than a
 *  migration against a populated table, and nothing writes it yet. */
export function getUsageLog(
  db: UserDb, botId: string, since: string, cap = USAGE_LOG_CAP,
): Promise<UsageLogRow[]> {
  return pgFetch<UsageLogRow[]>(db,
    `/usage_log?select=kind,vendor,model,input_tokens,output_tokens,source,outcome,created_at` +
    `&bot_id=eq.${encodeURIComponent(botId)}` +
    `&created_at=gte.${encodeURIComponent(since)}` +
    `&order=created_at.desc&limit=${cap}`
  );
}

// ── Overview statistics ───────────────────────────────────────────
//
// Aggregated in the Worker rather than in Postgres. A `group by` here
// would mean an RPC function and therefore a migration, and at this
// volume the round trip is cheaper than the deployment coupling. The
// row caps below are the ceiling on that trade: past them the counts
// would silently under-report, so they are returned to the caller and
// surfaced rather than hidden. Move to an RPC when a bot regularly
// hits them.
export const STATS_MESSAGE_CAP = 4000;
export const STATS_LEAD_CAP = 1000;

/** Only the columns the aggregates need — `content` is the expensive one
 *  and is fetched for user turns alone. */
export interface StatMessageRow {
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}
export interface StatLeadRow { created_at: string; session_id: string }
export interface StatDocRow { status: string; chunk_count: number }

export function getStatMessages(db: UserDb, botId: string, since: string): Promise<StatMessageRow[]> {
  return pgFetch<StatMessageRow[]>(db,
    `/conversations?select=session_id,role,content,created_at` +
    `&bot_id=eq.${encodeURIComponent(botId)}` +
    `&created_at=gte.${encodeURIComponent(since)}` +
    `&order=created_at.desc&limit=${STATS_MESSAGE_CAP}`
  );
}

export function getStatLeads(db: UserDb, botId: string, since: string): Promise<StatLeadRow[]> {
  return pgFetch<StatLeadRow[]>(db,
    `/leads?select=created_at,session_id` +
    `&bot_id=eq.${encodeURIComponent(botId)}` +
    `&created_at=gte.${encodeURIComponent(since)}` +
    `&order=created_at.desc&limit=${STATS_LEAD_CAP}`
  );
}

export function getStatDocuments(db: UserDb, botId: string): Promise<StatDocRow[]> {
  return pgFetch<StatDocRow[]>(db,
    `/documents?select=status,chunk_count&bot_id=eq.${encodeURIComponent(botId)}`
  );
}
