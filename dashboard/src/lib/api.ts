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

export interface Bot {
  id: string;
  org_id: string;
  name: string;
  business_name: string;
  hours: string | null;
  location: string | null;
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
  contact_email: string | null;
  contact_phone: string | null;
  address: string | null;
  provider_config: VendorConfig | null;
  embedding_config: VendorConfig | null;
  rag_config: RagConfig | null;
  widget_config: WidgetConfig | null;
  behavior_config: BehaviorConfig | null;
  lead_config: LeadConfig | null;
  /** Served by the Worker from R2; null when no logo is set. Read-only —
   *  it is derived from a key the dashboard never sees. */
  logo_url: string | null;
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
  source: 'text' | 'url' | 'markdown' | 'file';
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

export interface Chunk { id: string; ordinal: number; content: string }

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
  documents:     (id: string) => api.get<{ documents: Doc[] }>(`/v1/admin/bots/${id}/documents`),
  addDocument:   (id: string, b: Record<string, unknown>) => api.post<Doc>(`/v1/admin/bots/${id}/documents`, b),
  reindex:       (docId: string) => api.post<Doc>(`/v1/admin/documents/${docId}/reindex`),
  deleteDoc:     (docId: string) => api.del<null>(`/v1/admin/documents/${docId}`),
  chunks:        (docId: string) => api.get<{ chunks: Chunk[] }>(`/v1/admin/documents/${docId}/chunks`),
  stats:         (id: string, days = 30) => api.get<Stats>(`/v1/admin/bots/${id}/stats?days=${days}`),
  preview:       (id: string, body: { message: string; history: PreviewTurn[] }) =>
                   api.post<PreviewReply>(`/v1/admin/bots/${id}/preview`, body),
};
