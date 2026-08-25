// ----------------------------------------------------------------
// The only place a hostname is written.
//
// Four deploy targets, four hostnames, one zone. `conversekit.io` day
// is an edit to ZONE — or a CK_ZONE in the environment for a one-off
// build against a different apex.
//
// Consumed by:
//   scripts/build-assets.mjs   token substitution for widget.js and the
//                              landing page
//   apps/app/vite.config.ts    Vite `define` for the dashboard bundle
//   scripts/check-landing.mjs  resolves tokens before asserting that
//                              nothing loads from a host we do not own
//
// Nothing else may hardcode a hostname. scripts/check-landing.mjs fails
// the build on a `__CK_*__` token that survived substitution, and on any
// asset loaded from a host these four do not name.
// ----------------------------------------------------------------
const ZONE = process.env.CK_ZONE ?? 'conversekit.mukeremshifa.com';

const PRODUCTION = {
  site: `https://${ZONE}`,
  app: `https://app.${ZONE}`,
  cdn: `https://cdn.${ZONE}`,
  api: `https://api.${ZONE}`,
};

/**
 * Staging lives on `.workers.dev`, which is not a zone — so it cannot be
 * expressed as `sub.ZONE` and has to be named outright.
 *
 * This exists because without it staging is untestable: the dashboard
 * bundle would call the production API, and the landing page's live
 * widget would load from the production CDN. A staging environment that
 * only exercises production is not one.
 */
const WORKERS_DEV = process.env.CK_WORKERS_DEV ?? 'mukeremshifa.workers.dev';

const STAGING = {
  site: `https://ck-site-staging.${WORKERS_DEV}`,
  app: `https://ck-app-staging.${WORKERS_DEV}`,
  cdn: `https://ck-cdn-staging.${WORKERS_DEV}`,
  api: `https://ck-api-staging.${WORKERS_DEV}`,
};

/**
 * `CK_ENV=staging` selects the staging set. It has to be set for the
 * BUILD, not just the deploy — the hostnames are baked into the bundle
 * and into the landing page, so `wrangler deploy --env staging` alone
 * would ship production hostnames to a staging Worker.
 *
 * On Windows that is `$env:CK_ENV='staging'` before the build; CI does
 * it inline.
 */
export const ORIGINS = process.env.CK_ENV === 'staging' ? STAGING : PRODUCTION;

/** The major the install snippet pins to. A breaking widget change
 *  bumps this and the old path keeps serving the old build — which is
 *  the entire reason the snippet does not point at `/widget.js`. */
export const WIDGET_MAJOR = 'v1';

/** What a tenant pastes into their page. Major-pinned, not floating. */
export const installSrc = () => `${ORIGINS.cdn}/${WIDGET_MAJOR}/widget.js`;

/**
 * Tokens substituted into buildless sources at build time. The values
 * are what a browser sees; the tokens are what the repo holds, so no
 * source file names a hostname.
 */
export const TOKENS = {
  __CK_SITE__: ORIGINS.site,
  __CK_APP__: ORIGINS.app,
  __CK_CDN__: ORIGINS.cdn,
  __CK_API__: ORIGINS.api,
  __CK_WIDGET_SRC__: installSrc(),
};

/** Replace every token in `text`. Unknown `__CK_*__` tokens are left
 *  alone rather than blanked — a typo should be visible in the output,
 *  and scripts/check-landing.mjs fails on any that survive. */
export function substitute(text) {
  let out = text;
  for (const [token, value] of Object.entries(TOKENS)) {
    out = out.split(token).join(value);
  }
  return out;
}
