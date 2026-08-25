// ----------------------------------------------------------------
// Signed session identifiers
//
// A session id decides which conversation history gets loaded into the
// prompt. Before this, it was whatever string the client sent — the
// widget generated one with Math.random(), so anyone who obtained or
// guessed another visitor's id could resume their conversation and
// have its transcript fed back to them.
//
// Now the server issues them and verifies the signature. The token is
// opaque to the client and binds to one bot, so a token minted for bot
// A cannot be replayed against bot B.
//
// Compatibility: an unsigned or invalid id is NOT rejected. It is
// treated as "no history" and the caller is handed a fresh signed one
// in the response. That keeps every embedded widget and the documented
// curl flow working while closing the disclosure.
// ----------------------------------------------------------------
import type { Env } from './types';

const PREFIX = 'ck1';
/** Tokens older than this stop loading history. */
const MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
/** Truncated HMAC. 128 bits is far beyond forgery reach here. */
const MAC_BYTES = 16;

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Derive a signing key rather than using a secret directly.
 *
 * SESSION_SECRET is preferred, but falling back to a key *derived*
 * from the service-role key means this works with no new config. The
 * fixed label is domain separation: the derived key cannot be used to
 * impersonate the original secret anywhere else.
 */
let cachedKey: { material: string; key: CryptoKey } | null = null;

async function signingKey(env: Env): Promise<CryptoKey> {
  const material = env.SESSION_SECRET || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!material) throw new Error('No SESSION_SECRET or SUPABASE_SERVICE_ROLE_KEY to derive a session key from');

  if (cachedKey?.material === material) return cachedKey.key;

  const base = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(material),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const derived = await crypto.subtle.sign('HMAC', base, new TextEncoder().encode('conversekit/session-id/v1'));

  const key = await crypto.subtle.importKey(
    'raw', derived, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  cachedKey = { material, key };
  return key;
}

async function mac(env: Env, botId: string, rand: string, iat: string): Promise<string> {
  const key = await signingKey(env);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${botId}:${rand}:${iat}`));
  return b64url(new Uint8Array(sig).slice(0, MAC_BYTES));
}

/** Mint a fresh signed session id for a bot. */
export async function issueSessionId(env: Env, botId: string): Promise<string> {
  const rand = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const iat  = Math.floor(Date.now() / 1000).toString(36);
  return `${PREFIX}.${rand}.${iat}.${await mac(env, botId, rand, iat)}`;
}

/**
 * True only for a well-formed, correctly signed, unexpired token for
 * this exact bot. Anything else is false — callers then skip history
 * and issue a replacement rather than erroring.
 */
export async function verifySessionId(env: Env, botId: string, token: string): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) return false;

  const [, rand, iat, presented] = parts;
  if (!rand || !iat || !presented) return false;

  const issued = parseInt(iat, 36);
  if (!Number.isFinite(issued)) return false;
  const age = Math.floor(Date.now() / 1000) - issued;
  // Reject the future too: a forward-dated token would otherwise never expire.
  if (age < -300 || age > MAX_AGE_SECONDS) return false;

  return timingSafeEqual(presented, await mac(env, botId, rand, iat));
}

/** Comparison whose duration does not depend on where the first
 *  difference falls, so it leaks nothing about the correct MAC. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
