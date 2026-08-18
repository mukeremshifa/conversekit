# Bot Configuration — build brief

**A self-contained brief.** Everything a fresh session needs to build this
without re-deriving the project. [roadmap.md](roadmap.md) has the wider
roadmap; this file is only about turning `Bot Settings` into **Bot
Configuration** and the settings that come with it.

---

## STATUS — built, 2026-08-18

Phases 0-6 are written and tested, and `009_bot_configuration.sql` **is
applied**. The Worker and Pages deploys (§5 steps 2-4) have not run, which is
the safe order: the schema is ahead of the code, never behind it.

| Phase | Where |
|---|---|
| 0. Rename | `dashboard/src/screens/BotConfiguration.tsx`, `App.tsx` (`#settings` still resolves) |
| 1. Schema + validators | `supabase/009_bot_configuration.sql`, `src/config.ts`, `src/types.ts` |
| 2. Logo pipeline | `src/logo.ts`, three routes in `src/index.ts`, `setBotLogoKey` in `src/supabase.ts` |
| 3. Widget pass | `public/widget.js` v0.9.0 — position, logo, greeting + delay, theme, typing |
| 4. Dashboard editors | `BotConfiguration.tsx` — swatches, suggestion rows, origin rows |
| 5. Live preview | **built, then removed** at the author's request. See the note under Phase 5. |
| 6. Behaviour | `preflight()` in `src/index.ts`, `src/prompt.ts`, `countTrailingMisses` |
| 7. Integrations | not started, and still a separate screen |

Verified: 60 new unit assertions across `test:config` and `test:widget-theme`,
on top of the existing suite (`npm test`, all passing). Both type-checks clean.
009 applied and the columns confirmed present with the right types. Every query
shape the new code uses was then run against the live database through
PostgREST — including the `in.()` title lookup for citations — because
PostgREST caches its schema and a new column can 404 until it reloads. All four
returned 200, and existing rows read `null` across all three columns, which is
the pre-009 path.

**Not verified:** no route has been exercised end to end and the widget has not
run in a browser. Specifically untested: the logo round-trip (upload → R2 →
public GET → `<img>`), the greeting delay, dark mode against a real host page,
and every behaviour setting firing on a live conversation. Those need
`wrangler dev` and a bot with a corpus.

**Three things changed during the build**, each marked below where it applies:

1. **logo_key needed an exception to "replace wholesale"** (D1). The settings
   form does not send it and is forbidden from setting it, so a plain replace
   wiped the logo on every save. `mergeConfigs` now carries exactly that one
   field forward — including when the whole column is cleared, which would
   otherwise orphan the R2 object.
2. **Escalation needed a column after all** (D3). Counting consecutive
   retrieval misses means knowing whether *past* turns missed, and nothing
   recorded that. `conversations.retrieval_miss` does now.
3. **The logo key uses a random segment, not a content hash.** Same cache
   property — a new upload is a new URL — for less work.

A fourth thing surfaced while re-reading the widget: with a delay configured,
a visitor can open the panel and send a message before the greeting fires, and
the greeting would then land underneath a question it does not answer. It is
now dropped in that case rather than shown late.

---

## 1. The four facts this plan is built on

Read these before touching anything — three of them contradict assumptions that
are easy to make from the outside.

**1. The widget has exactly one config channel: `GET /v1/bots/:id/health`.**
[src/index.ts:149](../src/index.ts#L149) returns a *fixed field list*, and the
comment there says why: it is the only thing keeping knowledge-base text and
provider config from leaking to an anonymous caller. Every new widget-visible
setting is an explicit line in that response. Do not switch it to spreading the
bot row.

**2. Widget copies go stale, and tenants may self-host them.**
`ASSET_BASE` in [public/widget.js](../public/widget.js) is read from the script
tag's own `src` precisely so a tenant can serve their own copy. So every new
config field must be *additive and ignorable*: absent field → today's exact
behaviour. The existing `if (d.name) config.name = d.name` pattern in
`fetchConfig` is the model to follow.

**3. The dashboard's build output is committed to git.**
`public/admin/assets/*` are tracked files (see commit `63289a1 chore(build):
rebuild dashboard assets`). Any screen change is not shipped until
`npm run build:dashboard` has run and the rebuilt assets are committed. This is
the single easiest step to forget in every phase below.

**4. The chat hot path is one function: `preflight()`.**
[src/index.ts:192](../src/index.ts#L192) is shared by `/v1/chat` and
`/v1/chat/stream`. Everything in Phase 6 lands there, which makes Phase 6 the
only phase that can fail a visitor's turn. It already has the right instinct —
retrieval failure is caught and downgraded to "answer without context" — and
every behaviour setting must inherit that instinct.

---

## 2. Decisions taken

Four forks where the working direction either did not say, or said something the
code does not support. Each is a recommendation, not a lock — override any of
them before Phase 1 starts, because Phase 1 bakes them in.

### D1 — Two JSONB columns, not ten scalar ones

`widget_config jsonb` and `behavior_config jsonb` on `bots`, rather than
`widget_position`, `logo_url`, `greeting_message`, `widget_theme`,
`greeting_delay_ms`, `show_typing`, `show_citations`, `max_messages`, … as
separate columns.

**Why:** `provider_config`, `embedding_config` and `rag_config` already set this
precedent, and the integrations section in §7 will want another five to ten
fields. Ten columns now means a migration per setting later. The cost is that
validation moves from Postgres to the Worker — which is where the origin and
suggestion validators already live ([src/origin.ts](../src/origin.ts)), so
there is a place to put them.

**Watch out:** `mergeConfigs()` in [src/supabase.ts](../src/supabase.ts)
deep-merges `provider_config`/`embedding_config` because of the write-only API
key. These two columns have no secret in them and the form always posts the
whole object, so they use plain replace semantics — do **not** add them to that
merge loop, or a cleared field will silently un-clear itself.

**As built, with one exception.** `widget_config.logo_key` is server-owned: the
form never sends it and `validateWidgetConfig` rejects it if something does, so
replacing the column wholesale deleted the tenant's logo on every save. That one
field is now carried forward in `mergeConfigs`, for the same reason the API key
is — including when the incoming value is `null`, or clearing every setting would
leave an R2 object with nothing pointing at it. Everything else still replaces.

### D2 — The logo is served by the Worker from R2, not by "the existing upload flow"

The working direction says to reuse whatever Sources/KB upload uses. That is
R2 via the `DOCS` binding — but **R2 objects here are never served to a
browser**. Documents get extracted to text and the bytes are only ever read
back by the Worker; there is no public read route. Reusing the upload path
therefore does not produce a URL the widget can put in an `<img>`.

**Recommendation:** a public `GET /v1/bots/:id/logo` on the Worker, streaming
from R2, with a content-hashed object key and
`Cache-Control: public, max-age=31536000, immutable`. One storage system, no
new binding, no new public bucket, and the widget already talks to this origin.

Three constraints that come with it:

- **PNG / JPEG / WebP only. Reject SVG.** An SVG is a script container; serving
  tenant-uploaded SVG from the API origin is not worth the convenience.
- **512 KB cap**, sniffed the same way `detectFileType` sniffs uploads —
  filename and content-type are both tenant-supplied.
- **Keep it out of `documents`.** The org storage cap in
  [008_files.sql](../supabase/008_files.sql) is enforced by a trigger over that
  table. A logo is not a knowledge source; give it its own key prefix and let
  the 512 KB cap be its whole quota story.

### D3 — Escalation keys off a signal we have, not off English phrasing

The working direction suggests counting how often the bot's fallback phrasing
("I don't know", "I'm not sure") fires. That breaks on contact with the
existing prompt, which says *"Reply in the same language the visitor uses"*
([src/prompt.ts](../src/prompt.ts)) — an English regex over a Turkish reply
counts zero every time.

**Recommendation, in preference order:**

1. **Retrieval misses.** `retrieve()` already returns `{ chunks: [] }` when
   nothing cleared `min_similarity`. A bot that *has* a corpus and retrieves
   nothing, N turns in a row, is a deterministic, language-independent
   "I could not answer that". Free — the signal is already computed and
   currently thrown away.
2. **A `[[NOANSWER]]` marker**, if #1 proves too coarse. The machinery exists:
   [src/lead-stream.ts](../src/lead-stream.ts) already holds back a `[[LEAD:`
   marker mid-stream so it cannot flash on screen. A second marker is a small
   generalisation of a filter that is already written and tested.

Either way the UI says "best effort", as the working direction asks. #1 is
honest about that; phrase-matching would have been best-effort *and* wrong.

**As built: #1, plus a column that #1 turned out to need.** The signal is
computed per turn and then thrown away, so a *streak* of misses cannot be
reconstructed after the fact. `conversations.retrieval_miss` (in 009) records it
on the assistant row — NULL for every row written before this and for every bot
with escalation off, so only `true` is ever counted and the Worker never writes
the column unless the feature is on.

### D4 — Rename the route, but keep `#settings` resolving

`screens/BotSettings.tsx` → `screens/BotConfiguration.tsx`, nav label and
screen title to "Bot Configuration", hash route `settings` → `configuration`.
`#settings` is a bookmarkable URL today, so `useHashRoute` in
[dashboard/src/App.tsx](../dashboard/src/App.tsx) gets a one-line alias map
rather than a broken link.

---

## 3. Phases

Ordering differs from the working direction in one place: dark mode is folded
into Phase 3 rather than floating. Position, greeting, theme and the typing
toggle are all edits to the same CSS block and the same `init()` in
`widget.js` — doing them as one pass touches the widget once instead of four
times, and there is one version bump and one Pages deploy instead of four.

### Phase 0 — Rename · ~30 min

| | |
|---|---|
| **Files** | `dashboard/src/screens/BotSettings.tsx` → `BotConfiguration.tsx`, `dashboard/src/App.tsx` |
| **Steps** | Rename with `git mv` so history follows. Component `BotSettings` → `BotConfiguration`. NAV label → "Bot Configuration", id → `configuration`. `Header title` → "Bot Configuration". Alias `settings` → `configuration` in `useHashRoute`. Update `onNewBot: () => navigate('configuration')`. |
| **Verify** | `npm run type-check`, then `#settings` and `#configuration` both land on the screen. |
| **Ship gate** | Rebuild dashboard assets and commit (fact 3). |

Do this first and alone, so every later diff is against the renamed file and no
review has to separate a rename from real work.

### Phase 1 — Schema and config plumbing · ~half a day

Nothing user-visible. This is the spine every later phase hangs off.

| | |
|---|---|
| **Files** | `supabase/009_bot_configuration.sql` (new), `src/types.ts`, `src/config.ts` (new, validators), `src/index.ts`, `src/supabase.ts`, `dashboard/src/lib/api.ts` |
| **Steps** | 1. Migration adding `widget_config jsonb` and `behavior_config jsonb`, both nullable, no default — additive and re-runnable, same shape as 004/005/006. 2. `WidgetConfig` / `BehaviorConfig` interfaces in `types.ts`, both fully optional, plus the two fields on `BotUpdatePayload`. 3. `validateWidgetConfig` / `validateBehaviorConfig` in a new `src/config.ts`, modelled on `validateSuggestions` — return `{ ok, value }` or `{ ok, error }`, clamp numbers, reject unknown keys. 4. Wire both into `PUT /v1/admin/bots/:id` beside the existing origin and suggestion validators. 5. Extend the `/health` response with the widget-visible subset **only**. |
| **Tests** | `scripts/test-config-units.mjs`, built the way `test-stats-units.mjs` builds `src/stats.ts` with esbuild and asserts over a pure module. Add to the `test` script. Cover: clamping, unknown-key rejection, and that `null`/`undefined` round-trips to "widget defaults". |
| **Risk** | PostgREST 400s on a PATCH naming a column that does not exist, so a Worker deployed ahead of `009` breaks *saving*. Migration first, always — the sequencing note in [operations.md](operations.md) applies. Reads are safe: `select=*` just omits the column and every field is optional. |

**Field list** (validators enforce these bounds):

| Column | Field | Type | Bounds |
|---|---|---|---|
| `widget_config` | `position` | `'bottom-right'` / `'bottom-left'` | default `bottom-right` |
| | `theme` | `'light'` / `'dark'` / `'auto'` | default `light` (today's behaviour) |
| | `logo_key` | string | set by the upload route, not by the form |
| | `greeting` | string | ≤ 300 chars |
| | `greeting_delay_ms` | int | 0–10000 |
| | `show_typing` | bool | default `true` |
| | `show_citations` | bool | default `false` |
| `behavior_config` | `max_messages` | int | 0 (off) or 4–100 |
| | `fallback_message` | string | ≤ 300 chars |
| | `escalate_after_misses` | int | 0 (off) or 2–10 |

### Phase 2 — Logo pipeline · ~1 day

| | |
|---|---|
| **Files** | `src/index.ts` (two routes), `src/logo.ts` (new), `dashboard/src/screens/BotConfiguration.tsx` |
| **Steps** | 1. `POST /v1/admin/bots/:id/logo` — multipart, same `c.req.raw.formData()` shape as the document upload route ([src/index.ts:729](../src/index.ts#L729)), sniffed, 512 KB cap, key `logos/{orgId}/{botId}/{contentHash}.{ext}`, writes `widget_config.logo_key`, deletes the previous object. 2. `DELETE` on the same path. 3. `GET /v1/bots/:id/logo` — **public**, no auth, streams from R2 with the immutable cache headers, 404s when unset. 4. Dashboard: a small drop zone reusing the upload/progress plumbing already in `lib/api.ts` (`sendFile` reports progress; `uploadDocument` is the template). |
| **Tests** | Sniffing and cap logic as unit assertions in `test-config-units.mjs`. Route behaviour against `wrangler dev` with R2 local — the pattern Phase 2B used. |
| **Risk** | Bytes are stored before the DB write in the document route, with orphan cleanup on failure; mirror that ordering exactly. Without a `DOCS` binding this must 501 like the document route, not throw. |

### Phase 3 — Widget rendering pass · ~1–1.5 days

One pass over `widget.js`: position, logo, greeting, greeting delay, theme,
typing toggle. Bump `WIDGET_VERSION`, one CHANGELOG entry, one Pages deploy.

| | |
|---|---|
| **Files** | `public/widget.js`, `src/index.ts` (`/health` fields, if not already done in Phase 1) |
| **Steps** | 1. `fetchConfig` learns the new fields, each behind an existence check. 2. **Position** — `#aicb-root` is `bottom:24px;right:24px` at [widget.js:163](../public/widget.js#L163); flipping also needs `#aicb-panel{right:0}` → `left:0`, its `transform-origin:bottom right`, `#aicb-badge{right:-1px}`, and the `#aicb-panel{right:-16px}` mobile rule. Do it with a `ck-left` class on the root and a paired CSS block — not by patching four inline styles. 3. **Logo** — replaces `ICON_BOT` in `#aicb-avatar` and the bubble icon; keep the SVG as the fallback when the image 404s. 4. **Greeting** — the hardcoded string in `init()` at [widget.js:604](../public/widget.js#L604) becomes the configured greeting or today's string; `setTimeout` before it, with the chips rendering after. 5. **Theme** — add a dark `--ck-*` block toggled by a `ck-dark` class; `auto` reads `prefers-color-scheme` **and** keeps listening, the way `lib/theme.ts` does. 6. **Typing** — one conditional around `classList.add('visible')`. |
| **Tests** | Extend `scripts/test-widget-markdown.mjs`'s trick of lifting pure functions out of the IIFE: assert `inkVariant` against both surfaces, and assert the greeting falls back when unset. |
| **Risk — read this one** | `inkVariant()` at [widget.js:140](../public/widget.js#L140) walks lightness *down* until it clears 4.5:1 **against white** (`ratio(luminance(candidate), 1)`). On a dark surface that is backwards — it will happily return near-black text on a near-black panel. Dark mode needs the mirrored search (lighten until it clears the dark surface's luminance), not a reused `inkVariant`. This is the one place in the widget where dark mode is more than a palette swap. |

### Phase 4 — Dashboard editors · ~1 day

Pure UI. No schema, no widget, no Worker. Can run in parallel with Phase 3.

| | |
|---|---|
| **Files** | `dashboard/src/screens/BotConfiguration.tsx`, possibly `components/ui/index.tsx` |
| **Steps** | 1. **Colour** — swatch grid over the dashboard's own tokens (`--color-accent` `#EEBA2B`, `--color-chart-2` `#1D5FA8`, `--color-danger` `#B42318`, `--color-success` `#157347`, … from [index.css](../dashboard/src/index.css)) plus a "custom" swatch revealing today's hex input. Same `primary_color` string underneath. 2. **Suggestions** — one input row each, add/remove/reorder, live counter against the 6 × 80 limits `validateSuggestions` already enforces. 3. **Origins** — row-per-origin table; port `validateOrigins`' rules to inline per-row errors. The Worker stays the authority — client-side checks are for the message, not the gate. |
| **Note** | Duplicating `validateOrigins`' logic in TypeScript is the pragmatic call here (the Worker's copy is 40 lines and stable). If it drifts twice, extract a shared module then, not now. |

### Phase 5 — Live preview · built, then removed

`WidgetPreview.tsx` was written as specified: a React mock of the bubble and
panel reading unsaved form state, labelled "approximate" because it shares no
code with `widget.js` and would drift.

**Removed on review** — the author did not want it on the screen. The component
file is deleted rather than left unrendered, so there is no dead code pretending
to be a feature.

Worth keeping in mind if it ever comes back: the drift it was labelled for is
real, and the reason it is hard to do properly is in the deleted file's header
comment. `widget.js` mounts itself to `document.body` at z-index 2147483647 and
themes itself from `/health`, so an honest preview is either a mock that drifts
or an iframe that can only show what is already saved.

### Phase 6 — Behaviour · ~2 days, most of the risk

Everything here is inside `preflight()`. Every one of these must degrade to
today's behaviour on failure — none may fail a visitor's turn.

**Files:** `src/index.ts`, `src/prompt.ts`, `src/rag/retrieve.ts`,
`src/supabase.ts`, `public/widget.js`.

**6a — Max conversation length.** Deterministic and cheap, but note the trap:
`getSessionHistory` ends with `limit=20` **ascending**, so it returns the
*oldest* twenty messages. Counting the array caps at 20 and never fires again.
Add a real count — a PostgREST `HEAD` with `Prefer: count=exact` on
`conversations` — rather than counting what history returned. Past the
threshold, append a line to the system prompt asking the bot to offer a human;
let the model phrase it, so it stays in the visitor's language.

*(That 20-oldest window is arguably a pre-existing bug for long conversations —
out of scope here, but worth a roadmap line.)*

**6b — Configurable fallback.** `retrieve()` returns `{ chunks: [] }` when
nothing clears `min_similarity`. `preflight()` currently drops that outcome and
keeps only `renderContext(chunks)` — thread the outcome through instead. When
the bot has a corpus and retrieved nothing, append the tenant's
`fallback_message` to the prompt as the preferred wording. Append, do not
substitute: replacing model output wholesale would break streaming and answer
in the wrong language.

**6c — Source citations.** `match_chunks` returns `document_id` but no title
([005_rag.sql:147](../supabase/005_rag.sql#L147)). Rather than version the SQL
function, do a second lookup on `documents` by the handful of ids retrieved —
cheap, and no migration. Pass titles out through the `/v1/chat` JSON body and
the SSE `done` event (both additive; an old widget ignores them), then render
under the reply. **Escape them** — titles come from filenames and tenant input,
and `renderMarkdown` is the only thing standing between model/tenant text and
`innerHTML`. Never bypass it for a citation.

**6d — Escalation.** Per D3: count consecutive turns where the bot has a corpus
and retrieval cleared nothing, against `escalate_after_misses`. Requires a
per-session counter — the cheapest home is derived from recent conversation
rows rather than new state. Label it best-effort in the UI. Build this last;
if it proves noisy in practice, ship 6a–6c without it rather than shipping a
counter that fires at the wrong moments.

### Phase 7 — Integrations · deferred

Webhooks, Slack/Teams, email recipients, booking link, lead tagging,
post-capture actions. Their own settings screen ("Notifications"), not this
one — the concern is what happens *after* a lead is captured, not how the bot
looks or behaves. Nothing here touches the widget, which makes it the
lowest-risk block on the list and a fine thing to build once Bot Configuration
has settled.

---

## 4. Deliberately not built

**Visitor file uploads.** As the working direction says: an attach button, an
upload endpoint, storage, and attachments threaded into the AI request. That is
a feature, not a config toggle, and it would be the first thing to put
visitor-supplied bytes on the chat path. Separate brief.

---

## 5. Ship sequence

Order is load-bearing — the middle two can be swapped, the ends cannot.

1. **Migration** (`npm run db:migrate`) — a Worker that PATCHes a missing
   column 400s on every save.
2. **Worker** (`npm run deploy`) — `/health` must serve the fields before a
   widget asks for them.
3. **Dashboard** (`npm run build:dashboard`, commit `public/admin/assets`).
4. **Pages** (`npm run deploy:pages`) — ships the widget and the dashboard
   together; `predeploy:pages` runs the scratch-file check first.

Rolling back is per-layer: an older widget ignores fields it does not know, and
an older dashboard simply does not send them. The migration is additive, so
there is nothing to undo there either.
