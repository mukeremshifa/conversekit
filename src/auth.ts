// ----------------------------------------------------------------
// Supabase JWT verification
//
// Uses `jose` rather than hand-rolled Web Crypto. The project avoids
// SDKs that drag Node polyfills into the Workers runtime (see the
// note in supabase.ts) — jose is not one of those: zero dependencies,
// Web Crypto native. What it buys is the parts of JWT verification
// that are easy to get subtly wrong: algorithm-confusion defence,
// JWKS fetching and rotation, and claim validation.
//
// Supabase projects sign either with a shared HS256 secret (legacy)
// or with asymmetric keys published at a JWKS endpoint (current).
// Both are supported; the secret wins when present.
// ----------------------------------------------------------------
import { jwtVerify, createRemoteJWKSet, decodeProtectedHeader, errors as joseErrors } from 'jose';
import type { Env } from './types';

export interface Actor {
  userId: string;
  email: string | null;
  /** The raw token, forwarded to PostgREST so RLS sees this user. */
  jwt: string;
}

export class AuthError extends Error {
  readonly status: 401;
  constructor(message: string) {
    super(message);
    this.name   = 'AuthError';
    this.status = 401;
  }
}

// ----------------------------------------------------------------
// Key material
//
// Cached in module scope, which in Workers means once per isolate
// rather than once per request. createRemoteJWKSet handles its own
// fetching, caching and rotation-on-unknown-kid internally.
// ----------------------------------------------------------------
let jwksCache: { url: string; keys: ReturnType<typeof createRemoteJWKSet> } | null = null;

function jwksFor(supabaseUrl: string) {
  const url = `${supabaseUrl.replace(/\/+$/, '')}/auth/v1/.well-known/jwks.json`;
  if (!jwksCache || jwksCache.url !== url) {
    jwksCache = {
      url,
      keys: createRemoteJWKSet(new URL(url), {
        cacheMaxAge:      600_000, // 10 min
        cooldownDuration:  30_000, // floor between rotation-triggered refetches
        timeoutDuration:    5_000, // a slow GoTrue must not hang a request
      }),
    };
  }
  return jwksCache.keys;
}

/** Pull a bearer token off the Authorization header. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

// ----------------------------------------------------------------
// Verification
//
// Checks the signature *and* the claims. A valid signature alone
// proves only that Supabase minted the token at some point — issuer
// and audience pin it to this project and to a logged-in end user
// (rather than, say, a service token), and jose enforces exp/nbf.
// ----------------------------------------------------------------
export async function verifyToken(env: Env, token: string): Promise<Actor> {
  if (!env.SUPABASE_URL) throw new AuthError('SUPABASE_URL is not configured');

  const base = env.SUPABASE_URL.replace(/\/+$/, '');
  // GoTrue has issued both `{url}/auth/v1` and a bare `supabase` as `iss`
  // depending on project age, and custom auth domains change it again.
  // Overridable so a mismatch is a config fix, not a redeploy.
  const issuer = env.SUPABASE_JWT_ISSUER ?? `${base}/auth/v1`;
  const common = { issuer, audience: 'authenticated', clockTolerance: 5 };

  // Branch on the token's own algorithm, not on which env vars happen to
  // be set. During Supabase's legacy→asymmetric migration both signing
  // modes are live at once, and a stale SUPABASE_JWT_SECRET left behind
  // would otherwise reject every correctly-signed token.
  let alg: string | undefined;
  try { ({ alg } = decodeProtectedHeader(token)); }
  catch { throw new AuthError('Malformed token'); }

  try {
    let payload;
    if (alg === 'HS256') {
      if (!env.SUPABASE_JWT_SECRET) {
        throw new AuthError('HS256 token but no SUPABASE_JWT_SECRET configured');
      }
      ({ payload } = await jwtVerify(
        token,
        new TextEncoder().encode(env.SUPABASE_JWT_SECRET),
        { ...common, algorithms: ['HS256'] },
      ));
    } else if (alg === 'ES256' || alg === 'RS256') {
      ({ payload } = await jwtVerify(
        token,
        jwksFor(base),
        { ...common, algorithms: ['ES256', 'RS256'] },
      ));
    } else {
      throw new AuthError(`Unsupported algorithm ${alg ?? 'none'}`);
    }

    // `role` is the claim PostgREST turns into a database role. Asserting
    // it explicitly is what stops a service_role or anon API key — both of
    // which are themselves JWTs — from being used as a bearer token here.
    // The issuer/audience checks above already reject them, but only
    // incidentally; this makes the intent enforced rather than emergent.
    if (payload.role !== 'authenticated') {
      throw new AuthError('Token is not an end-user session');
    }
    // Anonymous sign-ins, if ever enabled, do carry aud=authenticated.
    if (payload.is_anonymous === true) {
      throw new AuthError('Anonymous sessions cannot use the admin API');
    }

    const userId = typeof payload.sub === 'string' ? payload.sub : '';
    if (!userId) throw new AuthError('Token has no subject');

    const email = typeof payload.email === 'string' ? payload.email : null;
    return { userId, email, jwt: token };
  } catch (err) {
    if (err instanceof AuthError) throw err;

    // Map jose's typed failures to something a caller can log usefully
    // without ever echoing the token back.
    if (err instanceof joseErrors.JWTExpired)             throw new AuthError('Token expired');
    if (err instanceof joseErrors.JWTClaimValidationFailed) throw new AuthError(`Invalid claim: ${err.claim}`);
    if (err instanceof joseErrors.JWSSignatureVerificationFailed) throw new AuthError('Bad signature');
    if (err instanceof joseErrors.JWKSNoMatchingKey)      throw new AuthError('No matching signing key');
    if (err instanceof joseErrors.JWKSTimeout)            throw new AuthError('Signing key set unavailable');

    throw new AuthError('Invalid token');
  }
}
