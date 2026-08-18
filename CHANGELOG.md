# Changelog

Notable changes to ConverseKit. The widget carries its own version, shown in
`window.ConverseKit.version` and in the banner at the top of `public/widget.js`.

## Unreleased

### Added

- **Configurable lead capture** — the `## Lead Capture` prompt block, hardcoded
  since the first release, is now generated from `bots.lead_config`. Capture can
  be switched off entirely, the confirmation wording and a consent line are
  configurable, a booking link can be offered after capture, phone/company/
  inquiry are individually off/optional/required, and every lead can carry a
  label. Full brief: [docs/lead-capture.md](docs/lead-capture.md).
  **A bot with no `lead_config` produces the pre-010 prompt byte for byte**, and
  a test compares the two strings directly rather than trusting the reading.
- **Lead notifications** (`src/notify.ts`) — one webhook per captured lead, as
  generic JSON, a Slack message, or a Teams Adaptive Card. Dispatched from
  `waitUntil` after the lead is committed, 5s timeout, no retries: a webhook is
  a missed notification when it fails, never a lost lead or a slower reply.
  Teams uses the Power Automate Workflows envelope, not the retired
  `MessageCard` connector shape.
- **`supabase/010_lead_capture.sql`** — `bots.lead_config`, plus `leads.tag`,
  `leads.company` and `leads.consent_given`. Additive, re-runnable, NULL
  everywhere means the pre-010 behaviour. `consent_given` records that the bot
  was *instructed to ask*, not that a visitor accepted — there is no checkbox,
  and the column comment says so.
- **Three lead-capture triggers** — on buying intent (the previous behaviour),
  from the start, or after N messages. The first two are instructions the model
  follows; the third counts session rows server-side and rides the `situational`
  channel added in 009, so it fires whether or not the model would have judged
  the moment right.
- **Lead notification emails** — up to five recipients per bot, sent through
  Resend. `reply_to` is the visitor's own address, so replying in the inbox
  answers them directly; recipients are BCC'd rather than listed in `To`,
  because a distribution list is not a thread. Needs `RESEND_API_KEY` and
  `LEAD_EMAIL_FROM` on the deployment — without them recipients are stored and
  nothing is sent, and webhooks are unaffected.
- **View the conversation behind a lead** — a drawer on the Leads screen showing
  that visitor's full transcript. `leads.session_id` has matched
  `conversations.session_id` since the first migration; nothing had ever queried
  across it. `GET /v1/admin/bots/:id/conversations` gains an optional
  `?session_id=`, and the message bubbles moved to a shared
  `components/Transcript.tsx` rather than being copied.
- **`npm run test:leads`** — 102 assertions over prompt generation, the
  byte-identity guarantee, webhook URL validation, recipient validation,
  extraction under a configured field set, and all three notification body
  shapes.

### Security

- **`lead_config.webhook_url` is treated as a credential**, because a Slack
  incoming-webhook URL is one — anyone holding it can post into that channel. It
  is stripped from every admin response (replaced with `has_webhook` +
  `webhook_host`), carried forward on save so an unrelated settings edit cannot
  wipe it, and cleared only by an explicit `null`. Stored URLs must be `https://`
  with a public hostname: IP literals, `localhost`, `.local` names, single-label
  hosts and embedded credentials are rejected at save time, where the error is
  legible, rather than at fetch time, where it is a log line.

- **Bot Configuration** — the `Bot Settings` screen renamed and reorganised
  (`#settings` still resolves, because it is a URL people bookmarked), with the
  settings it was renamed for. Full brief: [docs/bot-configuration.md](docs/bot-configuration.md).
- **`supabase/009_bot_configuration.sql`** — `bots.widget_config`,
  `bots.behavior_config` and `conversations.retrieval_miss`. Additive and safe
  to re-run; every field is optional and absent means the pre-009 behaviour.
  Two jsonb columns rather than ten scalar ones, following `rag_config` — the
  set of settings is still moving, and the notifications work has another
  half-dozen queued behind it.
- **Widget v0.9.0** — bottom-left placement, a tenant logo, a custom greeting
  with an optional delay, light/dark/auto theming, and an optional typing
  indicator. Every field is read from `/health` behind an existence check, so a
  widget older than a setting ignores it and a tenant's self-hosted copy keeps
  working.
- **Logo upload** — `POST`/`DELETE /v1/admin/bots/:id/logo` and a public
  `GET /v1/bots/:id/logo` that streams from R2. The first route in this Worker
  to serve tenant-uploaded bytes to a browser: knowledge-base files are
  converted to text and never served, so there was no public read path before.
  PNG/JPEG/WebP only, 512 KB, identified by leading bytes rather than by
  filename. **SVG is refused** — it is a script container, and a logo is not
  worth handing every tenant script execution on the API origin.
- **Per-section saving** on Bot Configuration. Each section saves only the
  fields it owns, built from the last saved values rather than from live form
  state, so saving one section cannot quietly write another's unsaved edits.
- **Behaviour settings** — offer a person after N messages, a configurable
  fallback line when nothing in a bot's own material matches, source citations
  under a reply, and escalation after N unanswered questions in a row. All off
  by default, all failing non-fatally: an escalation that does not fire is a
  missed nicety, a 502 is a lost visitor.
- **`npm run test:config`** and **`npm run test:widget-theme`** — 60 assertions
  over the new validators, the logo sniffing, and the widget's contrast maths
  on both panel surfaces.
- **Overview screen**, now the dashboard's landing route. Conversations,
  messages, leads and lead conversion as stat tiles with sparklines and a delta
  against the preceding window; messages per day as a stacked area split by
  visitor and assistant; leads per day; the questions visitors actually asked;
  and knowledge-base health. Selectable 7/30/90-day range.
- **`GET /v1/admin/bots/:id/stats`** — aggregated in the Worker rather than in
  Postgres, so it needs no migration. Row caps are reported to the caller and
  surfaced in the UI rather than silently under-reporting.
- **Chart colour tokens**, computed rather than eyeballed: lightness band,
  chroma floor, CVD separation under simulated protanopia and deuteranopia,
  normal-vision floor, and contrast against the card surface — checked in both
  themes. The brand gold is 1.8:1 on a white card and outside the lightness
  band, so the series uses the gold-600 step the UI already uses for strokes.
- **`scripts/check-deploy.mjs`**, run automatically before `deploy:pages`.
  `wrangler pages deploy` uploads `public/` as it finds it, so a git-ignored
  scratch file still reaches production — one did.
- **`npm run test:stats`** — 33 assertions over the aggregation, mostly on day
  bucketing, where an off-by-one puts every chart a day out invisibly.
- **Theme toggle** — System / Light / Dark in the sidebar, persisted, with a
  pre-paint script in `dashboard/index.html` so a dark-mode user never gets a
  white flash. The dark palette already existed in `index.css` and nothing had
  ever been able to select it.
- **Skeletons** replacing the `Spinner` on Leads, Conversations, Sources and
  AI Providers, each shaped like the content that lands so the page does not
  jump. `Spinner` stays where a wait is genuinely indeterminate.
- **Empty states** with an icon, an explanation and an action that unblocks the
  user, replacing one-line grey text on five screens.
- **Command palette** (Cmd/Ctrl-K) over navigation, bot switching and actions,
  built on the Radix Dialog already in the bundle rather than a new dependency.
- **Motion pass** — one route transition, a capped stagger, press feedback and
  a skeleton shimmer, all suppressed under `prefers-reduced-motion` (verified
  by computed style, not by inspection).
- **Wider column for data screens** — Overview, Leads, Conversations and
  Sources get `max-w-6xl`; forms stay narrow and readable.

### Fixed

- **`inkVariant` in the widget assumed a white panel.** It walked a brand
  colour's lightness *down* until it cleared 4.5:1, which is correct on white
  and silently wrong on anything else — dark mode would have shipped near-black
  text on a near-black panel. It now searches away from whichever surface it is
  given. Found while building dark mode, not by a visitor.

### Notes

- Token spend is not charted. Providers return usage per turn but nothing
  persists it, so there is no history to draw; charting it needs a schema
  change first.

## v1.0.0

First tagged release. The platform was already functional; this release is
where it stopped looking like a work in progress.

### Added

- **Visual identity.** A gold (`#EEBA2B`) and crisp-neutral system, the
  ConverseKit mark, and a generated asset set — favicons, an Apple touch icon,
  PWA and maskable icons, an Open Graph card, and light/dark lockups. All
  reproducible with `node scripts/gen-brand-assets.mjs`.
- **Typography.** Bricolage Grotesque for display and Instrument Sans for UI,
  self-hosted across the dashboard, the landing page and the widget.
- **Landing page** at the Pages root. `public/` previously had no `index.html`
  at all, so the site root served nothing. Buildless, self-contained, with the
  real widget running on it.
- **Widget public API.** `window.ConverseKit` exposes `open()`, `close()`,
  `toggle()`, `isOpen()`, `botId` and `version`, so a host page can drive the
  panel from its own button. Guarded against a duplicate script tag.
- **Widget redesign.** Neutral header with the tenant colour on the avatar
  disc rather than a full slab, an explicit close control, suggestion chips
  moved into the transcript under the greeting, timestamps removed, tighter
  radii and spacing.
- **CI** — type-check, unit tests, dashboard build, plus static checks on the
  landing page and every documentation link. No secrets required.
- **`public/_headers`** so cross-origin font and asset requests from tenant
  sites succeed.
- **LICENSE** — proprietary, all rights reserved.

### Fixed

- **Every padding and margin in the widget was being discarded.** The reset
  `#aicb-root *{margin:0;padding:0}` has ID specificity (1,0,0) and outranked
  all 25 class-based rules (0,1,0), so message bubbles, chips, list indents,
  paragraph spacing and inline code all computed to `0`. The reset has to stay
  aggressive — a host page's own `p{margin:1em 0}` must not leak in — so the
  rules are now scoped under `#aicb-root` to reach (1,1,0).
- **White icons on a light brand colour.** `ICON_CHAT` and `ICON_CLOSE`
  declared `stroke` on their inner `<path>`/`<line>`, where a presentation
  attribute beats the stylesheet, leaving them at 1.80:1 on the gold. Colour is
  now owned by CSS, which knows the readable foreground for each tenant.
- **Unreadable text on light tenant colours.** The widget painted white on
  whatever `primaryColor` a bot set. It now picks ink or white per colour by
  luminance, and dims brand-coloured text along its own hue for the white
  panel instead of substituting a neutral.
- **Accent used as text throughout the dashboard.** Focus rings in particular
  were heading for 1.75:1. The accent now splits into fill, stroke and text
  tokens, each meeting its own contrast requirement.
- **`Badge` bypassed the token system**, and its `wait` tone was amber — close
  enough to the brand gold (2.80:1) that a pending state looked like the logo.
- **`bg-fg/[.06]` is not valid Tailwind v4** and compiled to nothing, so the
  neutral chat bubbles had no background at all.
- **`og:image` was relative.** Open Graph requires absolute URLs; link previews
  would have silently had no image.
- Two dead README links to `public/admin/admin.js`, deleted when the React
  dashboard replaced the vanilla one.

### Changed

- **README split.** The root README is now the pitch; the 544-line manual moved
  into `docs/`, one file per concern. `PLAN.md` and `PHASE-2B.md` moved to
  `docs/roadmap.md` and `docs/phase-2b.md`.
- **Widget default colour** is now the ConverseKit gold rather than a leftover
  blue. Tenant colours are unaffected.
- **Warning colour** moved off amber to `#C2410C`.
- Dashboard chat bubbles are neutral; the accent is reserved for the send
  action, so gold appears at most twice per screen.

### Removed

- **`public/test.html`** — the Pearl Dental demo site. It existed to prove the
  widget drops onto a real page, which the landing page now does with a live
  widget.
- **The stale root `index.html`** — a "Clinica AI Assistant" demo from the
  first commit, a different product that was never deployed.

---

## Widget versions

| Version | Change |
|---|---|
| 0.9.0 | Position, logo, greeting + delay, light/dark/auto, typing toggle, citations |
| 0.8.0 | Panel redesign, specificity fix, self-hosted type, contrast audit |
| 0.7.1 | `window.ConverseKit` public API |
| 0.7.0 | Contrast-aware foreground per tenant colour; gold default |
| 0.6.0 | SSE streaming with buffered fallback |
