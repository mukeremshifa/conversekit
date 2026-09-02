// ----------------------------------------------------------------
// Google service-account auth for Vertex AI
//
// Vertex does not take an API key. It takes an OAuth2 access token,
// and the only way to get one without a metadata server — which a
// Worker does not have — is the JWT-bearer flow: sign a short-lived
// assertion with the service account's private key, trade it at
// oauth2.googleapis.com for an access token.
//
// Deliberately not google-auth-library: it assumes Node crypto and a
// filesystem, and the whole flow is one signature and one POST. Same
// reasoning as the note at the top of google.ts.
// ----------------------------------------------------------------
import { ProviderError } from './errors';

/** The fields we need from a service-account JSON key. The file has
 *  more; these are the three that matter. */
export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE     = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * Tokens live an hour; we re-mint at 55 minutes.
 *
 * Module scope, which is normally the wrong place for mutable state in
 * a Worker — but this holds a SERVICE credential, identical for every
 * request, derived from a secret that is already global. Nothing
 * request-scoped or per-tenant enters it, so the usual objection (one
 * visitor's data surviving into another's request) does not apply.
 * Keyed by client_email so a BYO service account cannot collide with
 * the platform's.
 */
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const SKEW_MS = 5 * 60 * 1000;

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const b64urlText = (text: string): string => b64url(new TextEncoder().encode(text));

/**
 * PEM to the DER bytes WebCrypto wants.
 *
 * The `\n` unescaping is not defensive noise: a service-account JSON
 * key carries its private key as a single line with literal backslash-n
 * escapes, and every way of getting one into a Worker secret — pasting
 * the file, `wrangler secret put`, a .dev.vars line — can preserve them
 * rather than turning them into real newlines. Both forms arrive here.
 */
function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/\n/g, '\n')
    .replace(/-----[A-Z ]+-----/g, '')
    .replace(/\s+/g, '');
  if (!body) throw new Error('private_key is empty');

  const raw = atob(body);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out.buffer;
}

/** Parse the secret. Kept separate from the fetch so a malformed key
 *  fails as a config error at resolve time, not as a network error
 *  three layers down on the first visitor message. */
export function parseServiceAccount(raw: string): ServiceAccount {
  let json: any;
  try { json = JSON.parse(raw); }
  catch { throw new Error('not valid JSON — paste the whole service-account key file'); }

  if (!json?.client_email || !json?.private_key) {
    throw new Error('missing client_email or private_key — is this a service-account key?');
  }
  return json as ServiceAccount;
}

/**
 * A cloud-platform access token for the given service account.
 *
 * Throws ProviderError rather than a bare Error so the caller's
 * existing `err instanceof ProviderError` branches classify it: a
 * rejected assertion is an auth failure and retrying it is pointless,
 * which is exactly what `kind: 'auth'` already means to httpStatusFor.
 */
export async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const cached = tokenCache.get(sa.client_email);
  if (cached && cached.expiresAt > Date.now()) return cached.token;

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss:   sa.client_email,
    scope: SCOPE,
    aud:   TOKEN_URL,
    iat:   now,
    exp:   now + 3600,
  };

  const signingInput = `${b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64urlText(JSON.stringify(claims))}`;

  let assertion: string;
  try {
    const key = await crypto.subtle.importKey(
      'pkcs8',
      pemToDer(sa.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signingInput),
    );
    assertion = `${signingInput}.${b64url(new Uint8Array(sig))}`;
  } catch (err) {
    throw new ProviderError({
      kind:    'auth',
      vendor:  'google-vertex',
      message: `Could not sign the token assertion: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ProviderError({
      kind:    'auth',
      vendor:  'google-vertex',
      status:  res.status,
      message: `Token exchange failed (HTTP ${res.status}): ${body.slice(0, 300)}`,
    });
  }

  const json: any = await res.json();
  if (!json?.access_token) {
    throw new ProviderError({
      kind: 'auth', vendor: 'google-vertex',
      message: 'Token exchange returned no access_token',
    });
  }

  const ttlMs = (typeof json.expires_in === 'number' ? json.expires_in : 3600) * 1000;
  tokenCache.set(sa.client_email, {
    token:     json.access_token,
    expiresAt: Date.now() + Math.max(0, ttlMs - SKEW_MS),
  });

  return json.access_token;
}

/** Test seam — the cache is module state and a test that mints twice
 *  needs to be able to say so. */
export function clearTokenCache(): void {
  tokenCache.clear();
}
