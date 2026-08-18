# Lead Capture — build brief

**A self-contained brief.** Everything a fresh session needs to build this
without re-deriving the project. [roadmap.md](roadmap.md) has the wider
roadmap, [bot-configuration.md](bot-configuration.md) is the 009 work this
builds directly on top of; this file is only about turning lead capture from
a hardcoded prompt block into a configured feature.

---

## STATUS — complete, 2026-08-18. 010 applied; not yet deployed.

All seven phases are written and tested, and `010_lead_capture.sql` **is
applied**. The Worker and Pages deploys have not run, which is the safe order:
the schema is ahead of the code, never behind it.

| Phase | Where |
|---|---|
| 1. Schema + validators | `supabase/010_lead_capture.sql`, `src/config.ts`, `src/types.ts` |
| 2. Prompt | `leadCaptureLines()` in `src/prompt.ts`, the `after_messages` note in `preflight()` |
| 3. Notifications | `src/notify.ts`, `announceLead()` + `waitUntil` in `src/index.ts` |
| 4. Dashboard config | `BotConfiguration.tsx` — one `Section`, one `OWNED` entry |
| 5. Data path | `extractLead` field set, `saveLead` columns, `Leads.tsx` table + CSV |
| 6. Transcript drawer | `components/Transcript.tsx`, `?session_id=` on the conversations route |
| 7. Email | `emailLead()` in `src/notify.ts`, `RESEND_API_KEY` + `LEAD_EMAIL_FROM` |

**Phase 5 was pulled forward from the second pass**, because 1-4 alone would
have shipped a `fields` setting that the prompt honours but extraction throws
away — a validated, configurable, half-wired setting, which is exactly the
failure mode `enabled` is designed to avoid elsewhere. The ~40 lines that close
the loop (`extractLead`, `saveLead`, the table columns, the CSV) went in with it.

**Phase 7 was un-deferred.** It was held back only because it cannot be
exercised locally without a verified sending domain; that is a deploy-time
concern, and the deploy is being handled separately. The code is in, and a
deployment without the two secrets behaves exactly as it did before — recipients
stored, nothing sent, webhooks unaffected.

Verified: `npm test` all passing, including 102 assertions in `test:leads`.
Both type-checks clean. Dashboard builds.

**Not verified — nothing here has been exercised end to end.** Specifically
untested: a real webhook POST reaching Slack or Teams, an email actually
arriving, a lead captured against a live model with a non-default field set, the
`after_messages` trigger firing on a real session, and the transcript drawer
against real rows. See *After deploying* at the bottom.

---

009 is applied and is the pattern this follows exactly: one
more JSONB column on `bots`, validated in `src/config.ts`, consumed in
`src/prompt.ts`. The 009 migration header already anticipated this work —
*"the notifications work already has another half-dozen fields queued behind
it"* — so this is the thing that comment was holding a place for.

---

## Where the feature lives today

| Piece | File | Shape |
|---|---|---|
| The instruction | `src/prompt.ts:97-108` | 11 hardcoded lines, always emitted |
| The marker | `[[LEAD:{name,email,phone,inquiry}]]` | fixed shape |
| Extraction | `src/leads.ts` | `ExtractedLead` hardcoded to those four |
| Streaming guard | `src/lead-stream.ts` | marker-agnostic — **needs no change** |
| Save | `saveLead()` `src/supabase.ts:385` | fixed columns |
| Fired from | `persistTurn()` `src/index.ts:470` | awaited, in-request |
| Table | `leads` `supabase/002_phase1.sql:19` | `email NOT NULL CHECK (email LIKE '%@%')` |
| Dashboard | `dashboard/src/screens/Leads.tsx` | read-only table, search, CSV |

There is no config surface and no notification infrastructure at all.

---

## Verdict on each proposed item

### In — lands as config, no new machinery

| Item | Where it goes | Note |
|---|---|---|
| Enable / disable | `lead_config.enabled` | When off, the `## Lead Capture` block is omitted from `buildSystemPrompt` entirely. Byte-identical to a bot that never had the feature. |
| Success message | `lead_config.success_message` | Replaces the hardcoded step 4 confirmation. |
| Consent text | `lead_config.consent_text` | Injected as a line the bot must say before asking for details. See the honesty note under *Consent* below. |
| Booking link | `lead_config.booking_url` | Prompt tells the bot to offer it after capture. Also travels in the webhook payload. |
| Lead tagging | `lead_config.tag` + `leads.tag` | Applied server-side at `saveLead` time, never by the model. Renders as a `Badge` — the component already exists. |
| Generic webhook | `lead_config.webhook_url` + `src/notify.ts` | Fired from `ctx.waitUntil`, not from the awaited `persistTurn`. See *D5* below. |
| Slack / Teams | `lead_config.webhook_format` | Same dispatcher, three body shapes. Explicit select — **no** sniffing the hostname to guess the format. |
| Custom CRM | — | Zero code. It is the generic webhook with different docs. |
| View transcript from a lead | `Leads.tsx` + one query param | The best effort-to-payoff item on the list. See *D8* below. |

### In, but scoped down

**Trigger type** — three values, not four: `intent` (today's behaviour,
default), `always`, `after_messages` with a count.

The plan called this "prompt-driven, best-effort, not a guaranteed rule."
That is true of `intent` and `always`, but `after_messages` does **not** have
to be a hope: `preflight()` already counts session messages for
`behavior.max_messages` via `countSessionMessages`, and already has a
mechanism for per-turn facts — the `situational[]` array added in 009. So the
count is a real server-side check and the trigger is a real fact pushed into
`## This Conversation`, exactly like the escalation rules. Reuse the same
count when both settings are on rather than issuing two queries.

Drop *"before booking"* and *"asks for a human"* as distinct triggers. The
first is `intent` under another name; the second is already what
`escalate_after_misses` and `max_messages` do, and adding a third path to the
same outcome is the kind of overlap that makes a settings screen unreadable.

**Required / optional fields** — a **closed set of five**, not a form builder.

`name` and `email` stay mandatory and non-configurable. `phone`, `company`,
and `inquiry` each get `off` / `optional` / `required`. That buys the real
feature and skips the `extra jsonb` column: `company` becomes one nullable
text column, so leads stay queryable, exportable, and indexable like every
other field.

Keeping `name`+`email` fixed also keeps the guard in `extractLead` intact —
that check is the only thing standing between the model and a table full of
half-filled rows, and loosening it is the single riskiest edit available in
this feature.

Making `email` optional (phone-only leads) is a real want and is **deferred**:
`leads.email` is `NOT NULL CHECK (email LIKE '%@%')`, so it means a nullable
migration, a loosened extraction guard, and a `mailto:` link in the dashboard
that has to cope with absence. Worth doing on its own, not folded into this.

### Out

| Item | Why |
|---|---|
| Inline consent checkbox | Agreed — `widget.js` has no structured-input primitive and teaching it one is a widget architecture change. |
| Email notifications | **Deferred, not rejected.** Needs a new secret, a verified sending domain, and DNS records — the only item here that cannot be tested from `wrangler dev` with what is already configured. Once `notify.ts` exists it is ~30 lines and one `Env` key. Ship the webhook first; a Slack webhook demos the same "we got a lead" moment with no DNS. |
| Real CRM OAuth | Agreed — separate project. |
| WhatsApp | Agreed — a channel, not a setting. |

---

## Design decisions

### D1 — A third JSONB column, not keys inside `behavior_config`

`behavior_config` is documented as *"when the bot should stop trying and hand
over."* Lead capture is a different question with its own ten fields, and one
of them is a credential. New column: `bots.lead_config`.

### D2 — The webhook URL is a credential, and must be redacted

A Slack incoming-webhook URL is a bearer token: anyone holding it can post
into that channel. It cannot round-trip through the dashboard in the clear.

`redactBotSecrets` already solves this for `provider_config.apiKey` — the
value is **removed**, not masked with bullets, because a sentinel string is
only as reliable as the encoding it survives. Same treatment: strip
`webhook_url`, return `has_webhook: true` and `webhook_host: "hooks.slack.com"`
so the UI can show *"Posting to hooks.slack.com"* without holding the secret.

### D3 — `lead_config` is replaced wholesale, with one carried-forward key

Same as `widget_config`, for the same reason: the form posts the whole object
and a merge makes a cleared field un-clearable. The `webhook_url` exception is
structurally identical to the existing `logo_key` exception in `mergeConfigs`
— carry the stored value forward unless the caller supplied a new non-empty
one, and honour an explicit `null` as a clear.

### D4 — Webhook URL validation is an SSRF boundary, not a typo check

`validateOrigins` is the model for the shape of the validator. The rules:

- parses as a URL, and `https:` **only** — this payload carries PII
- no credentials embedded (`url.username` / `url.password` must be empty)
- hostname is not `localhost`, not a `.localhost` suffix, not an IP literal
  (v4 or v6), and not a single-label host

Workers' `fetch` will not reach RFC1918 from the edge anyway, but a save-time
rejection puts the error where someone can read it instead of producing a
silent no-op an hour later.

### D5 — Dispatch happens in `waitUntil`, not in `persistTurn`

`persistTurn` is `await`ed in both chat routes, so a `fetch` added inside it
puts a third party's latency on the visitor's reply. Have `persistTurn`
return the saved lead and let each route hand the notification to
`c.executionCtx.waitUntil(...)` — the same fire-and-forget pattern already
used for ingestion and R2 cleanup. `AbortSignal.timeout(5000)`, no retries,
failures logged and swallowed.

### D6 — What `consent_given` actually means

`true` records that **the bot was configured to ask for consent at the time
this lead was captured**. It is not proof a visitor ticked anything, and the
column comment must say so — otherwise someone reads it as a compliance
artifact two years from now. Written only when `consent_text` is set; `NULL`
otherwise, so "not asked" and "feature off" do not collapse into `false`.

### D7 — Configuration goes in `BotConfiguration.tsx`, not a tab in `Leads`

Recommendation, and the one place this differs from the draft plan.

A Configure tab in the Leads screen means a second save surface: the
`OWNED` / `isDirty` / `saveSection` / `SaveBar` machinery in
`BotConfiguration.tsx` is ~80 lines that already solve "one JSONB column,
replaced wholesale, saved per section", and there is no `Tabs` primitive in
the UI kit to build the tab strip from. A new `Lead capture` entry in `OWNED`
plus one `<Section>` is **all** the config UI costs.

Cost: `BotConfiguration.tsx` goes 661 → ~900 lines. If that crosses the line,
split **all six** sections into `screens/config/*.tsx` as its own refactor —
extracting one while five stay inline is worse than either end state.

The *data* half stays in `Leads.tsx`: tag badges, the transcript drawer, and
the widened CSV.

### D8 — Transcript reuse, not a second copy of the bubbles

`leads.session_id` already matches `conversations.session_id`. What is missing
is a filter: `GET /v1/admin/bots/:id/conversations` returns the last 100
messages for the whole bot. Add an optional `?session_id=` and a matching
parameter on `getConversations` — that is the entire backend change.

On the dashboard, lift the message-bubble rendering out of
`Conversations.tsx:63-86` into `components/Transcript.tsx` and use it from
both screens. `Dialog` already exists in the UI kit.

---

## Schema — `supabase/010_lead_capture.sql`

```sql
alter table bots  add column if not exists lead_config   jsonb;
alter table leads add column if not exists tag           text;
alter table leads add column if not exists company       text;
alter table leads add column if not exists consent_given boolean;
```

Additive, re-runnable, and NULL everywhere means the pre-010 behaviour — same
contract as 009.

No new index: `idx_leads_bot_id (bot_id, created_at DESC)` from 002 already
serves the only query the dashboard makes, and `tag` is filtered client-side
over at most 100 rows.

No RLS change: the `leads_select` policy and the `grant select on leads`
in 003 are table-level, so new columns are covered as they are added.

`lead_config` shape — every key optional:

```jsonc
{
  "enabled": true,
  "trigger": "intent",              // "intent" | "always" | "after_messages"
  "trigger_after_messages": 6,      // 2..50, only read when trigger is after_messages
  "fields": { "phone": "optional", "company": "off", "inquiry": "optional" },
  "consent_text":    "I'll just note down your details — is that okay?",
  "success_message": "Thanks! I've passed your details to the team.",
  "booking_url":     "https://cal.com/acme",
  "tag":             "Website chat",
  "webhook_url":     "https://hooks.slack.com/services/…",   // write-only
  "webhook_format":  "slack"                                  // json | slack | teams
}
```

**Absent `lead_config` must produce the current prompt byte for byte.** That
is a test assertion, not an aspiration — `scripts/test-config-units.mjs`
already bundles and calls `buildSystemPrompt`, so it is a direct comparison.

Validation limits, following `LIMITS` in `src/config.ts`:

| Field | Rule |
|---|---|
| `success_message` | 300 chars — matches `fallback_message` |
| `consent_text` | 200 chars — it is spoken before a question, not a paragraph |
| `tag` | 40 chars — it renders in a `Badge` |
| `booking_url` | http/https, 500 chars |
| `webhook_url` | D4 rules, 500 chars |
| `trigger_after_messages` | clamped 2..50 |
| unknown key | **rejected**, as everywhere else in `config.ts` |

---

## Files touched

**New**
- `supabase/010_lead_capture.sql`
- `src/notify.ts` — ~90 lines: three body shapes, one guarded `fetch`
- `dashboard/src/components/Transcript.tsx` — lifted from `Conversations.tsx`
- `scripts/test-lead-capture.mjs` — bundles `config.ts`, `prompt.ts`,
  `leads.ts`, `notify.ts`, matching the `test:rag` / `test:config` convention

**Modified**
- `src/types.ts` — `LeadConfig`, `Bot.lead_config`, `BotUpdatePayload.lead_config`, `Lead` gains `tag` / `company` / `consent_given`
- `src/config.ts` — `validateLeadConfig`, `leadConfigFor`, `validateWebhookUrl`
- `src/prompt.ts` — the `## Lead Capture` block becomes generated
- `src/leads.ts` — `extractLead(raw, fields?)`, `company` on `ExtractedLead`
- `src/supabase.ts` — `saveLead` writes the new columns, `mergeConfigs` learns `lead_config` (D3), `getConversations` gains `sessionId?`
- `src/index.ts` — `validateLeadConfig` in the PUT route, `redactBotSecrets` (D2), the `after_messages` situational note, `waitUntil` dispatch (D5), `?session_id=` on the conversations route
- `dashboard/src/lib/api.ts` — `LeadConfig` type, widened `Lead`, `sessionId` arg
- `dashboard/src/screens/BotConfiguration.tsx` — one `Section`, one `OWNED` entry
- `dashboard/src/screens/Leads.tsx` — tag badge, transcript action, widened CSV
- `dashboard/src/screens/Conversations.tsx` — use `Transcript.tsx`
- `package.json` — `test:leads`, added to the `test` chain
- `docs/api.md`, `CHANGELOG.md`

`src/lead-stream.ts` is untouched — it matches on `[[LEAD:` and `]]` and does
not care what is between them.

---

## Build order

Each phase leaves the tree deployable and every phase before the last one is
invisible to a bot with `lead_config` unset.

1. **Schema + validators + types.** 010, `validateLeadConfig`, the PUT route,
   D2 redaction and D3 merge. Tests: unknown keys rejected, URLs rejected,
   the webhook URL never leaves in a GET, a save with no webhook does not wipe
   the stored one.
2. **Prompt.** Enable/disable, success message, consent, booking link, and the
   `after_messages` situational note. Test the null-config byte-identity
   assertion first — it is the one that catches a regression in every other
   bot on the platform.
3. **Notifications.** `notify.ts` + `waitUntil` wiring. Tests are pure body
   shaping and URL validation; the `fetch` is exercised against a local
   listener under `wrangler dev`.
4. **Dashboard config section.** Everything above becomes reachable here.
5. **Tag, company, consent columns end to end** — `saveLead`, the configurable
   field set, `extractLead`, the table, the CSV. Last of the data changes
   because it is the one that touches marker parsing.
6. **Transcript drawer.** Independent of all of the above; do it whenever.

Email notification is a phase 7 that should not block a demo.

---

## Deploying

010 is applied, so what remains is:

1. Optionally, `wrangler secret put RESEND_API_KEY` and `LEAD_EMAIL_FROM` —
   see [operations.md](operations.md). Skipping this leaves email off and
   changes nothing else.
2. `npm run deploy` (Worker).
3. `npm run deploy:pages` (dashboard).

Nothing changes for any existing bot on deploy: `lead_config` is NULL on all of
them, which reproduces the pre-010 prompt exactly, and the new `leads` columns
stay empty until a bot is configured.

**One caveat carried over from the 009 rollout:** PostgREST caches its schema,
and a brand-new column can 404 until it reloads. 010 has been applied for long
enough that this is unlikely, but if the first captured lead after deploy fails
with a column error, that is what it is — it clears itself.

## After deploying

Nothing below has been tested. In rough order of what breaks most quietly:

- **Capture one lead** through the widget or Playground on a bot with default
  settings. It should behave exactly as before 010.
- **The webhook**, against a request-bin URL before a real Slack one. A 403 here
  usually means the URL was regenerated; the host is logged, the URL never is.
- **Email**, if configured. An unverified sending domain fails with a 403 at
  send time, not at deploy time — the only symptom is a captured lead nobody
  hears about, so check the Worker logs after the first one.
- **A non-default field set** — turn `company` on and confirm it reaches both
  the table and the CSV.
- **The `after_messages` trigger** on a session long enough to cross the
  threshold.
- **The transcript drawer** on a lead whose session still has messages.

---

## What this deliberately does not promise

`intent` and `always` triggers, consent wording, and the booking-link offer
are all instructions to a model, not enforced rules — the same footing as
every other prompt-driven behaviour in this product. The Configure UI should
say so once, plainly, so a demo miss reads as a known limit rather than a bug.
`after_messages`, tagging, consent logging, and webhook dispatch are
server-side and do not carry that caveat.
