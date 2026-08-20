// ----------------------------------------------------------------
// Deployment configuration.
//
// SUPABASE_ANON_KEY is a publishable key and is safe in client code —
// but only because 003_tenancy.sql revoked the anon role's table
// privileges. It can reach /auth/v1/* and nothing else.
// ----------------------------------------------------------------
// Both default to the deployed origins, so a production build needs no
// environment at all. `dashboard/.env.local` overrides them for local
// dev — point API at `wrangler dev` to exercise a Worker change without
// deploying it, or leave it unset to develop UI against real data.
const DEFAULT_API = 'https://conversekit.mukeremshifa.workers.dev';

export const API = import.meta.env.VITE_API_BASE ?? DEFAULT_API;

/** True when API is the host `public/widget.js` already defaults to.
 *  The install snippet reads this to decide whether it has to spell the
 *  API out in a `data-api-base` attribute, or can stay the shorter tag. */
export const API_IS_DEFAULT = API === DEFAULT_API;

/** The Worker serves only the API; static assets live on Pages. */
export const WIDGET_BASE =
  import.meta.env.VITE_WIDGET_BASE ?? 'https://conversekit-widget.pages.dev';

export const SUPABASE_URL = 'https://zqgglnewdmmwjgjzxjvv.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_3vO4SRD3gIeNVQvbM8b_JQ_l5Ds2r5o';
