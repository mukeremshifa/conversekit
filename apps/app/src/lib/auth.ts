// ----------------------------------------------------------------
// Supabase Auth over plain REST.
//
// Still no @supabase/supabase-js: three endpoints are all this needs,
// and keeping the dependency out means no SDK version to track for a
// console that only signs in and refreshes.
// ----------------------------------------------------------------
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config';

export interface Session {
  access_token: string;
  refresh_token: string;
  /** Absolute epoch ms, not the `expires_in` offset the API returns. */
  expires_at: number;
  email: string | null;
}

const STORE = 'ck_admin_session';

let session: Session | null = null;
/** In-flight refresh, shared by every caller — see refresh(). */
let refreshing: Promise<string> | null = null;

export function currentSession(): Session | null {
  if (session) return session;
  try {
    const raw = localStorage.getItem(STORE);
    session = raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    session = null;
  }
  return session;
}

function save(payload: Record<string, unknown>): Session {
  session = {
    access_token:  String(payload.access_token ?? ''),
    refresh_token: String(payload.refresh_token ?? ''),
    expires_at:    Date.now() + Number(payload.expires_in ?? 3600) * 1000,
    email:         (payload.user as { email?: string } | undefined)?.email ?? session?.email ?? null,
  };
  localStorage.setItem(STORE, JSON.stringify(session));
  return session;
}

export function clearSession() {
  session = null;
  refreshing = null;
  localStorage.removeItem(STORE);
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      String(data.error_description ?? data.msg ?? data.error ?? 'Authentication failed'),
    );
  }
  return data;
}

export async function signIn(email: string, password: string): Promise<Session> {
  return save(await post('/auth/v1/token?grant_type=password', { email, password }));
}

/** Returns null when the project requires email confirmation. */
export async function signUp(email: string, password: string): Promise<Session | null> {
  const data = await post('/auth/v1/signup', { email, password });
  return data.access_token ? save(data) : null;
}

/**
 * Single-flight on purpose. Supabase rotates refresh tokens, so two
 * concurrent refreshes — trivially caused by two panels loading at
 * once — make the second fail with "Already Used" and sign the user
 * out mid-session.
 */
function refresh(): Promise<string> {
  const s = currentSession();
  if (!s?.refresh_token) return Promise.reject(new Error('No session'));

  refreshing ??= post('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh_token })
    .then((d) => save(d).access_token)
    .catch((err) => {
      clearSession();
      throw err;
    })
    .finally(() => {
      refreshing = null;
    });

  return refreshing;
}

/** A valid access token, refreshed pre-emptively with a minute to spare. */
export async function freshToken(): Promise<string> {
  const s = currentSession();
  if (!s) throw new Error('Not signed in');
  if (Date.now() < s.expires_at - 60_000) return s.access_token;
  return refresh();
}

export async function forceRefresh(): Promise<string> {
  return refresh();
}
