// ----------------------------------------------------------------
// Typed client for the Worker's /v1/admin surface.
// ----------------------------------------------------------------
import { API } from './config';
import { clearSession, forceRefresh, freshToken } from './auth';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function send(method: string, path: string, body: unknown, token: string) {
  return fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res = await send(method, path, body, await freshToken());

  // A 401 after a pre-emptive refresh means the token was revoked or
  // rotated elsewhere. One retry, then back to the login screen.
  if (res.status === 401) {
    try {
      res = await send(method, path, body, await forceRefresh());
    } catch {
      clearSession();
      throw new ApiError(401, 'Session expired — please sign in again.');
    }
  }

  if (res.status === 204) return null as T;

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    throw new ApiError(res.status, (data as { error?: string })?.error ?? res.statusText);
  }
  return data as T;
}

export const api = {
  get:  <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  put:  <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  del:  <T>(path: string) => request<T>('DELETE', path),
};

/**
 * Multipart upload, over XMLHttpRequest rather than fetch.
 *
 * fetch cannot report how much of a request body has been sent, and for
 * a 10 MB file on a slow connection the difference between "uploading"
 * and "frozen" is the whole of the user's experience. XHR is the only
 * API in the browser that exposes upload progress.
 */
function sendFile(
  path: string,
  form: FormData,
  token: string,
  onProgress?: (fraction: number) => void,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API}${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    // Deliberately no Content-Type: the browser has to set it so the
    // multipart boundary matches the body it generates.

    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload  = () => resolve({ status: xhr.status, text: xhr.responseText });
    xhr.onerror = () => reject(new ApiError(0, 'Upload failed — check your connection.'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled.'));
    xhr.send(form);
  });
}

export async function uploadDocument(
  botId: string,
  file: File,
  opts: { title?: string; onProgress?: (fraction: number) => void } = {},
): Promise<Doc> {
  const build = () => {
    const form = new FormData();
    form.append('file', file);
    if (opts.title?.trim()) form.append('title', opts.title.trim());
    return form;
  };

  const path = `/v1/admin/bots/${botId}/documents/upload`;
  let res = await sendFile(path, build(), await freshToken(), opts.onProgress);

  // Same one-retry rule as request(): a 401 after a pre-emptive refresh
  // means the token was rotated elsewhere.
  if (res.status === 401) {
    try {
      res = await sendFile(path, build(), await forceRefresh(), opts.onProgress);
    } catch {
      clearSession();
      throw new ApiError(401, 'Session expired — please sign in again.');
    }
  }

  const data = res.text ? JSON.parse(res.text) : null;
  if (res.status < 200 || res.status >= 300) {
    throw new ApiError(res.status, (data as { error?: string })?.error ?? `Upload failed (${res.status})`);
  }
  return data as Doc;
}

/**
 * Same multipart path as uploadDocument, and the same one-retry rule.
 * Returns the updated bot, so the caller can patch its state without a
 * refetch — `logo_url` on it is what the settings screen renders.
 */
export async function uploadLogo(
  botId: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<Bot> {
  const build = () => {
    const form = new FormData();
    form.append('file', file);
    return form;
  };

  const path = `/v1/admin/bots/${botId}/logo`;
  let res = await sendFile(path, build(), await freshToken(), onProgress);

  if (res.status === 401) {
    try {
      res = await sendFile(path, build(), await forceRefresh(), onProgress);
    } catch {
      clearSession();
      throw new ApiError(401, 'Session expired — please sign in again.');
    }
  }

  const data = res.text ? JSON.parse(res.text) : null;
  if (res.status < 200 || res.status >= 300) {
    throw new ApiError(res.status, (data as { error?: string })?.error ?? `Upload failed (${res.status})`);
  }
  return data as Bot;
}

// ── Shapes returned by the Worker ────────────────────────────────
export interface Org { id: string; name: string | null; slug: string | null; plan: string | null; role: string }
export interface Me { userId: string; email: string | null; orgs: Org[] }

/** apiKey is never returned — the API replaces it with these two. */
export interface VendorConfig {
  vendor?: string;
  model?: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  dimensions?: number;
  apiKey?: string;
  hasApiKey?: boolean;
  apiKeyLast4?: string | null;
}

export interface RagConfig {
  enabled?: boolean;
  top_k?: number;
  min_similarity?: number;
  chunk_size?: number;
  chunk_overlap?: number;
  /** Ceiling on the rendered retrieval section, in characters (011). */
  context_chars?: number;
  /** Similarity points added per priority level when ordering. FAQ
   *  chunks index at priority 1. Ordering only — it can never push a
   *  chunk past the minimum similarity. */
  priority_boost?: number;
  /** Try keyword search when the vector search finds nothing at all.
   *  Read only in `retrieval_mode: 'fallback'`. */
  lexical_fallback?: boolean;
  /** How the two channels combine (013). 'fallback' is the default and
   *  is what every bot did before this field existed; 'hybrid' runs
   *  both on every turn over the whole corpus and fuses them by rank. */
  retrieval_mode?: 'vector' | 'fallback' | 'hybrid';
  /** Re-rank the candidates with a cross-encoder before the prompt
   *  budget is applied (013). Off by default: one extra model call per
   *  message. Degrades to plain similarity order if the deployment has
   *  no Workers AI binding. */
  rerank?: boolean;
  /** Skip retrieval entirely on turns where it is pointless — closings,
   *  acknowledgements, a bare contact detail (015). Off by default. */
  router?: 'off' | 'on';
  /** Trigram similarity above which a curated FAQ question answers the
   *  turn outright, with no embedding call (016). 0 is off. */
  faq_shortcut_threshold?: number;
}

export type WidgetPosition = 'bottom-right' | 'bottom-left';
export type WidgetTheme = 'light' | 'dark' | 'auto';

/** bots.widget_config. logo_key is deliberately absent: the API strips
 *  it and sends `Bot.logo_url` instead, and posting it back is a 400. */
export interface WidgetConfig {
  position?: WidgetPosition;
  theme?: WidgetTheme;
  greeting?: string;
  greeting_delay_ms?: number;
  show_typing?: boolean;
  show_citations?: boolean;
}

export interface BehaviorConfig {
  max_messages?: number;
  fallback_message?: string;
  escalate_after_misses?: number;
}

export type LeadTrigger = 'intent' | 'always' | 'after_messages';
export type LeadFieldMode = 'off' | 'optional' | 'required';
export type WebhookFormat = 'json' | 'slack' | 'teams';

/**
 * bots.lead_config. `webhook_url` is deliberately absent for the same
 * reason logo_key is: the API strips it before this ever reaches the
 * browser, because a Slack incoming-webhook URL is a credential.
 *
 * What comes back instead is `has_webhook` + `webhook_host`, which is
 * enough to say "posting to hooks.slack.com" and offer a Remove button.
 * Sending a new URL sets one; sending `webhook_url: null` clears it;
 * sending neither leaves whatever is stored alone.
 */
export interface LeadConfig {
  enabled?: boolean;
  trigger?: LeadTrigger;
  trigger_after_messages?: number;
  fields?: { phone?: LeadFieldMode; company?: LeadFieldMode; inquiry?: LeadFieldMode };
  consent_text?: string;
  success_message?: string;
  booking_url?: string;
  tag?: string;
  webhook_format?: WebhookFormat;
  /**
   * WRITE-ONLY — never present on a bot read back from the API. A
   * string sets it, `null` clears it, and omitting it keeps whatever
   * is stored.
   */
  webhook_url?: string | null;
  /** Not a secret the way the webhook URL is, so this round-trips
   *  normally. Sending needs Resend configured on the deployment. */
  email_recipients?: string[];
  /** Read-only, derived. */
  has_webhook?: boolean;
  /** Read-only, derived. Null when no webhook is set. */
  webhook_host?: string | null;
}

/** One label and one URL — socials and custom links. */
export interface ProfileLink { label: string; url: string }
/** `"HH:MM"`, 24-hour, validated as strings by the Worker. */
export interface HoursInterval { open: string; close: string }
export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export interface HoursException {
  date: string; closed?: boolean; open?: string; close?: string; label?: string;
}

/**
 * bots.profile (015) — the structured business facts rendered into
 * every system prompt.
 *
 * REPLACED WHOLESALE ON SAVE, with nothing carried forward. Unlike
 * widget_config and lead_config it holds no secret, so there is no
 * exception to look for — which is also why every section of the
 * Business Profile screen has to post the WHOLE object, not just its
 * own keys.
 */
export interface BusinessProfile {
  identity?: { legal_name?: string; tagline?: string; industry?: string };
  location?: {
    line1?: string; line2?: string; city?: string; region?: string;
    postal?: string; country?: string; map_url?: string;
    service_area?: string; parking?: string; notes?: string;
  };
  contact?: {
    phone?: string; whatsapp?: string; email?: string;
    support_email?: string; notes?: string; socials?: ProfileLink[];
  };
  hours?: {
    timezone?: string;
    regular?: Partial<Record<DayKey, HoursInterval[]>>;
    exceptions?: HoursException[];
    notes?: string;
  };
  links?: {
    booking_url?: string; pricing_url?: string; portal_url?: string;
    custom?: ProfileLink[];
  };
  policies?: {
    payment_methods?: string[]; cancellation?: string; deposit?: string;
    accessibility?: string; languages?: string[];
  };
}

export interface Bot {
  id: string;
  org_id: string;
  name: string;
  business_name: string;
  /** @deprecated superseded by `profile.hours`. Still rendered while
   *  `profile` is null, which is every bot until it is backfilled. */
  hours: string | null;
  /** @deprecated superseded by `profile.location`. */
  location: string | null;
  /** @deprecated superseded by `profile.contact`. */
  contact: string | null;
  services: string | null;
  custom_instructions: string | null;
  primary_color: string;
  /** @deprecated superseded by allowed_origins. */
  allowed_origin: string | null;
  allowed_origins: string[] | null;
  /** Widget starter chips. Null = the widget's neutral defaults. */
  suggestions: string[] | null;
  created_at: string;
  business_description: string | null;
  faq: string | null;
  /** @deprecated superseded by `profile.contact.email`. */
  contact_email: string | null;
  /** @deprecated superseded by `profile.contact.phone`. */
  contact_phone: string | null;
  /** @deprecated superseded by `profile.location`. */
  address: string | null;
  /** NULL means the six legacy columns above are what the prompt
   *  renders, byte for byte as it did before 015. */
  profile: BusinessProfile | null;
  provider_config: VendorConfig | null;
  embedding_config: VendorConfig | null;
  rag_config: RagConfig | null;
  widget_config: WidgetConfig | null;
  behavior_config: BehaviorConfig | null;
  lead_config: LeadConfig | null;
  /** Served by the Worker from R2; null when no logo is set. Read-only —
   *  it is derived from a key the dashboard never sees. */
  logo_url: string | null;
  /**
   * NULL until this bot's services and FAQ have been moved into the
   * corpus (011). While it is NULL both are still pasted into every
   * system prompt, which is what the migration banner is about.
   * Read-only: the cutover endpoints set it, never a settings save.
   */
  knowledge_migrated_at?: string | null;
}

export interface Vendor {
  id: string;
  label: string;
  costTier: 'paid' | 'free-tier' | 'local';
  defaultChatModel: string;
  defaultEmbedModel: string | null;
  embedDimensions: number | null;
  supportsEmbeddings: boolean;
  requiresKey: boolean;
  requiresBaseUrl: boolean;
  keyConfigured: boolean;
}

export interface Doc {
  id: string;
  bot_id: string;
  source: 'text' | 'url' | 'markdown' | 'file' | 'faq';
  title: string;
  url: string | null;
  status: 'pending' | 'processing' | 'ready' | 'failed';
  error: string | null;
  chunk_count: number;
  embedding_model: string | null;
  embedding_dimensions: number | null;
  created_at: string;
  /** File sources only — the bytes live in R2, not in Postgres. */
  r2_key?: string | null;
  mime_type?: string | null;
  size_bytes?: number | null;
}

export interface Chunk {
  id: string;
  ordinal: number;
  content: string;
  /** 011. Absent on a chunk indexed before the migration. */
  kind?: 'prose' | 'faq';
  priority?: number;
  metadata?: Record<string, unknown> | null;
}

/** One question and its answer (011). Indexed as its own chunk. */
export interface FaqItem {
  id: string;
  bot_id: string;
  document_id: string;
  question: string;
  answer: string;
  position: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface FaqResponse {
  items: FaqItem[];
  /** The synthetic document the items are indexed through. Null until
   *  the first item is added. Its `status` is the indexing state for
   *  the whole FAQ. */
  document: Doc | null;
  limits: { items: number; question: number; answer: number };
}

/** One row of the "what would this retrieve?" preview. */
export interface PreviewChunk {
  id: string;
  document_id: string;
  document_title: string | null;
  ordinal: number;
  content: string;
  /** A cosine similarity on the vector channel, a text rank on the
   *  lexical one. Not comparable across channels, which is why the
   *  channel is reported alongside it rather than the two rescaled. */
  score: number;
  kind: 'prose' | 'faq';
  priority: number;
  /** Never 'hybrid': a fused result is a mix, and each chunk keeps the
   *  channel that actually found it. The outcome-level channel below is
   *  where 'hybrid' appears. */
  channel: 'vector' | 'lexical' | 'faq-direct' | null;
}

/** Which embedding model ran, and where its similarity floor came from.
 *  Reported rather than recomputed: the floor depends on the resolved
 *  embedder, so a number rebuilt in the browser would be a different one
 *  from the one the query was actually filtered by. */
export interface EffectiveRetrieval {
  min_similarity: number;
  embedding_model: string;
  /** 'tenant'  — an explicit min_similarity on this bot.
   *  'model'   — measured for the resolved embedding model.
   *  'default' — the unmeasured fallback; nothing knows this model. */
  floor_source: 'tenant' | 'model' | 'default';
}

export interface RetrievePreview {
  query: string;
  channel: 'vector' | 'lexical' | 'hybrid' | 'faq-direct' | null;
  /** 'stale-index' means the corpus was built with a different
   *  embedding model, so nothing was searched at all. 'routed' means
   *  the router decided this turn had nothing to search FOR. */
  skipped: 'disabled' | 'empty-query' | 'stale-index' | 'routed' | null;
  /** What the router decided for this query, and why — reported whether
   *  or not the router is switched on, so "what would this do today" and
   *  "what would this do if I turned it on" are both answerable. */
  route: 'skip' | 'faq' | 'retrieve';
  route_reason: string;
  error: string | null;
  settings: Required<Pick<RagConfig,
    'top_k' | 'min_similarity' | 'priority_boost' | 'lexical_fallback' | 'context_chars'
    | 'retrieval_mode' | 'rerank' | 'router' | 'faq_shortcut_threshold'>>;
  effective: EffectiveRetrieval | null;
  chunks: PreviewChunk[];
  /** Exactly what would be pasted into the system prompt. */
  context: string;
  rendered_count: number;
}

// ── The miss report (012) ────────────────────────────────────────
export interface MissQuestion { text: string; count: number; lastAsked: string }

export interface MissReport {
  range: { days: number; from: string; to: string };
  totals: {
    queries: number; misses: number; missRate: number | null;
    /** Visitor messages over the window. Null when the Worker could not
     *  read them — the rate below is then null too. */
    turns: number | null;
    /** 0–1: turns answered with no search at all. Measured as turns
     *  minus logged searches, so it counts every reason a turn did not
     *  search, not the router alone. */
    noSearchRate: number | null;
  };
  questions: MissQuestion[];
  channels: {
    vector: number; lexical: number; hybrid: number;
    /** Answered straight from a curated FAQ item, with no embedding
     *  call at all (016). */
    faqDirect: number;
    missed: number;
  };
  scores: {
    /** Median cosine score on turns the vector channel answered. */
    hitMedian: number | null;
    /** Highest score on a turn that still showed the model nothing.
     *  Usually null — the floor rejects inside the database. */
    missMax: number | null;
    /** The floor those scores were tested against. Without it a median
     *  is a number with no meaning. */
    floor: number | null;
  };
  truncated: boolean;
}

export interface MigrateResult {
  bot: Bot | null;
  plan: {
    faq_items_existing: number;
    faq_items_to_create: number;
    faq_notes: number;
    services: number;
  };
  faq_chunks: number;
  documents: { id: string; title: string }[];
}

export interface MigratePlan { dry_run: true; plan: MigrateResult['plan'] }

/** How many characters of each legacy column the backfill would move.
 *  Keyed by the mapping itself, e.g. `"hours -> profile.hours.notes"`,
 *  so the UI can list it without a second copy of the mapping. */
export type ProfileBackfillPlanRows = Record<string, number>;
export interface ProfileBackfillPlan {
  dry_run: true;
  plan: ProfileBackfillPlanRows;
  profile: BusinessProfile | null;
  detail: string;
}
export interface ProfileBackfillResult {
  bot: Bot;
  plan: ProfileBackfillPlanRows;
  detail: string;
}

export interface PreviewTurn { role: 'user' | 'assistant'; content: string }
export interface PreviewReply {
  reply: string;
  vendor: string;
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
}
export interface Lead {
  id: string; name: string; email: string; phone: string | null;
  inquiry: string | null; created_at: string; session_id: string;
  // supabase/010. Optional: rows captured before the migration have
  // none of them, and a bot with no lead_config never sets them.
  tag?: string | null;
  company?: string | null;
  consent_given?: boolean | null;
}
export interface Message {
  id: string; session_id: string; role: 'user' | 'assistant';
  content: string; created_at: string;
}


// ── Overview statistics ──────────────────────────────────────────
export interface DayPoint {
  date: string;
  visitor: number;
  assistant: number;
  sessions: number;
  leads: number;
}
export interface StatTotals {
  sessions: number;
  messages: number;
  visitorMessages: number;
  assistantMessages: number;
  leads: number;
  conversionRate: number | null;
  turnsPerSession: number | null;
  documents: number;
  documentsReady: number;
  documentsFailed: number;
  documentsPending: number;
  chunks: number;
}
export interface Stats {
  range: { days: number; from: string; to: string };
  totals: StatTotals;
  previous: Pick<StatTotals, 'sessions' | 'messages' | 'leads'>;
  series: DayPoint[];
  topQuestions: { text: string; count: number }[];
  truncated: { messages: boolean; leads: boolean };
}

export const endpoints = {
  me:            () => api.get<Me>('/v1/admin/me'),
  createOrg:     (name: string) => api.post<Org>('/v1/admin/orgs', { name }),
  vendors:       () => api.get<{ vendors: Vendor[] }>('/v1/admin/providers'),
  bots:          () => api.get<{ bots: Bot[] }>('/v1/admin/bots'),
  bot:           (id: string) => api.get<Bot>(`/v1/admin/bots/${id}`),
  createBot:     (b: Record<string, unknown>) => api.post<Bot>('/v1/admin/bots', b),
  updateBot:     (id: string, b: Record<string, unknown>) => api.put<Bot>(`/v1/admin/bots/${id}`, b),
  deleteBot:     (id: string) => api.del<null>(`/v1/admin/bots/${id}`),
  deleteLogo:    (id: string) => api.del<Bot>(`/v1/admin/bots/${id}/logo`),
  leads:         (id: string) => api.get<{ leads: Lead[] }>(`/v1/admin/bots/${id}/leads`),
  conversations: (id: string, sessionId?: string) =>
                   api.get<{ conversations: Message[] }>(
                     `/v1/admin/bots/${id}/conversations`
                     + (sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''),
                   ),
  // `embedding` is the model that would resolve TODAY. Each document
  // carries the one it was indexed with, and comparing the two is what
  // makes drift visible — see the "Re-index required" badge in Sources.
  documents:     (id: string) => api.get<{
                   documents: Doc[];
                   embedding: { vendor: string; model: string } | null;
                 }>(`/v1/admin/bots/${id}/documents`),
  addDocument:   (id: string, b: Record<string, unknown>) => api.post<Doc>(`/v1/admin/bots/${id}/documents`, b),
  reindex:       (docId: string) => api.post<Doc>(`/v1/admin/documents/${docId}/reindex`),
  deleteDoc:     (docId: string) => api.del<null>(`/v1/admin/documents/${docId}`),
  chunks:        (docId: string) => api.get<{ chunks: Chunk[] }>(`/v1/admin/documents/${docId}/chunks`),
  stats:         (id: string, days = 30) => api.get<Stats>(`/v1/admin/bots/${id}/stats?days=${days}`),
  missReport:    (id: string, days = 30) => api.get<MissReport>(`/v1/admin/bots/${id}/retrieval?days=${days}`),
  preview:       (id: string, body: { message: string; history: PreviewTurn[] }) =>
                   api.post<PreviewReply>(`/v1/admin/bots/${id}/preview`, body),

  // ── Knowledge pipeline (011) ──
  faq:           (id: string) => api.get<FaqResponse>(`/v1/admin/bots/${id}/faq`),
  addFaqItem:    (id: string, b: { question: string; answer: string; enabled?: boolean }) =>
                   api.post<FaqItem>(`/v1/admin/bots/${id}/faq`, b),
  updateFaqItem: (itemId: string, b: Partial<Pick<FaqItem, 'question' | 'answer' | 'enabled'>>) =>
                   api.put<FaqItem>(`/v1/admin/faq/${itemId}`, b),
  deleteFaqItem: (itemId: string) => api.del<null>(`/v1/admin/faq/${itemId}`),
  reorderFaq:    (id: string, order: string[]) =>
                   api.post<{ items: FaqItem[] }>(`/v1/admin/bots/${id}/faq/reorder`, { order }),
  retrievePreview: (id: string, query: string) =>
                   api.post<RetrievePreview>(`/v1/admin/bots/${id}/retrieve-preview`, { query }),
  migratePlan:   (id: string) =>
                   api.post<MigratePlan>(`/v1/admin/bots/${id}/knowledge/migrate?dry_run=1`),
  migrate:       (id: string) => api.post<MigrateResult>(`/v1/admin/bots/${id}/knowledge/migrate`),
  revertMigrate: (id: string) => api.post<Bot>(`/v1/admin/bots/${id}/knowledge/revert`),

  /** The plan, before anything is written. Reports what each legacy
   *  column would become and says what a revert can and cannot undo. */
  profileBackfillPlan: (id: string) =>
                   api.post<ProfileBackfillPlan>(`/v1/admin/bots/${id}/profile/backfill?dry_run=1`),
  profileBackfill: (id: string) =>
                   api.post<ProfileBackfillResult>(`/v1/admin/bots/${id}/profile/backfill`),
};
