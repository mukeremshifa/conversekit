# Deployment rebuild

Scratch the current Cloudflare setup and rebuild it on the modern Workers pattern,
with a hostname layout that survives the eventual move to `conversekit.io` and a
shape that will not fight a tiered product later.

Written 2026-08-23 against `main` @ `976cb80`.
**Executed 2026-08-23 — 2026-08-25.** Phases 1, 2, 3 and 5 are done; Phase 4 is
blocked on the zone. See [Execution record](#execution-record) at the bottom for
what was built, what differs from the plan above and why, and what is still
yours to do.

---

## Why this is a rebuild and not a migration

The earlier version of this plan was built around protecting things that turned out
not to need protecting. The constraints that drove it are gone:

- **No paying clients.** Nothing breaks if a URL changes.
- **No real data in the database.** The schema can be re-derived from scratch.
- **Every site running the widget is yours.** The embed URL is not a public contract yet.
- **The `.workers.dev` and `.pages.dev` hostnames were never shared anywhere binding.**

So there is no legacy tier, no dual-cohort cutover, no permanent-obligation list. The
only thing worth optimising for is: **what topology do I want to still be happy with in
three years.**

This is the cheapest this change will ever be. Every tenant onboarded from here makes
it more expensive.

---

## Decisions already made

Recorded so a fresh session doesn't re-open them. Each one has a reason; if you disagree
with a reason, say so and it can be revisited — but don't re-derive them from scratch.

| # | Decision | Why |
|---|---|---|
| 1 | **Four deploy targets, not one** | Landing, dashboard, widget CDN and API have different change rates, cache policies and blast radii. Today a landing-page typo redeploys the script that runs on customer sites. |
| 2 | **Workers with static assets, not Pages** | Cloudflare has Pages in soft maintenance — the docs now say plainly "start new projects with Workers," and `_headers` / `_redirects` / SPA routing are all supported natively on Workers. One toolchain, one config format. |
| 3 | **Nested subdomains, not hyphenated ones** | `api.conversekit.…` maps 1:1 onto `api.conversekit.io` later. `conversekit-api.…` does not. |
| 4 | **One API Worker for all tiers** | Tiers are rows in a table, not deploy targets. See [Tiering](#what-tiering-does-and-does-not-change) — this is the single most expensive thing to get wrong. |
| 5 | **One widget artifact for all tiers** | Tier differences ride in the `/v1/bots/:id/health` payload the widget already fetches. Never build `widget-nobrand.js`. |
| 6 | **Versioned widget URLs from day one** | Free now, retrofit-only-with-pain later. |
| 7 | **npm workspaces monorepo** | Four targets each need their own build output and asset dir. Also kills the current two-lockfile awkwardness in CI. |
| 8 | **Staging on `.workers.dev`, production on custom domains** | Avoids attaching (and paying attention to) four more hostnames for an environment only you use. |
| 9 | **Deploys move into CI** | Right now the deployed artifact is whatever was on your laptop. `scripts/check-deploy.mjs` exists because a scratch harness with fake seeded messages once shipped to the site root — that guard is a symptom. |

---

## Target architecture

### Hostnames

| Role | Production hostname | Worker | Has script? |
|---|---|---|---|
| Landing | `conversekit.mukeremshifa.com` | `ck-site` | no — assets only |
| Dashboard | `app.conversekit.mukeremshifa.com` | `ck-app` | no — assets only, SPA routing |
| Widget + fonts + brand | `cdn.conversekit.mukeremshifa.com` | `ck-cdn` | no — assets only |
| API | `api.conversekit.mukeremshifa.com` | `ck-api` | yes — the Hono app |

Later, on the real zone: `conversekit.io`, `app.conversekit.io`, `cdn.conversekit.io`,
`api.conversekit.io`. Same shape, one config line.

> **TLS trap at this depth.** Universal SSL on a full-setup zone covers the apex and
> **first-level** subdomains only — `*.mukeremshifa.com` does *not* cover
> `api.conversekit.mukeremshifa.com`. Attaching a Workers **Custom Domain** provisions a
> certificate for that exact hostname automatically at any depth, so the plan above is
> fine. But create a plain proxied DNS record at that depth instead and you get a TLS
> handshake failure with no obvious cause. **Always attach as a Custom Domain.**

### Naming convention

- Workers: `ck-<service>`. Wrangler environments auto-suffix, so `[env.staging]` on
  `ck-api` yields `ck-api-staging` with no extra naming work.
- R2: `ck-docs` / `ck-docs-staging`.
- Leave room for `ck-billing` later — Stripe webhooks have a different security posture
  (signature verification, idempotency, no CORS, no user JWT) and will eventually earn
  their own Worker. Not now; keep them in `ck-api` under `/v1/webhooks/stripe` until they
  justify the split.

### Repo layout

```
conversekit/
  package.json              # workspaces root
  config/origins.js         # the ONLY place a hostname is written
  apps/
    api/    wrangler.jsonc  src/          # moved from ./src
    app/    wrangler.jsonc  src/  dist/   # moved from ./dashboard
    cdn/    wrangler.jsonc  assets/       # widget.js, fonts/, brand/
    site/   wrangler.jsonc  assets/       # landing page, shots/
  packages/
    shared/                 # types shared between api and app
  scripts/                  # unchanged
  supabase/                 # unchanged
  docs/
```

### `config/origins.js`

```js
// The only place a hostname is written. conversekit.io day is an edit to ZONE.
const ZONE = process.env.CK_ZONE ?? 'conversekit.mukeremshifa.com';

export const ORIGINS = {
  site: `https://${ZONE}`,
  app:  `https://app.${ZONE}`,
  cdn:  `https://cdn.${ZONE}`,
  api:  `https://api.${ZONE}`,
};

export const WIDGET_MAJOR = 'v1';
export const installSrc = () => `${ORIGINS.cdn}/${WIDGET_MAJOR}/widget.js`;
```

Consumed by: Vite `define` for the dashboard, a token substitution step for
`widget.js`, the assertion in `scripts/check-landing.mjs`, and the landing page's
install snippet. Currently these are hardcoded in eight places.

### Widget URL scheme

Three paths off `cdn.`, all serving the same build:

| Path | Cache | Purpose |
|---|---|---|
| `/v1/widget.js` | `max-age=600, must-revalidate` | **What the install snippet emits.** Major-pinned. |
| `/0.11.0/widget.js` | `max-age=31536000, immutable` | Exact pin, for anyone who wants it. |
| `/widget.js` | `max-age=300, must-revalidate` | Floating latest. Keep for convenience; don't advertise it. |

> **Superseded.** Only `/v1/widget.js` shipped — see
> [Amendments](#amendments-after-review).

`WIDGET_VERSION` already exists at `public/widget.js:20` and is already reported to the
server on every session, so version adoption is measurable from day one.

---

## What tiering does — and does not — change

You flagged a possible tiered product (a tier without RAG, a tier locked to one vendor).
This is the part of the plan most worth reading carefully, because the intuitive answer
is wrong in an expensive way.

### The trap: one Worker per tier

It is tempting to deploy a `ck-api-free` without the AI and R2 bindings and a
`ck-api-pro` with them. Do not. It costs you:

- N tiers × M environments deploy targets, and every bug fix deploys N times.
- A customer upgrading has to *move between Workers* — different hostname, tenant edits
  their embed. Upgrades should be a database write.
- Bindings diverge, so code paths diverge, so testing one Worker stops telling you
  anything about the others.

### The rule: tiers are data, not deployments

One `ck-api`, all bindings always present, entitlements read per-request from the
database. The *code* gates access; the *config* never does. The Worker already does
exactly this for R2 — the upload route answers 501 when `DOCS` is absent rather than
failing to boot. That instinct is right; generalise it.

### What genuinely is a deployment concern

Three things, all cheap now and annoying to retrofit:

1. **Per-tier rate limits.** Rate limit bindings are static configuration — you cannot
   compute a limit at runtime. Declare one binding per tier now (`RL_FREE`, `RL_PRO`,
   `RL_SCALE`) with distinct namespace ids, and select between them in code based on the
   org's plan. Adding a fourth tier later is a deploy, which is fine. Discovering you
   need the mechanism at all after launch is not.

2. **An entitlements seam.** A single `getEntitlements(org)` returning a static object
   today — `{ rag: true, vendors: '*', maxDocs: null }` — with every call site already
   routed through it. When plans become real, one function changes. No plans table
   needed yet.

3. **Metering that can enforce, not just observe.** `usage_log` already exists (added in
   `supabase/017`, pruned by the `41 3` cron). That is the right foundation. Make sure
   the write happens on a path that a quota check can also read.

### What tiering must not touch

- **The widget stays one artifact.** "Paid tier removes the Powered-by badge" is a field
  in the health response, not a second bundle. The moment you fork the widget you have
  doubled your CDN surface and halved your test coverage.
- **`cdn.` stays tier-agnostic.** It serves bytes. It knows nothing about who you are.

---

## Modernisations worth taking while everything is torn down

These are real changes with real behaviour, not cosmetics. Each needs verifying after.

- **`compatibility_date`: `2024-11-01` → current.** Nearly two years of runtime
  behaviour changes. On a fresh start with the test suite green this is the right moment,
  but it is a genuine behaviour change — run `npm test` and exercise a chat round-trip
  after, don't assume.
- **Rate limiting off `[[unsafe.bindings]]`.** The `ratelimit` binding went GA in
  September 2025; the current config still uses the pre-GA unsafe form. ⚠️ *Confirm the
  exact config key against `/workers/runtime-apis/bindings/rate-limit/` at execution
  time — I could not pin the GA syntax from the docs search and will not guess it here.*
- **Smart Placement on `ck-api`.** Genuinely worth it here: the chat path makes several
  sequential Supabase calls per request, and each one costs 20–30 ms from a distant
  region versus 1–3 ms when placed nearby. Supabase is reached over HTTPS/PostgREST
  rather than a Postgres driver, so Hyperdrive does not apply, but placement does. Use
  `placement.mode = "smart"` — it measures rather than requiring you to know the region.
- **`workers_dev = false` on production.** With custom domains attached, leaving the
  `.workers.dev` hostname live gives every service two addresses. Keep it `true` on
  staging.
- **Untrack `public/admin/`.** Build output is currently committed; once CI builds it,
  the diffs are pure noise.
- **`wrangler.toml` → `wrangler.jsonc`** — *optional, low value.* The docs lead with
  jsonc and it supports comments so the existing annotations survive, but toml is fully
  first-class. Do it only if you want consistency with current docs; skip it otherwise.

---

## Phases

### Phase 0 — Yours, before anything else

- [ ] `wrangler login` against the ConverseKit account.
- [ ] Confirm which Cloudflare account is the real one. **The Claude MCP connector is
      pointed at a different account** — it reports 0 Workers and R2 not enabled — so
      execution must go through the wrangler CLI, not the MCP tools.
- [ ] Confirm `mukeremshifa.com` is an active zone on that same account.
- [ ] **Verify `.dev.vars` holds every production secret** before anything is deleted.
      Deleting a Worker deletes its secrets. Currently expected: `GEMINI_API_KEY`,
      `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `GROQ_API_KEY`,
      `SUPABASE_ACCESS_TOKEN`. Check the deployed Worker for any secret that exists there
      but *not* locally — `wrangler secret list` — and write it down somewhere safe.
- [ ] Decide the R2 question (below).
- [ ] Decide the Supabase question (below).

### Phase 1 — Inventory and teardown

- [ ] `wrangler whoami`, list Workers, Pages projects, R2 buckets, KV namespaces.
      Write the inventory into this file before deleting anything.
- [ ] Check whether `conversekit-documents` holds any objects worth keeping.
- [ ] Delete Worker `conversekit`.
- [ ] Delete Pages project `conversekit-widget`.
- [ ] Keep or recreate R2 per the decision below.

### Phase 2 — Repo restructure

No Cloudflare interaction. Everything here is verifiable locally with `npm test` and
`npm run type-check`.

- [ ] Convert to npm workspaces; move `src/` → `apps/api/src/`, `dashboard/` → `apps/app/`.
- [ ] Split `public/` into `apps/cdn/assets/` (widget, fonts, brand) and
      `apps/site/assets/` (landing, shots).
- [ ] Write `config/origins.js`; replace all eight hardcoded hostnames with reads from it.
- [ ] Add the token-substitution step for `widget.js`'s `DEFAULT_API_BASE`.
      Note `ASSET_BASE` already self-derives from `scriptTag.src` at runtime, so only the
      one token is genuinely load-bearing.
- [ ] Add the `getEntitlements(org)` seam and route existing RAG / vendor checks through it.
- [ ] Untrack `public/admin/`.
- [ ] Green `npm test` and `npm run type-check`.

### Phase 3 — Four wrangler configs

- [ ] `apps/api` — script + all bindings (AI, R2, rate limiters), `placement.mode: smart`,
      crons, observability, `[env.staging]`.
- [ ] `apps/app` — assets only, `not_found_handling: "single-page-application"`,
      no `main`, and **no `binding: ASSETS`** (only valid when a script is present).
- [ ] `apps/cdn` — assets only, `_headers` carrying the CORS and cache rules currently in
      `public/_headers`, plus the versioned widget paths.
- [ ] `apps/site` — assets only, `not_found_handling: "404-page"`.
- [ ] Deploy all four to `.workers.dev` and verify before any domain is attached.

### Phase 4 — Custom domains

- [ ] Attach all four as **Custom Domains** (not DNS records — see the TLS note above).
- [ ] Flip `CK_ZONE`; redeploy. This should be the only code change in this phase.
- [ ] `workers_dev = false` on the four production configs.
- [ ] Tighten CORS: `src/index.ts:120` currently reflects every origin on every route.
      Not exploitable as-is — auth is a bearer token, not a cookie, so there is no
      ambient credential to ride — but once `app.` exists there is a concrete value to
      lock `/v1/admin/*` to.

### Phase 5 — CI/CD

- [ ] Extend the existing `.github/workflows/ci.yml` with deploy jobs using
      `cloudflare/wrangler-action`, path-filtered so only changed apps deploy.
- [ ] `main` → staging. Tag `v*` → production.
- [ ] `CLOUDFLARE_API_TOKEN` as a scoped GitHub secret. Worker secrets stay in Cloudflare,
      set once via `wrangler secret put` — never in CI.
- [ ] Retire `scripts/check-deploy.mjs` once CI builds from a clean checkout: a scratch
      file on your laptop can no longer reach production at all.

---

## Open questions — yours to answer

**1. R2: keep or recreate?**
The bucket is the only thing on Cloudflare holding actual bytes. If it is empty (likely,
given no real data), recreating it as `ck-docs` costs ten seconds and gets you naming
consistency. If it has test uploads you would rather not re-create, keep
`conversekit-documents` and accept the odd name out. **Recommendation: check contents,
then recreate as `ck-docs` if empty.**

**2. Supabase: also reset?**
Out of the literal scope of "Cloudflare," but it is part of the deploy pipeline and this
is the cheap moment. You have no real data, and the migration runner currently depends on
`npm run db:baseline` — a mechanism that exists *only* because migrations `001`–`008`
were applied by hand before the runner existed. A fresh database means `001`…`017` apply
in order for real, the baseline hack goes away, and migration history becomes honest.
**Recommendation: yes, but as a separate pass after Phase 2 — don't entangle it with the
Cloudflare teardown.**

**3. Monorepo now, or flat with four configs?**
Workspaces is the right end state and solves the two-lockfile problem, but Phase 2 is the
largest chunk of churn in this plan. The lighter alternative is four
`wrangler.<name>.jsonc` files at the repo root with no directory moves. **Recommendation:
do the workspace move — four targets each needing their own build output will make the
flat layout hurt within a month — but it is a legitimate place to save effort if you want
the domain live sooner.**

---

## Notes for the executing session

- Phases 0 and 1 need Mukerem present and are destructive. Do not start them unprompted.
- Phase 2 is entirely local and independently verifiable; it is the safe place to begin.
- Anything marked ⚠️ above was not confirmable at planning time and must be checked
  against live docs before being written into config.
- The MCP Cloudflare tools are bound to the wrong account. Use the wrangler CLI.
- Verify the inventory in Phase 1 against reality before trusting any resource name in
  this document — it was written from the repo, not from the account.

---

## Execution record

Executed 2026-08-23 – 2026-08-25. Read this before the phases above: where the
two disagree, this is what is actually deployed.

### Phase 1 — inventory and teardown ✅

The inventory, taken before anything was deleted:

| Resource | State found | Action |
|---|---|---|
| Account | `2e88036de25704e438be00e66e65b862` (ozgur.mukerem@gmail.com), workers.dev subdomain `mukeremshifa` | — |
| Worker `conversekit` | deployed 2026-08-20; secrets `GEMINI_API_KEY`, `GROQ_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` — all five present in `.dev.vars` | deleted |
| Pages project `conversekit-widget` | one domain, no git provider | **still there** — see [Still yours](#still-yours) |
| R2 `conversekit-documents` | 4 objects, 51.4 kB: three orphaned test PDFs and one demo bot logo | emptied, then deleted |
| KV namespaces | none | — |

The MCP Cloudflare connector turned out to be on the **same** account as the
wrangler CLI, not a different one as the plan warned. Both were used.

### Phase 2 — repo restructure ✅

npm workspaces, `apps/{api,app,cdn,site}` plus `packages/brand`. One lockfile;
the dashboard's second one is gone. Everything moved with `git mv`, so history
follows.

Four differences from the layout above, each deliberate:

- **`packages/brand/assets/` exists; `packages/shared/` does not.** The brand
  package is the single copy of the favicons, logos and web fonts, copied into
  all three static targets at build time rather than referenced cross-origin —
  so the landing page and the dashboard keep same-origin icon and font loads,
  and neither is down because `cdn.` is. `packages/shared` appeared only in the
  layout sketch, never in the Phase 2 checklist; extracting shared types between
  the Worker and the dashboard is a real refactor with real regression risk and
  was not worth bundling into this one.
- **`config/origins.js` gained `TOKENS`, `substitute()` and a staging origin
  set.** The landing page
  and `widget.js` have no bundler, so they carry `__CK_API__`-style tokens and
  `scripts/build-assets.mjs` fills them in. `config/origins.d.ts` is what lets
  the Vite configs import the module without a `@ts-expect-error`.
- **`apps/{cdn,site}` build into `dist/` rather than deploying `assets/`
  directly.** Token substitution needs somewhere to write, and the widget needs
  placing under its major prefix. `dev-static.mjs`, `check-landing.mjs`
  and `check-motion.mjs` all read the built directory now, which is what lets
  `check-landing` assert on real hostnames — plus one new check that no
  `__CK_*__` token survived the build.
- **`/v1/` carries its own fonts.** The widget derives `ASSET_BASE` from its own
  `<script src>`, so a tenant on `/v1/widget.js` asks for `/v1/fonts/…`. Without
  this the versioned path would have shipped a widget that silently renders in
  the fallback face on every customer site. `_headers` covers it with
  `/:major/fonts/*` — a placeholder rather than a literal, so the next major
  inherits the CORS header the day it is created rather than 404ing quietly.

`scripts/check-deploy.mjs` is retired. Its job — never let a `__*` scratch file
reach a deploy — moved into `scripts/build-assets.mjs`, where it is structural
rather than a predeploy hook that only ever ran on one laptop.

**`CK_ENV=staging` was added to `config/origins.js` during execution**, and it
is not cosmetic. Hostnames are baked into the dashboard bundle and into the
landing page at build time, so `wrangler deploy --env staging` on its own
produced a staging Worker whose pages called the *production* API and loaded the
*production* CDN — an environment that works, looks fine, and tests nothing.
Staging is on `.workers.dev`, which is not a zone and cannot be expressed as
`sub.ZONE`, so the four staging hostnames are named outright. CI sets the
variable alongside the deploy; by hand it has to be exported before `npm run
build`.

### Phase 3 — four wrangler configs ✅

`compatibility_date` moved `2024-11-01` → `2026-08-23`. Test suite green after,
and all four Workers deploy and serve.

**The GA rate-limit syntax, confirmed against the live docs** (this was the ⚠️
in the plan): the key is `ratelimits`, a top-level array of
`{ name, namespace_id, simple: { limit, period } }`. `period` may only be **10
or 60**. `[[unsafe.bindings]]` is gone.

**Rate limiting: kept, fully integrated.** It is an abuse guard, not
monetisation — every bot shares one Gemini key and one Workers AI allocation, so
an unthrottled endpoint lets anyone holding a bot UUID drain the free tier from
a script. Three bindings, one per tier (`RL_FREE` 30/min, `RL_PRO` 120/min,
`RL_SCALE` 600/min), selected in code from the org's plan. Staging uses a
separate block of namespace ids so its counters never touch production's.

### Entitlements ✅

`apps/api/src/entitlements.ts` is the seam. Every plan returns the same
permissive object today; the value is that every call site already asks. Wired
through:

| Call site | What it asks |
|---|---|
| `rateLimited()` | which limiter binding |
| `retrieve()` | may this tier use RAG |
| `PUT /v1/admin/bots/:id` | is this vendor allowed on this plan — 403 at write time, not at chat time |
| file upload | the org storage cap, moved out of `rag/files.ts` where an entitlement should never have lived |
| `GET /v1/bots/:id/health` | `branding`, the Powered-by line |
| `GET /v1/admin/me` | the resolved object, so the dashboard never re-derives it from `plan` |

`selectBot` now embeds `organizations(plan)`, so the seam stays synchronous — a
per-request round trip to answer a question the caller already holds the row for
would be a bad trade, and a slow seam is one people route around.

Decision #5 is now real rather than aspirational: `branding: false` in the health
payload removes the Powered-by line from the **one** widget artifact.
`scripts/test-entitlements-units.mjs` covers the mapping, and asserts that every
binding the code names is declared in both environments and that no two plans
share a namespace id.

### Phase 4 — custom domains ❌ BLOCKED

`wrangler` refuses: **"Could not find zone for `conversekit.mukeremshifa.com`."**

`mukeremshifa.com` is on Cloudflare nameservers (`kellen` / `annabel.ns.cloudflare.com`)
but is **not a zone on account `2e88036de25704e438be00e66e65b862`** — the account
the Workers are on. Its apex currently points at Vercel, which is unrelated and
does not block a subdomain.

The four `wrangler.jsonc` files declare their Custom Domains as planned and are
otherwise ready; production deploys will attach them the moment the zone is on
the same account. Nothing is half-attached: `ck-site` was uploaded once, failed
at the route step, and was deleted again, so the account holds exactly the four
staging Workers.

### Phase 5 — CI/CD ✅

`.github/workflows/ci.yml` gained a path-filtered deploy matrix. `main` →
staging, tag `v*` → production, api first, `max-parallel: 1`. Only changed apps
deploy; `config/` and `packages/brand/` fan out to everything they reach. It
uses the lockfile's own wrangler rather than `cloudflare/wrangler-action`, so the
tool that publishes the artifact is pinned by the same lockfile the artifact was
built with. One secret: `CLOUDFLARE_API_TOKEN`.

### Supabase — reset, with a rewritten schema ✅

Seventeen migrations became six, applied to a wiped database and verified against
the Worker's own query shapes. `npm run db:baseline` is gone;
`npm run db:reset -- --yes` replaces it.

```
001_tenancy.sql   002_bots.sql        003_conversations.sql
004_knowledge.sql 005_retrieval.sql   006_usage.sql
```

Dropped: seed rows, one-time backfills, the `unclaimed` holding org, the guarded
single-bot index dance, the constraint drop-and-recreate dances, and every
superseded version of a retrieval function. **Not dropped: a single column the
Worker reads** — the deprecated business-facts columns on `bots` are still
read-through-deprecated, because removing them is a code change in `prompt.ts`,
`profile.ts` and their tests, not a migration. `supabase/README.md` maps the old
seventeen numbers onto the new six, so every code comment citing
`supabase/012_retrieval.sql` still resolves.

Verified after the reset: 10 tables with RLS on every one, 15 policies, 12
functions, 11 triggers, 19 indexes, **zero anon privileges on any public table**,
the signup trigger provisioning org + membership + bot in one transaction, all
three retrieval RPCs answering at their final signatures, both `org_id`
derivation triggers, the chunk counter, both retention clamps, and cascade
cleanup. The database is currently empty.

One pre-existing wart worth knowing, unchanged by any of this: deleting an
`auth.users` row cascades its memberships but leaves the organization and its bot
behind, unreachable because RLS grants access only through a membership.

### R2 — wiped, not recreated

Per your call. `ck-docs` was **not** created and `apps/api/wrangler.jsonc`
declares no R2 binding. The Worker degrades exactly as designed: file upload and
bot-logo upload answer 501, the logo route 404s, and every other knowledge source
keeps working. Re-enabling it later is `wrangler r2 bucket create ck-docs` plus
four lines of config; nothing in the code needs to change.

### Amendments after review

Four changes made after the execution above, on review of the result.

- **The widget serves one path, not three.** `/widget.js` (floating) and
  `/0.11.0/widget.js` (exact pin) are gone; `/v1/widget.js` is all that ships.
  The floating path was documented in `_headers` as "deliberately not
  advertised", which is a description of a path that should not exist — an
  unadvertised URL handing out breaking changes is a liability, not a
  convenience. The exact pin answered "which build is this tenant on", which the
  widget already answers by reporting `WIDGET_VERSION` on every session. What
  remains is the one thing genuinely painful to retrofit: the major in the URL,
  because that string gets pasted into other people's HTML and can never be
  changed afterwards. The fan-out and its triplicated font copy went with them.

- **`.dev.vars` moved to `apps/api/.dev.vars`.** It had stayed at the repo root
  through the monorepo move, and wrangler looks for it **in the directory of the
  config file** — so `wrangler dev` had been running with no secrets at all
  since Phase 2. This was a live bug, not a tidy-up.

- **`SUPABASE_ACCESS_TOKEN` moved to `.env.tools`.** It can drop and recreate
  the `public` schema of every project on the account, and it had been sitting
  in the same file as the five keys whose entire purpose is to be uploaded to
  the edge. Now the file a credential lives in determines where it can travel,
  rather than a person remembering which line to skip.

- **`npm run secrets:push` replaces a bare `wrangler secret bulk`**, which
  uploads whatever file it is handed. It pushes an allowlist matched against
  `secrets.required` in `wrangler.jsonc` and fails if the two drift, refuses a
  file containing a tooling credential, refuses a staging push whose
  `SUPABASE_URL` equals production's, and streams over stdin so no
  `secrets.json` is left in the working tree. Declaring `secrets.required` also
  makes a deploy **fail** on a missing secret rather than shipping a Worker that
  502s until somebody reads the logs.

### Still yours

**Done since:** Supabase is split across two projects. `conversekit-prod`
(`jvmoiyyieprhtlyymhtg`, eu-west-2) is production and carries all six
migrations; `conversekit-staging` (`zqgglnewdmmwjgjzxjvv`, eu-west-1) is the
former single project, now staging. Both verified to the same shape — 10 app
tables with RLS, 15 policies, 162 functions, 16 triggers, 33 indexes, zero anon
grants. The only difference is Supabase's own `rls_auto_enable` event trigger,
present on the newer project.

Four things left, in order:

1. **The zone and the Workers must be on one account.** This is the blocker, and
   it does not have a DNS-shaped solution: a Worker route cannot cross accounts.
   `mukeremshifa.com` is on account A; the Workers are on account
   `2e88036de25704e438be00e66e65b862` (account B), which holds no zone at all.

   Cloudflare for SaaS does **not** sidestep this. Custom Hostnames are a
   zone-level feature — you enable Cloudflare for SaaS *on a zone*, designate a
   fallback origin in that zone's DNS, and the Worker catches traffic through a
   `*/*` route *on that zone*. So the SaaS path still requires a zone on account
   B; it only changes *which* domain has to live there. Cheapest correct move is
   to redeploy the Workers onto whichever account holds the zone.

2. **Push the API Worker's secrets**, for both environments:

   ```bash
   npm run secrets:push                    # → ck-api,         conversekit-prod
   npm run secrets:push -- --env staging   # → ck-api-staging, conversekit-staging
   ```

   `secrets.required` now makes a deploy *fail* on a missing secret rather than
   shipping a Worker that 502s, so this has to happen before the next deploy.

3. **Delete the Pages project.**

   ```bash
   npx wrangler pages project delete conversekit-widget --yes
   ```

4. **Add `CLOUDFLARE_API_TOKEN` to the repo secrets**, scoped to Workers Scripts
   edit on whichever account ends up holding both.
