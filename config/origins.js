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
// The account's workers.dev subdomain — NOT the zone name, and not
// derivable from it. It is whatever was claimed when the account was
// created; check with:
//
//   curl -H "Authorization: Bearer $TOKEN" //     https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/workers/subdomain
//
// This was wrong once already: it read `mukeremshifa.workers.dev`, which
// resolves nowhere, so every staging build baked an API host that did
// not exist. Nothing caught it, because check-landing only asserts that
// assets come from a host we name — not that the host answers.
const WORKERS_DEV = process.env.CK_WORKERS_DEV ?? 'mukeemoha.workers.dev';

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

// ----------------------------------------------------------------
// The Supabase project, which is a hostname too — and was the one that
// got away.
//
// The dashboard talks to Supabase DIRECTLY for auth: sign-in, sign-up
// and refresh never pass through our Worker. So the bundle needs a
// project URL and a publishable key, and until now it carried them as
// two hardcoded constants in apps/app/src/lib/config.ts, filled in by
// hand per the checklist in docs/operations.md.
//
// The predictable thing happened. The four-Worker rebuild filled them
// in with STAGING's values and shipped them to production, which put
// the deployed dashboard in a split brain: it authenticated against the
// staging project while calling the production API, and the production
// Worker verifies issuer and audience (src/auth.ts) — so a staging
// token is not merely unrecognised there, it is refused. Signing in
// appeared to work and every admin call then 401'd. An account created
// on production could not sign in at all: the login went to a project
// that had never heard of it.
//
// Nothing caught it because nothing could. A hardcoded literal is not
// checkable — no `CK_ENV` reaches it, no substitution pass sees it, and
// `npm run build:app` is equally happy either way.
//
// THE ANON KEY IS PUBLISHABLE and belongs in client code: supabase/001
// revokes the anon role's table privileges, so it reaches /auth/v1/*
// and nothing else. It is committed for the same reason the hostnames
// are — a value the browser receives anyway, held in the one place that
// switches it correctly.
//
// It must stay in step with the SUPABASE_URL each Worker is deployed
// with (apps/api/.dev.vars and .dev.vars.staging). scripts/seed-demo-bot.mjs
// asserts they agree rather than trusting it.
// ----------------------------------------------------------------
const PRODUCTION_SUPABASE = {
  url: 'https://jvmoiyyieprhtlyymhtg.supabase.co',
  // Legacy `eyJ…` anon key. If the project is ever migrated to JWT
  // signing keys, Supabase disables these — swap in the
  // `sb_publishable_…` value here and redeploy the dashboard.
  anonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2bW9peXlpZXByaHRseXltaHRnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2NDQ1MDQsImV4cCI6MjEwMzIyMDUwNH0.g9aCMPpj-wwAbi3tifzyAXJ0KxzsqG9gxminV0KKByA',
};

const STAGING_SUPABASE = {
  url: 'https://zqgglnewdmmwjgjzxjvv.supabase.co',
  anonKey: 'sb_publishable_3vO4SRD3gIeNVQvbM8b_JQ_l5Ds2r5o',
};

export const SUPABASE = process.env.CK_ENV === 'staging' ? STAGING_SUPABASE : PRODUCTION_SUPABASE;

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
