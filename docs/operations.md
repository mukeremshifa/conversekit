# Operations

Migrations, secrets, local development, deploying, and onboarding a client.

[← Back to the README](../README.md)

---

## One environment

There is no staging. One Supabase project, one set of four Workers, one branch.
`npm run dev` runs that same stack on localhost against that same database.

That is a deliberate trade, not an oversight. A second environment costs a
second Supabase project, a second set of secrets, a second set of hostnames and
a second thing to be wrong — and it buys safety that only pays off once there is
real customer data to protect. There is not yet. When there is, the bridge to
cross is in [roadmap.md](roadmap.md); until then, the rule that replaces it is:

> **The database is real.** `npm run dev` writes to the same rows the deployed
> dashboard reads. Nothing you do locally is a rehearsal.

---

## Working in git

**One branch: `main`.** Commit to it directly. There is no environment for a
branch to correspond to, so a long-lived branch is a merge you owe yourself
later in exchange for nothing.

Branch only to park work you cannot finish today, and name it after the work
rather than a tier:

```bash
git switch -c lead-export       # good — a thing you are building
git switch -c staging           # there is no such thing here
```

Merge or delete it within a day or two. A branch that outlives the change it
holds is the thing that made "what's what" hard the first time.

The repo is configured for that shape:

| Setting | Effect |
|---|---|
| `pull.rebase = true` | `git pull` replays your commits on top instead of writing a merge commit. One person, one line of history |
| `rebase.autoStash = true` | a dirty tree no longer blocks that pull |
| `push.autoSetupRemote = true` | `git push` on a new branch works without `-u origin …` |
| `push.followTags = true` | annotated tags go up with the push — which is what makes the deploy tags below useful |

They are local (`git config --local`), so they travel with this clone rather
than changing anything else on the machine.

Commit messages keep the `type(scope): summary` convention already in the log —
`fix(app):`, `feat(demo):`, `refactor(api):`. It is worth keeping for one reason
only: `git log --oneline` stays skimmable when you come back to this in a month
and need to find when something changed.

### Before you push

There is no CI to catch you, so this is the whole gate:

```bash
npm run type-check
npm run build
```

`npm run deploy` runs the type-check itself (`predeploy`), so a deploy cannot
publish a Worker that does not compile. If that ever gets in your way, it is one
line in `package.json`.

---

## Database migrations

`supabase/*.sql` is applied in numeric order by a runner, not by hand:

```bash
npm run db:status            # what is applied, what is pending
npm run db:migrate           # apply everything pending
npm run db:migrate -- --dry-run
npm run db:reset -- --yes    # DESTROY public + every auth user, then reapply
```

Six files, described in [supabase/README.md](../supabase/README.md).

Add **one** credential to `.env.tools` (copy `.env.tools.example`); the project
ref is read from `SUPABASE_URL` in `apps/api/.dev.vars`, so nothing else needs
configuring:

| Variable | Where it comes from |
|---|---|
| `SUPABASE_ACCESS_TOKEN=sbp_…` | [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) — preferred: revocable, and never needs the database password |
| `SUPABASE_DB_URL=postgresql://…` | Project Settings → Database → Connection string. Runs through `psql` |

`db:reset` is the only genuinely dangerous one. It drops the whole `public`
schema and every row in `auth.users`, then applies all six files from scratch.
With one environment there is no second database to absorb the mistake, so it
asks for `--yes` and names the project it is about to destroy before it acts.

After a reset, reprovision the landing page's demo bot:

```bash
npm run seed:demo
```

---

## Secrets

Two files, two audiences, and the split is the point.

| Where | Holds | Read by |
|---|---|---|
| `apps/api/.dev.vars` | the five Worker runtime secrets | `wrangler dev`, and uploaded to the edge by `secrets:push` |
| `.env.tools` | `SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_URL` | `scripts/migrate.mjs` only — uploaded nowhere, ever |

Both are gitignored; both have a committed `.example` beside them that is the
documentation.

### Pushing them

```bash
npm run secrets:push               # apps/api/.dev.vars → ck-api
npm run secrets:push -- --dry-run  # names only, no values, no upload
npm run secrets:list               # what the Worker currently holds
npm run secrets:bootstrap          # FIRST deploy only — creates the Worker
                                   # and uploads the secrets in one step
```

This wraps `wrangler secret bulk` rather than calling it directly for two
reasons. It pushes an **allowlist** — the same five names declared as
`secrets.required` in `apps/api/wrangler.jsonc`, and it fails if the two lists
ever disagree — so a credential that wanders into `.dev.vars` does not silently
acquire a home on the edge. And it streams the payload to wrangler over stdin,
so no `secrets.json` is ever written for the next `git add -A` to find.

`secrets.required` in `wrangler.jsonc` is what makes `wrangler deploy` **fail**
on a secret that was never uploaded, instead of producing a Worker that 502s on
the first request that needs it.

---

## Local development

```bash
# 1. Dependencies — one lockfile, all four workspaces
npm install

# 2. Secrets — copy both templates and fill them in
#      apps/api/.dev.vars.example  →  apps/api/.dev.vars
#      .env.tools.example          →  .env.tools

# 3. Schema
npm run db:migrate

# 4. Everything, on localhost
npm run dev
```

`npm run dev` starts all four in one terminal, prefixed and colour-coded, and
one Ctrl-C stops them:

| | Port | What |
|---|---|---|
| `api` | http://localhost:8787 | the Worker, through `wrangler dev` |
| `app` | http://localhost:5173 | the dashboard, through Vite with HMR |
| `site` | http://localhost:8788 | the landing page, with live reload |
| `cdn` | http://localhost:8789 | `widget.js`, fonts, brand assets |

Start a subset when that is all you need — `npm run dev -- app` for dashboard
work, `npm run dev -- site cdn` for the landing page and the widget together.
`npm run dev -- --list` names them.

**The four are wired to each other, not to production.** `scripts/dev.mjs` sets
`CK_DEV=1`, which is the switch in [config/origins.js](../config/origins.js)
that swaps the four deployed hostnames for the four localhost ones above. So the
dashboard calls *your* API and the landing page loads *your* `widget.js`.
Without that, a change to a route or to `widget.js` would show up nowhere,
because the page would be loading the deployed copy.

Supabase is the exception, and deliberately so: there is one project, so a bot
you create locally is a bot that exists.

### The API Worker needs a login

`wrangler dev` on `apps/api` runs a **remote proxy session**, because the AI
binding has no local simulator. Run `npx wrangler login` once. Everything else
works without it — `npm run dev -- app site cdn` is entirely local.

### The landing page and the CDN have a build step

Neither has a bundler, but their sources carry `__CK_API__`-style tokens where
hostnames go, so `scripts/build-assets.mjs` fills them in. `npm run dev` runs
that before it serves, and re-runs it whenever `apps/site/assets/`,
`apps/cdn/assets/`, `packages/brand/assets/` or `config/` changes — which is
also what triggers the browser reload.

Edit `assets/`, never `dist/`. **If you see `__CK_CDN__` in a rendered page, the
build did not run.**

### Pointing the dashboard somewhere else

Copy `apps/app/.env.local.example` to `apps/app/.env.local`:

| Variable | Effect |
|---|---|
| `VITE_API_BASE` | API origin — e.g. to run the local dashboard against the deployed API |
| `VITE_WIDGET_SRC` | the full `<script src>` the Install snippet and Playground emit |

Both fall back to `config/origins.js`, so neither a `npm run dev` nor a
production build needs any environment at all.

### Before you push

```bash
npm run type-check   # the Worker and the dashboard
npm run build        # all four deploy targets
```

---

## Deployment

Four Workers, deployed from your machine. There is no CI: with one environment
and one person, a pipeline is a second place for the deploy to be wrong.

```bash
npm run deploy:api    # ck-api    — the Hono app, all bindings
npm run deploy:cdn    # ck-cdn    — widget + fonts + brand
npm run deploy:app    # ck-app    — builds the dashboard first
npm run deploy:site   # ck-site   — the landing page
npm run deploy        # all four, in that order
```

**`api` first.** A dashboard or widget build that expects a field the API does
not serve yet is the failure that ordering exists to avoid.

Each `deploy:*` builds its own target first, so there is no way to publish a
`dist/` that is older than the source it came from. A plain `npm run deploy`
takes about a minute for all four.

Deploying needs `npx wrangler login` (the same session `dev` uses). Secrets are
**not** part of a deploy — they are pushed separately with `npm run
secrets:push` and live in Cloudflare.

### What is actually live

Nothing records that for you any more, so **tag what you deploy**:

```bash
npm run deploy
git tag -a deploy-2026-08-25 -m "leads CSV export, widget 0.11.0"
git push
```

`push.followTags` is set, so the tag goes up with the commit. `git log
deploy-2026-08-25..HEAD --oneline` is then the answer to "what have I changed
since the last deploy", which is the one thing a pipeline was giving you for
free.

Use a date, not a version — a version implies a release process, and these are
deploys. Keep the `v1.x` tags for actual releases if and when they resume.

### Hostnames

Written in exactly one place, [config/origins.js](../config/origins.js). Moving
to another zone is an edit to `ZONE` there plus a redeploy.

| Role | Worker | Hostname |
|---|---|---|
| Landing | `ck-site` | `conversekit.mukeremshifa.com` |
| Dashboard | `ck-app` | `app.conversekit.mukeremshifa.com` |
| Widget + fonts + brand | `ck-cdn` | `cdn.conversekit.mukeremshifa.com` |
| API | `ck-api` | `api.conversekit.mukeremshifa.com` |

All four are on Cloudflare account `caaf93a3…`, which is the one holding the
`mukeremshifa.com` zone. Each `wrangler.jsonc` states `account_id` outright
rather than leaving it to wrangler's picker: the OAuth token reaches two
accounts, and a Worker route cannot cross them.

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

## The demo bot

The landing page carries a live widget, and the bot behind it is described in
[config/demo-bot.js](../config/demo-bot.js) and provisioned from a script — not
by hand, because a hand-made bot does not survive `db:reset` and the page then
serves a `data-bot-id` matching no row.

```bash
npm run seed:demo                # provision or update it
npm run seed:demo -- --dry-run   # say what would change, touch nothing
npm run seed:demo -- --check     # exit non-zero if it is not serving
```

Its id also reaches the landing page through `config/origins.js`, as the one
non-hostname token in `TOKENS` — so the page and the database cannot disagree
about which bot it is. See [demo-bot-knowledge.md](demo-bot-knowledge.md).
