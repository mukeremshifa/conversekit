# Operations

Migrations, secrets, first-run setup, local development, deploying, and onboarding a client.

[← Back to the README](../README.md)

---

## Database migrations

`supabase/*.sql` is applied in numeric order by a runner, not by hand:

```bash
npm run db:status      # what is applied, what is pending
npm run db:migrate     # apply everything pending
npm run db:migrate -- --dry-run
npm run db:reset -- --yes   # DESTROY public + every auth user, then reapply
```

Six files, described in [supabase/README.md](../supabase/README.md). They
replace the seventeen that built the schema one feature at a time; nothing the
Worker reads was dropped, and that file maps the old numbers to the new ones for
anything still citing them.

Add **one** credential to `.env.tools` (copy `.env.tools.example`); the project
ref is read from `SUPABASE_URL` in `apps/api/.dev.vars`, so nothing else needs
configuring:

| Variable | Where it comes from |
|---|---|
| `SUPABASE_ACCESS_TOKEN=sbp_…` | [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) — preferred: revocable, and never needs the database password |
| `SUPABASE_DB_URL=postgresql://…` | Project Settings → Database → Connection string. Runs through `psql` |

Add `-- --env staging` to any of these to run against the staging project
instead. It reads `apps/api/.dev.vars.staging`, which is the same file wrangler
and `secrets:push` use for that environment — so there is exactly one answer to
"which database is staging on", and it is not in a person's head.

`db:reset` is the only genuinely dangerous one. It drops the whole `public`
schema and deletes every row in `auth.users`, then applies all six files from
scratch. The users have to go because the signup trigger is the only thing that
provisions an org, a membership and a bot, and it fires on INSERT — an account
that survived would sign in against nothing. There is no undo and no
point-in-time recovery on this project's plan, which is why `--yes` is required
in the command line rather than at a prompt.

Three behaviours worth knowing, each verified against a throwaway Postgres:

- **A migration that fails is not recorded**, and `--single-transaction` means it
  leaves the schema exactly as it was rather than half-applied. Fix it and run
  again; every migration in this repo is written to be safely re-runnable.
- **Editing a migration that already ran is refused.** Postgres has the old
  version, so the difference belongs in a new file rather than in edited history.
- **The target is printed from the transport in use**, never from whichever
  config happens to be set — printing a production project ref above a local
  migration is how someone talks themselves into believing the wrong thing.

The sequence is still **migration → deploy → verify**, for the reason recorded in
[phase-2b.md](phase-2b.md) §6: a Worker once shipped ahead of its schema and
broke bot creation in production.

---

## Secrets

| Name | Purpose |
|------|---------|
| `SUPABASE_URL` | Your Supabase project URL, e.g. `https://xxxx.supabase.co` |
| `SUPABASE_ANON_KEY` | Supabase anon key. Browser-safe once RLS is on. |
| `SUPABASE_SERVICE_ROLE_KEY` | **Bypasses RLS.** Public chat path only — never send it to a browser. |
| `SUPABASE_JWT_SECRET` | Optional. Only for projects still signing JWTs with a legacy HS256 secret; omit to verify via JWKS. |
| `<VENDOR>_API_KEY` | e.g. `GEMINI_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY` |

Optional tuning: `AI_VENDOR`, `AI_MODEL`, `AI_BASE_URL`, `AI_MAX_TOKENS`,
`AI_TEMPERATURE`, and the `EMBEDDING_*` equivalents. Full list in [the roadmap](roadmap.md).

#### Where each credential lives

Four stores, and the rule is that **a credential's location decides where it can
travel**. Nothing is in two places, so nothing can disagree.

| Store | Holds | Who reads it |
|---|---|---|
| `apps/api/.dev.vars` | the five Worker runtime secrets | `wrangler dev`, and `secrets:push` uploads it |
| `apps/api/.dev.vars.staging` | the same five, pointed at the staging Supabase project | `wrangler dev --env staging`, `secrets:push -- --env staging` |
| `.env.tools` | `SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_URL` | `scripts/migrate.mjs`. **Uploaded to nothing** |
| GitHub repo secrets | `CLOUDFLARE_API_TOKEN` | CI, to publish Workers |

`apps/api/.dev.vars` sits beside `wrangler.jsonc` and not at the repo root
because that is where wrangler looks — the config file's directory, not the
working directory. A copy at the root is invisible to `wrangler dev`, which
presents as a Worker that starts fine and 500s on its first Supabase call.

`SUPABASE_ACCESS_TOKEN` is in a separate file rather than the same one with a
comment beside it. It can drop and recreate the `public` schema of every project
on the account, and `.dev.vars` exists specifically to be uploaded to the edge —
so the separation makes "this never reaches a Worker" true by construction
instead of by remembering.

`apps/app/.env.local` is not a secret store despite the shape. Vite inlines
`VITE_*` into the public bundle; it holds dev-server pointers and nothing else.

#### Pushing them

```bash
npm run secrets:push                    # apps/api/.dev.vars → ck-api
npm run secrets:push -- --env staging   # …staging          → ck-api-staging
npm run secrets:push -- --dry-run       # names only, nothing uploaded
npm run secrets:list                    # what the Worker currently holds
```

**A Worker's very first deploy needs `secrets:bootstrap` instead.** `secret bulk`
has to attach to a Worker that exists, and `deploy` refuses to create one while
`secrets.required` is unmet — a cycle. `wrangler deploy --secrets-file` breaks it
by sending the secrets up with the version, so the Worker is created and
satisfied in one operation:

```bash
npm run secrets:bootstrap                    # creates ck-api with its secrets
npm run secrets:bootstrap -- --env staging   # creates ck-api-staging
```

That is the one path that writes a secrets file. It goes to the OS temp
directory, never the working tree, and is removed whether the deploy succeeds or
fails. Afterwards use `secrets:push` — the Worker exists by then.

Rather than a bare `wrangler secret bulk`, because that uploads whatever is in
the file it is handed. This pushes an **allowlist** — the same five names
declared as `secrets.required` in `wrangler.jsonc`, and it fails if the two
lists ever drift apart. It refuses outright if a tooling credential has wandered
into the file, refuses a staging push whose `SUPABASE_URL` matches production's,
and streams the JSON over stdin so no `secrets.json` is ever written to the
working tree for the next `git add -A` to find.

Because the five names are declared in `wrangler.jsonc`, **a deploy missing one
of them fails** rather than producing a Worker that answers 502 on
`/v1/bots/:id/health` until somebody reads the logs.

**Optional — lead notification emails.** Both are needed together; with either
missing, the email half of lead notifications is simply off and webhooks are
unaffected. Recipients configured in the dashboard are stored either way.

```bash
wrangler secret put RESEND_API_KEY
wrangler secret put LEAD_EMAIL_FROM   # e.g. "ConverseKit <leads@yourdomain.com>"
```

> `LEAD_EMAIL_FROM` **must be on a domain verified with Resend.** An unverified
> one is rejected at send time with a 403, not at deploy time, so the first sign
> is a captured lead that nobody was told about. Verify the domain first, then
> capture one lead and check the Worker logs before relying on it.

> **Both Supabase keys are load-bearing, in different places.** The chat path
> uses the service key; the admin path sends the publishable key as `apikey`
> alongside the user's JWT. Rotating only one leaves half the API broken —
> and the half that breaks (admin) is not the half you notice first.

If you migrate the project to **JWT signing keys**, Supabase also disables the
legacy `eyJ…` API keys. Swap both values for the new `sb_publishable_…` /
`sb_secret_…` pair, update the matching entry in
[config/origins.js](../config/origins.js), and redeploy the Worker *and* the
dashboard.

---

## First-run setup

1. Run the migrations in order in the Supabase SQL Editor: `001_init.sql`,
   `002_phase1.sql`, `004_provider_config.sql`, then `003_tenancy.sql`.
   **Read the header of `003` first** — it revokes the anon key's table access,
   so the Worker must already be deployed with `SUPABASE_SERVICE_ROLE_KEY`.
2. Add the project's URL and publishable key to `PRODUCTION_SUPABASE` (or
   `STAGING_SUPABASE`) in [config/origins.js](../config/origins.js). Both are
   browser-safe once `003` has run — the anon key can then only reach
   `/auth/v1/*`.

   **Not in `apps/app/src/lib/config.ts`.** That file used to hold them as
   hardcoded constants and it is exactly how a production dashboard shipped
   authenticating against the staging project: sign-in succeeded, then every
   admin call 401'd, because the Worker pins the token issuer. They now come
   from `config/origins.js` through Vite `define`, so `CK_ENV` switches them
   together with the hostnames, and `node scripts/check-app.mjs` asserts what
   actually landed in the built bundle.
3. Open the dashboard and **Create an account**. A trigger gives you an
   organization and an `owner` membership.
4. Claim any bots that existed before tenancy — `003` parks them in an
   `unclaimed` holding org. Run the snippet at the bottom of `003_tenancy.sql`
   with your email, then confirm it reports zero stranded bots.

Do not commit a filled-in copy of that claim snippet.

---

## Local development

```bash
# 1. Install dependencies — one lockfile, all four workspaces
npm install

# 2. Run the migrations (see "Database migrations" above)
npm run db:migrate

# 3. Copy the two secret templates and fill them in (see above)
#      apps/api/.dev.vars.example  →  apps/api/.dev.vars
#      .env.tools.example          →  .env.tools
```

Four servers, each independent — start only the ones your change needs:

| Command | Serves | URL |
|---|---|---|
| `npm run dev:app` | Dashboard (Vite, HMR) | http://localhost:5173/ |
| `npm run dev:site` | Landing page | http://localhost:8788/ |
| `npm run dev:cdn` | `widget.js`, fonts, brand | http://localhost:8789/ |
| `npm run dev:api` | Worker API (Wrangler) | http://localhost:8787 |

### Dashboard

`npm run dev:app` is the only one needed for dashboard UI work. It talks to the
**deployed** API by default, so every screen renders real bots, leads and
transcripts rather than empty states — the Worker reflects any `Origin`, so
`localhost` is not a special case there.

It is served from `/` now, not `/admin/`: the dashboard has its own hostname.

To point it somewhere else, copy `apps/app/.env.local.example` to
`apps/app/.env.local`:

| Variable | Effect |
|---|---|
| `VITE_API_BASE` | API origin. Set to `http://localhost:8787` to run against a local Worker |
| `VITE_WIDGET_SRC` | The full `<script src>` the Install snippet and Playground emit |

Both fall back to `config/origins.js`, so a production build needs no
environment at all.

### Landing page and CDN

Neither has a bundler, but both have a build step —
`scripts/build-assets.mjs` — because their sources carry `__CK_API__`-style
tokens where hostnames go. `npm run dev:site` and `npm run dev:cdn` run that
first and then serve the built `dist/` through `scripts/dev-static.mjs`, with
live reload and the same permissive CORS headers `apps/cdn/assets/_headers` sets
in production, so an embed test on another port behaves the same locally.

Edit `apps/site/assets/` and `apps/cdn/assets/`, never `dist/`. If you see
`__CK_CDN__` in a rendered page, the build did not run.

`wrangler dev` is *not* the equivalent for these: for a directory of static
files it is a slower path to the same bytes.

### Worker

`npm run dev:api` needs `wrangler login`: the AI binding has no local simulator,
so Wrangler runs a remote proxy session (see the `ai` comment in
`apps/api/wrangler.jsonc`). Not needed for pure UI work.

```bash
npm run type-check   # the Worker and the dashboard
npm test             # widget, session, RAG, stats, config, leads, knowledge,
                     # profile, entitlements
npm run build        # all four deploy targets
```

---

## Deployment

Four Workers. **CI deploys them; your laptop does not.** `main` deploys to
staging, a `v*` tag deploys to production, and both build from a clean checkout
of a commit that passed the test suite — see
[.github/workflows/ci.yml](../.github/workflows/ci.yml). Only changed apps
deploy, so a landing-page typo no longer redeploys the script running on
customers' sites.

```
                push to main  →  ck-*-staging.mukeemoha.workers.dev
                tag v1.2.0    →  the four custom domains
```

CI holds exactly one credential, `CLOUDFLARE_API_TOKEN`, scoped to editing
Workers. Worker secrets are pushed once with `npm run secrets:push` and live in
Cloudflare — a pipeline that can read every production key has a far larger
blast radius than one that can only publish code.

### Deploying by hand

Still possible, and occasionally necessary. Each app is a workspace with its own
`wrangler.jsonc`:

```bash
npm run deploy:api       # ck-api    — the Hono app, all bindings
npm run deploy:app       # ck-app    — builds the dashboard first
npm run deploy:cdn       # ck-cdn    — widget + fonts + brand
npm run deploy:site      # ck-site   — the landing page
npm run deploy           # all four, api first
```

Deploy **api first**: a dashboard or widget build that expects a field the API
does not serve yet is the failure that ordering exists to avoid.

### Deploying to staging by hand

Two things, not one — and forgetting the first is the trap:

```bash
export CK_ENV=staging          # PowerShell: $env:CK_ENV='staging'
npm run build                  # bakes the staging hostnames in
npx wrangler deploy --env staging -c apps/api/wrangler.jsonc
```

`--env staging` picks the Worker; `CK_ENV` picks the hostnames the build
*points at*. The dashboard bundle and the landing page carry them as literals,
so `--env staging` on its own deploys a staging Worker that calls the production
API — which works, looks fine, and tests nothing. CI sets both together.

### Hostnames

Written in exactly one place, [config/origins.js](../config/origins.js). Moving
to another zone is an edit to `ZONE` there plus a redeploy.

| Role | Worker | Production hostname |
|---|---|---|
| Landing | `ck-site` | `conversekit.mukeremshifa.com` |
| Dashboard | `ck-app` | `app.conversekit.mukeremshifa.com` |
| Widget + fonts + brand | `ck-cdn` | `cdn.conversekit.mukeremshifa.com` |
| API | `ck-api` | `api.conversekit.mukeremshifa.com` |

> **TLS trap at this depth.** Universal SSL on a full-setup zone covers the apex
> and **first-level** subdomains only — `*.mukeremshifa.com` does *not* cover
> `api.conversekit.mukeremshifa.com`. Attaching a Workers **Custom Domain**
> provisions a certificate for that exact hostname automatically at any depth,
> which is what the `custom_domain: true` routes in each `wrangler.jsonc` do.
> Create a plain proxied DNS record at that depth instead and you get a TLS
> handshake failure with no obvious cause.

### The widget's three URLs

One build, three paths, three cache policies — all served by `ck-cdn` and all
declared in [apps/cdn/assets/_headers](../apps/cdn/assets/_headers):

| Path | Cache | Purpose |
|---|---|---|
| `/v1/widget.js` | `max-age=600, must-revalidate` | **What the install snippet emits.** Major-pinned. |
| `/0.11.0/widget.js` | `max-age=31536000, immutable` | Exact pin. |
| `/widget.js` | `max-age=300, must-revalidate` | Floating latest. Do not advertise it. |

The version comes from `WIDGET_VERSION` in
[apps/cdn/assets/widget.js](../apps/cdn/assets/widget.js) and is read by
`scripts/build-assets.mjs`, so bumping it is a one-line change that produces a
new immutable path on the next deploy. Each prefix carries its own copy of the
fonts, because the widget derives its asset base from its own `<script src>`.

---

## Onboarding a new client (the workflow)

1. **Create the account.** They sign up; the signup trigger provisions an
   organization, an owner membership and a bot in one transaction. There is
   nothing to insert by hand.
2. **Fill the knowledge base.** They sign in to the dashboard and fill in the
   business profile, knowledge sources, branding and custom instructions. Set
   **Allowed origins** to their exact site URLs — no trailing slash, e.g.
   `https://acmedental.com`. A bot with an empty list refuses every origin,
   which is the safe direction for a widget answering anonymous traffic to fail
   in.
3. **Hand over the snippet.** Give the client one line to paste before
   `</body>`:

   ```html
   <script src="https://cdn.conversekit.mukeremshifa.com/v1/widget.js"
           data-bot-id="THE_BOT_UUID" defer></script>
   ```

   The Install screen in the dashboard emits exactly this, with the bot's id
   filled in — copy it from there rather than typing it.

4. **Monitor.** Watch incoming **Leads** and **Conversations** in the dashboard.

---
