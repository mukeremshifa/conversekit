// ----------------------------------------------------------------
// Entitlements — what a plan may do.
//
// THE RULE: tiers are data, not deployments. There is one ck-api with
// every binding always present; this module is where the code decides
// what to do with them. There is never a `ck-api-free`. A tenant
// upgrading must be a database write, not a redeploy and a new embed
// snippet in someone else's HTML.
//
// Today every plan returns the same permissive object, and that is
// fine — the value here is not the gating, it is that every call site
// already asks. When plans become real, one function changes and
// nothing else does.
//
// The one thing that genuinely IS deploy-time is the rate limiter:
// limits are static configuration and cannot be computed per request,
// so a binding per tier is declared in apps/api/wrangler.jsonc and
// selected here. Adding a fourth tier later is a deploy, which is fine.
// Discovering after launch that the mechanism does not exist is not.
// ----------------------------------------------------------------
import type { Bot, Env, Organization } from './types';

/** The plans that exist. `organizations.plan` is free-text in the
 *  database; anything unrecognised is treated as `free`, because the
 *  failure mode of a typo must be "least privilege", not "everything". */
export type Plan = 'free' | 'pro' | 'scale';

/** Which rate-limit binding a plan's chat traffic is counted against.
 *  One namespace per tier: a pro tenant's burst must not consume a free
 *  tenant's allowance, and the namespaces are what keep them apart. */
export type LimiterBinding = 'RL_FREE' | 'RL_PRO' | 'RL_SCALE';

export interface Entitlements {
  plan: Plan;
  /** Retrieval-augmented generation. A tier without RAG answers from
   *  the business profile and the system prompt alone. */
  rag: boolean;
  /** `'*'` for the whole catalog, or an explicit allowlist of vendor
   *  ids from providers/catalog.ts. */
  vendors: '*' | readonly string[];
  /** Uploaded-source ceiling per organization, in bytes. */
  storageBytes: number;
  /** Whether the widget shows the "Powered by ConverseKit" line. Rides
   *  in the /v1/bots/:id/health payload — it is a field, never a second
   *  widget build. Forking the widget doubles the CDN surface and
   *  halves the test coverage of both copies. */
  branding: boolean;
  limiter: LimiterBinding;
}

/**
 * Total stored bytes one organization may hold. 100 MB on every plan
 * today; it lives here rather than in rag/files.ts because a storage
 * ceiling is an entitlement, and the upload route should be asking the
 * seam rather than importing a constant.
 *
 * MIRRORS `v_cap` in the storage-cap trigger in supabase/, which is the
 * authority: this copy races every concurrent upload and is bypassed
 * entirely by anything reaching PostgREST directly. It exists so the
 * common case gets a sentence with real numbers in it instead of a
 * constraint violation. When plans diverge here, that trigger has to
 * learn to read the plan too.
 */
const DEFAULT_STORAGE_BYTES = 100 * 1024 * 1024;

const PLANS: Record<Plan, Entitlements> = {
  free: {
    plan: 'free',
    rag: true,
    vendors: '*',
    storageBytes: DEFAULT_STORAGE_BYTES,
    branding: true,
    limiter: 'RL_FREE',
  },
  pro: {
    plan: 'pro',
    rag: true,
    vendors: '*',
    storageBytes: DEFAULT_STORAGE_BYTES,
    branding: false,
    limiter: 'RL_PRO',
  },
  scale: {
    plan: 'scale',
    rag: true,
    vendors: '*',
    storageBytes: DEFAULT_STORAGE_BYTES,
    branding: false,
    limiter: 'RL_SCALE',
  },
};

function normalizePlan(value: string | null | undefined): Plan {
  const v = (value ?? '').trim().toLowerCase();
  return v === 'pro' || v === 'scale' ? v : 'free';
}

/**
 * The seam. Everything that asks "may this tenant …" asks here.
 *
 * Takes the organization row rather than an org id so it stays
 * synchronous and free — a per-request database round trip to answer a
 * question the caller already has the row for would be a bad trade, and
 * a slow seam is a seam people route around.
 */
export function getEntitlements(org: Pick<Organization, 'plan'> | null | undefined): Entitlements {
  return PLANS[normalizePlan(org?.plan)];
}

/** Convenience for the chat path, which holds a bot rather than an org.
 *  `selectBot` embeds `organizations(plan)`; a row fetched without the
 *  embed falls through to `free`. */
export function entitlementsFor(bot: Pick<Bot, 'organizations'>): Entitlements {
  return getEntitlements(bot.organizations);
}

export function vendorAllowed(ent: Entitlements, vendor: string): boolean {
  return ent.vendors === '*' || ent.vendors.includes(vendor);
}

/**
 * The rate limiter this plan's chat traffic counts against.
 *
 * Undefined when the binding is absent — `wrangler dev` without the
 * config, or a deployment that has not been updated yet. Callers fail
 * open on that: a missing limiter must never be the reason chat is
 * down, and it must never be the reason a deploy fails.
 */
export function chatLimiterFor(env: Env, ent: Entitlements): RateLimiter | undefined {
  return env[ent.limiter];
}

/** Structural, like the AI binding in types.ts: this must compile
 *  whether or not the binding is configured. */
export interface RateLimiter {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}
