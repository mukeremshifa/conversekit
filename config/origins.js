// ----------------------------------------------------------------
// The only place a hostname is written.
//
// ONE environment. What is deployed is production; what runs on your
// machine is the same thing pointed at localhost. There is no staging
// tier, no second Supabase project, no second set of Workers — see the
// "one pipeline" section of README.md for why that was removed rather
// than maintained.
//
// `conversekit.io` day is an edit to ZONE — or a CK_ZONE in the
// environment for a one-off build against a different apex.
//
// Consumed by:
//   scripts/build-assets.mjs   token substitution for widget.js and the
//                              landing page
//   apps/app/vite.config.ts    Vite `define` for the dashboard bundle
//
// Nothing else may hardcode a hostname.
//
// One non-hostname rides along in TOKENS — the demo bot's id — because
// the substitution pass is the mechanism that makes a value checkable,
// and that id needed checking. See the note on TOKENS below.
// ----------------------------------------------------------------
import { DEMO_BOT_ID } from './demo-bot.js';

const ZONE = process.env.CK_ZONE ?? 'conversekit.mukeremshifa.com';

/** What the four Workers answer on. The deployed set, and the default. */
const DEPLOYED = {
  site: `https://${ZONE}`,
  app: `https://app.${ZONE}`,
  cdn: `https://cdn.${ZONE}`,
  api: `https://api.${ZONE}`,
};

/**
 * The same four, on your machine. Ports match what `npm run dev`
 * actually binds — scripts/dev.mjs is the only thing that sets CK_DEV,
 * and it is the only reason this second set exists.
 *
 * This is NOT an environment tier. It is the difference between a dev
 * server that exercises your edits and one that quietly loads the
 * deployed widget and calls the deployed API, in which case changing
 * widget.js or a route would show up nowhere and the dev server would
 * be an expensive way to look at production.
 */
const LOCAL = {
  site: 'http://localhost:8788',
  app: 'http://localhost:5173',
  cdn: 'http://localhost:8789',
  api: 'http://localhost:8787',
};

export const ORIGINS = process.env.CK_DEV === '1' ? LOCAL : DEPLOYED;

// ----------------------------------------------------------------
// The Supabase project, which is a hostname too.
//
// The dashboard talks to Supabase DIRECTLY for auth: sign-in, sign-up
// and refresh never pass through our Worker. So the bundle needs a
// project URL and a publishable key, and it holds them here rather than
// as hand-edited literals in apps/app/src/lib/config.ts — which is how
// a build once shipped pointing at a project whose tokens the deployed
// Worker refused, so sign-in appeared to work and every admin call
// 401'd.
//
// ONE project, local and deployed alike. `npm run dev` talks to the
// same database the deployed dashboard does, which is the deliberate
// consequence of having one environment: there is no other database to
// talk to, and a local session and a deployed session see the same rows.
//
// THE ANON KEY IS PUBLISHABLE and belongs in client code: supabase/001
// revokes the anon role's table privileges, so it reaches /auth/v1/*
// and nothing else. It is committed for the same reason the hostnames
// are — a value the browser receives anyway, held in one place.
//
// It must stay in step with the SUPABASE_URL the API Worker is deployed
// with (apps/api/.dev.vars).
// ----------------------------------------------------------------
export const SUPABASE = {
  url: 'https://jvmoiyyieprhtlyymhtg.supabase.co',
  // Legacy `eyJ…` anon key. If the project is ever migrated to JWT
  // signing keys, Supabase disables these — swap in the
  // `sb_publishable_…` value here and redeploy the dashboard.
  anonKey:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp2bW9peXlpZXByaHRseXltaHRnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc2NDQ1MDQsImV4cCI6MjEwMzIyMDUwNH0.g9aCMPpj-wwAbi3tifzyAXJ0KxzsqG9gxminV0KKByA',
};

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
 *
 * `__CK_DEMO_BOT__` is the one entry that is not a hostname, and it is
 * here for the same reason the others are: the landing page carries a
 * live widget, that widget needs a bot id, and an id written into the
 * HTML by hand is an id nothing can check. It was wrong for exactly
 * that reason — the page shipped a fabricated uuid that matched no row
 * in any database, so /health answered 404 and widget.js unmounted
 * itself on every visit. Routing it through here keeps
 * config/demo-bot.js the single declaration of which bot that is.
 */
export const TOKENS = {
  __CK_SITE__: ORIGINS.site,
  __CK_APP__: ORIGINS.app,
  __CK_CDN__: ORIGINS.cdn,
  __CK_API__: ORIGINS.api,
  __CK_WIDGET_SRC__: installSrc(),
  __CK_DEMO_BOT__: DEMO_BOT_ID,
};

/** Replace every token in `text`. Unknown `__CK_*__` tokens are left
 *  alone rather than blanked — a typo should be visible in the output. */
export function substitute(text) {
  let out = text;
  for (const [token, value] of Object.entries(TOKENS)) {
    out = out.split(token).join(value);
  }
  return out;
}
