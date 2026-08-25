// ----------------------------------------------------------------
// Deployment configuration.
//
// SUPABASE_ANON_KEY is a publishable key and is safe in client code —
// but only because the tenancy migration revoked the anon role's table
// privileges. It can reach /auth/v1/* and nothing else.
// ----------------------------------------------------------------
// The hostnames come from config/origins.js via Vite `define`, so this
// file names none of them: `conversekit.io` day is one edit, there.
//
// Both defaults still exist so a production build needs no environment
// at all. `apps/app/.env.local` overrides them for local dev — point API
// at `wrangler dev` to exercise a Worker change without deploying it, or
// leave it unset to develop UI against real data.
const DEFAULT_API = __CK_API__;

export const API = import.meta.env.VITE_API_BASE ?? DEFAULT_API;

/** True when API is the host `widget.js` already defaults to. The
 *  install snippet reads this to decide whether it has to spell the API
 *  out in a `data-api-base` attribute, or can stay the shorter tag. */
export const API_IS_DEFAULT = API === DEFAULT_API;

/**
 * The exact `<script src>` a tenant pastes into their page.
 *
 * Major-pinned (`/v1/widget.js`), not floating — that is the whole
 * reason the versioned paths exist, and the snippet is the one place
 * the choice actually reaches anybody. Handing out `/widget.js` here
 * would opt every tenant into breaking changes they never asked for.
 */
export const WIDGET_SRC = import.meta.env.VITE_WIDGET_SRC ?? __CK_WIDGET_SRC__;

/** The landing page. Used for outbound links out of the dashboard. */
export const SITE = __CK_SITE__;

/**
 * The Supabase project this dashboard authenticates against.
 *
 * From config/origins.js via Vite `define`, like every other hostname
 * here — NOT hardcoded, which is what these two lines used to be.
 *
 * That is not a style preference. The dashboard talks to Supabase
 * directly for sign-in, sign-up and refresh; only the resulting JWT
 * goes to our API. So these two values decide which project mints the
 * token, while the Worker decides which project's tokens it trusts —
 * and when a hand-edited literal put those two out of step, the
 * deployed dashboard signed users in against a project whose tokens
 * the Worker refused, then 401'd on every admin call, because
 * src/auth.ts pins issuer and audience. Sign-in appeared to work and
 * nothing else did.
 *
 * A literal cannot be wrong in a way a build can notice. Reading it
 * from the one place that also supplies the API hostname means both
 * halves can only move together.
 */
export const SUPABASE_URL = __CK_SUPABASE_URL__;
export const SUPABASE_ANON_KEY = __CK_SUPABASE_ANON_KEY__;
