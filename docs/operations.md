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
npm run db:baseline    # record existing files as applied WITHOUT running them
```

Add **one** credential to `.dev.vars`; the project ref is read from
`SUPABASE_URL`, so nothing else needs configuring:

| Variable | Where it comes from |
|---|---|
| `SUPABASE_ACCESS_TOKEN=sbp_…` | [supabase.com/dashboard/account/tokens](https://supabase.com/dashboard/account/tokens) — preferred: revocable, and never needs the database password |
| `SUPABASE_DB_URL=postgresql://…` | Project Settings → Database → Connection string. Runs through `psql` |

On a database that was migrated by hand — which is every ConverseKit project up
to and including `008` — run `npm run db:baseline` once. That records the
existing files as applied without re-running them, so the first real `db:migrate`
only touches what is genuinely new.

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

**Local** — put them in `.dev.vars` (git-ignored):

```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...
GEMINI_API_KEY=...
```

**Production** — set them as Worker secrets:

```bash
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_ANON_KEY          # publishable key
wrangler secret put SUPABASE_SERVICE_ROLE_KEY  # secret key
wrangler secret put GEMINI_API_KEY
```

> **Both Supabase keys are load-bearing, in different places.** The chat path
> uses the service key; the admin path sends the publishable key as `apikey`
> alongside the user's JWT. Rotating only one leaves half the API broken —
> and the half that breaks (admin) is not the half you notice first.

If you migrate the project to **JWT signing keys**, Supabase also disables the
legacy `eyJ…` API keys. Swap both values for the new `sb_publishable_…` /
`sb_secret_…` pair, update [dashboard/src/](../dashboard/src/), and
redeploy the Worker *and* Pages. No code changes are required.

---

## First-run setup

1. Run the migrations in order in the Supabase SQL Editor: `001_init.sql`,
   `002_phase1.sql`, `004_provider_config.sql`, then `003_tenancy.sql`.
   **Read the header of `003` first** — it revokes the anon key's table access,
   so the Worker must already be deployed with `SUPABASE_SERVICE_ROLE_KEY`.
2. Fill in `SUPABASE_URL` and `SUPABASE_ANON_KEY` at the top of
   [dashboard/src/](../dashboard/src/). Both are browser-safe once
   `003` has run — the anon key can then only reach `/auth/v1/*`.
3. Open the dashboard and **Create an account**. A trigger gives you an
   organization and an `owner` membership.
4. Claim any bots that existed before tenancy — `003` parks them in an
   `unclaimed` holding org. Run the snippet at the bottom of `003_tenancy.sql`
   with your email, then confirm it reports zero stranded bots.

Do not commit a filled-in copy of that claim snippet.

---

## Local development

```bash
# 1. Install dependencies
npm install

# 2. Run the migrations (Supabase SQL Editor), in order:
#    supabase/001_init.sql   then   supabase/002_phase1.sql
#    001 seeds a "Demo Clinic Bot" — copy its UUID from the bots table.

# 3. Add your secrets to .dev.vars (see above)

# 4. Start the Worker locally
npm run dev          # Wrangler at http://localhost:8787

# Type-check anytime
npm run type-check
```

The widget and admin dashboard in `public/` are static files — open
`public/index.html`, or serve `public/` with any static server, to test
against your local or deployed Worker (set the API base in `widget.js` /
`admin/admin.js`).

---

## Deployment

### Worker (API)
```bash
# Set secrets once (see Secrets section), then:
npm run deploy        # wrangler deploy
```

### Dashboard

React + Vite + Tailwind, shadcn-style components owned in
[dashboard/src/components/ui](../dashboard/src/components/ui). It builds **into**
`public/admin/`, so one Pages deploy ships the dashboard, the widget and the
demo page together.

```bash
npm run dashboard        # dev server against the live API
npm run build:dashboard  # → public/admin/
npm run deploy:pages     # build, then deploy public/ to Pages
```

`public/admin/` is generated — edit `dashboard/src/`, never the build output.

### Frontend (`public/`)
The widget, demo, and admin dashboard are deployed to **Cloudflare Pages**
(`conversekit-widget.pages.dev`). Deploy the `public/` directory:

```bash
wrangler pages deploy public
```

> The Worker serves **only** the API — it does not serve static files. Any change
> to `widget.js`, the demo, or the admin dashboard requires redeploying `public/`
> to Pages.

---

## Onboarding a new client (the workflow)

1. **Create the bot.** In Supabase, insert a new row into `bots` (or clone the
   demo row). Set `allowed_origin` to the client's exact site URL — no trailing
   slash, e.g. `https://acmedental.com`.
2. **Fill the knowledge base.** Open the admin dashboard, sign in with the bot's
   UUID + `ADMIN_SECRET`, and fill in services, FAQ, hours, contact, branding,
   and custom instructions.
3. **Hand over the snippet.** Give the client one line to paste before
   `</body>`:

   ```html
   <script src="https://conversekit-widget.pages.dev/widget.js"
           data-bot-id="THE_BOT_UUID" defer></script>
   ```

4. **Monitor.** Watch incoming **Leads** and **Conversations** in the dashboard.

---
