// ----------------------------------------------------------------
// Edge cache for GET /v1/bots/:id/health.
//
// That route is the widget's first request and the only thing standing
// between a visitor opening the panel and seeing anything inside it:
// widget.js paints the greeting, the business card and the suggestion
// chips from this payload and nothing before it. Uncached it was a live
// Supabase round trip on every page view of every tenant site —
// measured at 250-750 ms of server time, on top of a cold TLS handshake
// to an origin the host page has never touched — which is the couple of
// seconds of empty panel this file exists to remove.
//
// WHAT IS CACHED IS THE PUBLIC PAYLOAD, NOT THE BOT ROW. The row holds
// provider_config, and that holds tenant BYOK keys. The payload is the
// fixed field list the route already assembles and contains nothing a
// visitor could not be told to their face. Caching the row instead
// would have been fewer lines and would have put tenant API keys into a
// shared cache to save them.
//
// WHY A SYNTHETIC KEY RATHER THAN THE INBOUND REQUEST. The CORS
// middleware reflects the caller's origin, so every response carries
// `Vary: Origin`. Caching the Response itself would therefore store one
// entry per embedding site and hit near zero for exactly the tenants
// with the most traffic. Keying off a URL we invent stores one entry
// per bot, and the route rebuilds its response through the normal
// middleware stack, so CORS stays per-caller.
//
// Under `wrangler dev` the local cache is a no-op: put succeeds, match
// always misses. That degrades to the uncached behaviour this replaced,
// which is the right direction for a dev server to be wrong in.
// ----------------------------------------------------------------

/**
 * How long a payload stays servable, at the edge and in the browser
 * alike.
 *
 * A minute is the trade. Long enough that any bot seeing more than one
 * visitor a minute per colo is answered from cache; short enough that a
 * tenant who changes their brand colour and reloads their own site sees
 * it. `purgeHealth` below closes most of even that gap, but only in one
 * colo, so this number — not the purge — is what the staleness ceiling
 * actually rests on.
 */
export const HEALTH_MAX_AGE = 60;

/**
 * What the BROWSER is told. Deliberately not the same directive the
 * edge copy is stored under (see `writeHealth`): a repeat page view
 * inside the minute costs no request at all, and one inside the
 * following ten minutes paints instantly from the stale copy while the
 * revalidation runs behind it. Both are well-defined in browsers.
 * `stale-while-revalidate` is not something the Cache API is documented
 * to act on, so the stored copy does not rely on it.
 */
export const HEALTH_CACHE_CONTROL =
  `public, max-age=${HEALTH_MAX_AGE}, stale-while-revalidate=600`;

/**
 * The key a bot's payload is stored under.
 *
 * Built from the REQUEST's own URL, which scopes the key by hostname
 * for free. The Worker answers on api.<zone> and on localhost under
 * `wrangler dev`, and the payload embeds a logo URL derived from
 * whichever one was called (see `origin()` in index.ts) — so an entry
 * made under one host must never be served under another. Taking the
 * origin from the request means that holds without a rule to remember.
 *
 * The path is not routable: Hono has no handler for it, and the edge
 * cache is never consulted for an inbound request to a Worker route.
 * Nothing stored here is reachable from outside this file.
 */
function keyFor(requestUrl: string, botId: string): Request {
  const url = new URL(`/__cache/health/${encodeURIComponent(botId)}`, requestUrl);
  return new Request(url.toString());
}

/**
 * The cached payload, or null for a miss.
 *
 * The cast is the one honest lie here: what comes back is whatever
 * `writeHealth` put in, and only this module writes to this key space.
 * A cache read must never be able to fail a request, so a throw from
 * the cache — or a body that no longer parses — is logged and treated
 * as a miss.
 */
export async function readHealth(
  requestUrl: string,
  botId: string,
): Promise<Record<string, unknown> | null> {
  try {
    const hit = await caches.default.match(keyFor(requestUrl, botId));
    if (!hit) return null;
    return await hit.json<Record<string, unknown>>();
  } catch (err) {
    console.error('[health-cache] read failed:', err);
    return null;
  }
}

/**
 * Store a payload. Returns a promise for `waitUntil` rather than being
 * called for effect, matching the write path in index.ts: the visitor
 * should not wait on our cache bookkeeping to get their widget.
 *
 * Stored under a plain `max-age`, not the browser directive above —
 * this copy's freshness is the only thing `caches.default.match` reads.
 */
export async function writeHealth(
  requestUrl: string,
  botId: string,
  payload: unknown,
): Promise<void> {
  try {
    await caches.default.put(
      keyFor(requestUrl, botId),
      new Response(JSON.stringify(payload), {
        headers: {
          'content-type': 'application/json',
          'cache-control': `public, max-age=${HEALTH_MAX_AGE}`,
        },
      }),
    );
  } catch (err) {
    console.error('[health-cache] write failed:', err);
  }
}

/**
 * Drop a bot's entry after a write to it.
 *
 * COLO-LOCAL, and that is not a bug to be fixed later with a purge API
 * call. The tenant who just saved their settings is served by the same
 * colo they will reload their own site from, so this is precisely the
 * staleness anyone is positioned to notice. Every other colo carries a
 * stale copy for at most HEALTH_MAX_AGE, which is the ceiling the TTL
 * was chosen against in the first place.
 */
export async function purgeHealth(requestUrl: string, botId: string): Promise<void> {
  try {
    await caches.default.delete(keyFor(requestUrl, botId));
  } catch (err) {
    console.error('[health-cache] purge failed:', err);
  }
}
