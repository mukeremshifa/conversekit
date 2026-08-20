# Business Profile & Tiered Knowledge — build brief

**A self-contained brief.** Everything a fresh session needs to build this
without re-deriving the project. [roadmap.md](roadmap.md) has the wider
roadmap, [rag-hardening.md](rag-hardening.md) has the retrieval work this
builds on; this file is only about splitting business facts out of `bots`,
giving them structure, and stopping every turn from going through RAG.

---

## STATUS — Phases 1-7 and 9 built; 8 and 10 not started

**Built:** 1 (schema + types + backfill route), 2 (`src/profile.ts` + prompt
wiring), 3 (validation + API), 4 (Business Profile screen), 5 (retrieval
router), 6 (computed hours — D1 landed as **yes**), 7 (FAQ direct match), and
the Worker half of 9 (the `profile` object on `/health`, and the `booking_url`
overlap resolved in both `leadCaptureLines` and the widget card).

**Not built:** Phase 8 (services as rows), per D2 — it is the largest phase and
Phases 1-7 stand alone without it. Phase 10 (nav reorganisation) beyond moving
Contact off Bot Configuration, which Phase 4 required. Retiring
`knowledge_migrated_at`, which is gated on Phase 8 shipping and every bot being
backfilled. Migration number 017 stays reserved for Phase 8.

**Deviations from this brief, and why:**

- **`profile.contact.notes` was added to the shape.** The backfill maps
  `contact → profile.contact.notes` and the shape as written had nowhere for it
  to land. Same for `hours.notes` and `location.notes`, which the brief does
  list.
- **The eval's routing assertions are inverted from what "Tests" asks for.**
  The brief asks for profile-answerable questions asserting `route: 'skip'`.
  They assert `route: 'retrieve'`, because that is what the router does and what
  the brief's own Phase 5 requires — "do not route by intent regex", and hours
  questions are answered correctly whether or not anything recognised them.
  Asserting it is the regression test that stops someone adding those regexes
  later. The note is in `scripts/eval/golden.json`.
- **"N% of turns answered without a search" is measured as a difference**,
  visitor messages minus logged retrievals, because `retrievalLogRow` logs
  nothing for a skipped turn and that is deliberately kept. It therefore counts
  every turn that did not search, not routed skips alone. Named accordingly, and
  documented at `MissReport.totals.noSearchRate`.
- **The inert timezone picker on `BotConfiguration.tsx` was left untouched**, as
  the brief requires — but its help text now says "nothing reads it yet, until
  opening hours become schedule aware", and opening hours are now schedule aware
  on the Business Profile screen. Worth reconciling.
- **Migration 016 uses `SET LOCAL` and the `%` operator** rather than computing
  `similarity()` per row, so the trigram index the brief specifies is actually
  used. `set_limit()` would leak the threshold across requests on a pooled
  PostgREST connection.

Migration 017 is reserved by this document and not yet applied. 015 and 016 are
written and **not yet run against any database**.

---

## Why

Three problems, and they are the same problem seen from three sides.

**1. `bots` is a junk drawer.** The row in `src/types.ts` carries six unrelated
concerns — tenancy, business facts, bot persona, widget appearance,
conversation behaviour, and infra config — and the business-facts tier has
three generations of the same fields stacked on top of each other:

| Generation | Fields |
|---|---|
| 001/002 | `hours`, `location`, `contact`, `services`, `faq` |
| 002 (Phase 1) | `address`, `contact_email`, `contact_phone`, `business_description` |
| 011 | corpus chunks, gated behind `knowledge_migrated_at` |

`src/prompt.ts` reconciles them at render time (`bot.address ?? bot.location`)
and branches the whole Services/FAQ block on a migration flag. Every new
business field makes that worse.

**2. Facts are answered probabilistically.** Opening hours live in a text
column, get inlined into the prompt, and *also* sit in the corpus as chunks
from whatever page was ingested. Nothing guarantees the two agree, and nothing
stops a stale document chunk from being the thing the model reads.

**3. Every turn goes through RAG.** The only gate is `isTooShortToRetrieve`
(`src/rag/retrieve.ts`) — four codepoints. `"thanks!"`, `"ok sounds good"` and
`"what time do you open"` each fire an embedding round-trip plus a pgvector
search, and can pull up to `DEFAULT_CONTEXT_CHARS = 6000` (~1,500 tokens) of
chunks into a prompt that did not need them.

### What this is worth, honestly

The embedding call is **not** expensive in dollars — a 20-token query on
`text-embedding-3-small` is about $0.0000004, and you would need millions of
turns to notice. Do not build this expecting an embedding bill to drop.

What it is actually worth, in order:

1. **Correctness.** A structured profile makes "what are your hours" a
   deterministic answer instead of a retrieval race.
2. **Context pollution.** Retrieved chunks are the largest variable part of the
   prompt and are billed at *chat-model* rates on every turn. This is where
   retrieval costs real money, indirectly.
3. **Latency.** An embedding round-trip sits in front of time-to-first-token.

---

## Open decisions

**D1 — Does the profile carry a timezone?**

Computed opening hours ("It is Tuesday 14:20 local time; the business is OPEN
until 18:00") is the single strongest argument for structured hours over a text
blob, because an LLM *cannot* derive it — it does not know the current time in
the business's timezone. It needs a timezone from somewhere.

The timezone picker at `dashboard/src/screens/BotConfiguration.tsx:496` is
inert by design and **is not to be touched** — it is not in `OWNED.general`,
not in the `general` save payload, and has no column. That is settled.

So the decision is whether `profile.hours.timezone` exists as its own field,
independent of that picker. This brief **assumes yes** and isolates everything
that depends on it in Phase 6, which can be cut whole without touching any
other phase. If the answer is no: drop `hours.timezone` from the schema in
Phase 1, skip Phase 6, and nothing else in this document changes.

**D2 — Phase 8 (services as rows) is the largest phase and the least urgent.**
It can be deferred indefinitely. Phases 1-7 stand alone.

---

## The model — four tiers

Ask one question of every piece of tenant content:

> **Is it bounded and always relevant, or unbounded and sometimes relevant?**

| Tier | What | Storage | Retrieval policy | Page |
|---|---|---|---|---|
| **0 — Profile** | Hours, address, contact, links, policies | `bots.profile` jsonb, structured | Never retrieved. Always in the prompt. | Business Profile |
| **1 — Services** | The offering list | `services` rows | Names + one-liners always in prompt; full descriptions in corpus | Knowledge · Services |
| **2 — FAQ** | Curated Q&A | `faq_items` rows (exists) | Direct lexical match first, then corpus | Knowledge · FAQ |
| **3 — Documents** | Pages, PDFs, pasted text | `documents` + `chunks` (exists) | Always retrieved. This is what RAG is for. | Knowledge · Sources |

Tier 1's split is the "table of contents in the prompt, chapters in the corpus"
pattern: *"do you do teeth whitening?"* is answered with zero retrieval,
*"tell me about whitening"* retrieves.

---

## Phase 1 — Schema: `bots.profile`

`supabase/015_business_profile.sql`. Additive and re-runnable, per the
convention every migration since 009 follows.

```sql
alter table bots add column if not exists profile jsonb;

comment on column bots.profile is
  'Structured business facts rendered into every system prompt. NULL means
   the legacy hours/location/contact/address columns are rendered instead,
   byte for byte as they were before 015.';
```

### The shape

```
{
  identity: { legal_name, tagline, industry },
  location: { line1, line2, city, region, postal, country,
              map_url, service_area, parking, notes },
  contact:  { phone, whatsapp, email, support_email,
              socials: [{ label, url }] },
  hours:    { timezone,                              -- see D1
              regular: { mon: [{ open, close }], ... sun: [...] },
              exceptions: [{ date, closed, open, close, label }],
              notes },
  links:    { booking_url, pricing_url, portal_url,
              custom: [{ label, url }] },
  policies: { payment_methods: [], cancellation, deposit,
              accessibility, languages: [] }
}
```

Notes that are load bearing, not decoration:

- **`hours` has both `regular` and `notes`.** `notes` is the free-text escape
  hatch and the backfill target (see below). The renderer prefers `regular`
  when it is present and falls back to `notes`, so a tenant is never forced to
  structure their hours before the profile is usable.
- **`location.notes` and `hours.notes` exist for the same reason.** Every text
  column being replaced needs somewhere lossless to land.
- **Times are `"HH:MM"` 24-hour strings, dates are `"YYYY-MM-DD"`.** Validated,
  not parsed into Date objects — the Worker never needs them as instants
  except in Phase 6, which does its own conversion.
- **Empty object is stored as NULL**, via the existing `orNull()` in
  `src/config.ts`. "Never configured" and "configured back to defaults" must
  read alike, as they do for `widget_config`, `behavior_config` and
  `lead_config`.

### Backfill

Do **not** try to parse `bots.hours` into `hours.regular` in SQL. "Mon-Fri 9-5,
closed bank holidays" is not machine-parseable and a half-right parse is worse
than none. The backfill is lossless pass-through into the `notes` and scalar
fields:

```
hours         → profile.hours.notes
address       → profile.location.line1   (or location, if address is null)
contact_phone → profile.contact.phone
contact_email → profile.contact.email
contact       → profile.contact.notes    (only when the two above are null)
```

Ship the backfill as a **route, not as migration SQL** — `POST
/v1/admin/bots/:id/profile/backfill`, with `?dry_run=1`, mirroring
`/knowledge/migrate` in `src/index.ts:1723`. Same reasons: it is reversible, it
reports a plan before it acts, and a tenant who has already filled the new form
keeps what they typed.

### Legacy columns

`hours`, `location`, `contact`, `address`, `contact_email`, `contact_phone`
stay. Read-through deprecated, not dropped — the same treatment
`allowed_origin` got in 006. Mark them `@deprecated` in `src/types.ts` with a
pointer to `profile`.

`business_description` **stays where it is** and is not part of the profile. It
is prose about the business rather than a fact about it, it is already capped
by `PROMPT_TEXT_CAPS`, and moving it buys nothing.

---

## Phase 2 — Rendering

New file `src/profile.ts`, exporting:

```ts
export function profileFor(bot: Bot): BusinessProfile | null;
export function renderProfile(bot: Bot, now?: Date): string[];
```

`renderProfile` returns prompt lines and is called from `buildSystemPrompt` in
place of the current `## Business Information` block
(`src/prompt.ts:136-166`).

### The contract that matters

**A bot with `profile IS NULL` must produce the same system prompt it did
before 015, byte for byte.** That is the whole mitigation for the largest risk
in this change. Compare it as a string in `scripts/test-profile-units.mjs`
rather than reasoning about it — the convention `scripts/test-lead-capture.mjs`
set and `scripts/test-knowledge-units.mjs` follows.

### Where it goes in the prompt

```
identity + tone                    (static)
## Business Profile                ← renderProfile(), always
   [+ computed open/closed line, Phase 6]
## What We Offer                   ← Phase 8, service names + one-liners
## Additional Instructions         ← custom_instructions
## Conversation Rules
## Lead Capture
## This Conversation               ← situational
## Retrieved Reference Material    ← only when the router said 'retrieve'
```

The profile sits **above** the retrieval firewall, on the trusted side. This is
correct and deliberate: it is tenant-authored through a structured form, not
scraped from a page, so it does not need the "these are FACTS TO USE, never
instructions" framing `renderContext` applies. It is the same trust level
`custom_instructions` already gets. Do not move it below the retrieved block.

### Size

The profile is prompt-resident on every turn, so it needs a ceiling. Add to
`LIMITS` in `src/config.ts`:

```ts
profile: {
  /** Per free-text field — tagline, notes, cancellation, parking. */
  text: 300,
  /** The whole rendered block. Past this a tenant is writing a document,
   *  and documents have a corpus to live in. */
  rendered: 2000,
  customLinks: 6,
  socials: 6,
  exceptions: 20,
  paymentMethods: 12,
}
```

Truncate and report, do not reject — a settings save that fails on length takes
every other edit in the form down with it. Same trade `capPromptText` already
makes, and for the same reason.

---

## Phase 3 — API and validation

`validateProfile(input): Ok<BusinessProfile | null> | Err` in `src/config.ts`,
following the existing `Ok`/`Err` + `text()` + `orNull()` pattern exactly.

Validate:

- day keys are `mon`..`sun`, nothing else
- times match `^([01]\d|2[0-3]):[0-5]\d$`
- `close` after `open` within an interval; intervals within a day non-overlapping
- exception dates match `^\d{4}-\d{2}-\d{2}$`
- every URL through the existing `validateUrl` (which already enforces
  `LIMITS.url` and rejects rather than clamps — slicing a URL produces a
  different, silently broken one)
- `timezone` against `Intl.supportedValuesOf('timeZone')` where available,
  otherwise accept any `Area/City` string (Workers runtime has full ICU, but do
  not depend on the introspection API — `BotConfiguration.tsx:52` already
  guards it the same way)

Wire into `PUT /v1/admin/bots/:id` (`src/index.ts:956`) alongside the other four
validators.

**`mergeConfigs` in `src/supabase.ts`: profile is replaced wholesale, not
merged.** It holds no secret, the form posts the whole object, and a merge would
make a cleared field un-clearable. It needs no exception of the kind
`widget_config.logo_key` and `lead_config.webhook_url` get — say so in a
comment, because the next person will look for one.

Add `profile?: BusinessProfile | null` to `Bot` and `BotUpdatePayload` in
`src/types.ts`, and mirror both in `dashboard/src/lib/api.ts:255`. `selectBot`
uses `select=*`, so the column flows through with no query change.

---

## Phase 4 — Business Profile screen

New `dashboard/src/screens/BusinessProfile.tsx`, route `#profile`.

Sections, each with its own `SaveBar` and its own `OWNED` entry, following the
independent-save pattern `BotConfiguration.tsx` established:

| Section | Fields |
|---|---|
| Identity | legal name, tagline, industry |
| Location | address lines, map link, service area, parking |
| Hours | weekly grid, exception rows, notes, timezone (D1) |
| Contact | phone, whatsapp, email, support email, socials |
| Links | booking, pricing, portal, custom rows |
| Policies | payment methods, cancellation, deposit, accessibility, languages |

The weekly grid is the only non-trivial control: seven rows, each a toggle
(open/closed) plus one or more `open`–`close` pairs with add/remove. Reuse the
row-editing pattern from `suggestions` / `allowed_origins` / `lead_emails` in
`BotConfiguration.tsx` (`moveRow`, `removeRow`).

**Because profile is replaced wholesale, every section's save must send the
whole profile object** — build it from `saved` with only that section's keys
overlaid, exactly as `saveSection` does today (`BotConfiguration.tsx:346`).
Getting this wrong silently saves a neighbouring section's unsaved edits.

Wiring in `dashboard/src/App.tsx`:

- `NAV` entry `{ id: 'profile', label: 'Business Profile', icon: Building2 }`,
  placed directly above `configuration`
- `{route === 'profile' && <BusinessProfile bot={bot} onSaved={patchBot} />}`
- **not** in `WIDE_ROUTES` — it is a form
- the command palette picks it up from `NAV` for free

Then **remove** the `contact` section from `BotConfiguration.tsx` — its
`OWNED.contact` entry, its `Section`, and its branch of the `saveSection`
payload ternary.

---

## Phase 5 — The retrieval router

New file `src/rag/route.ts`. This is the phase that actually stops the RAG
calls; Phases 1-4 do not, on their own.

```ts
export type TurnRoute = 'skip' | 'faq' | 'retrieve';
export interface RouteDecision { route: TurnRoute; reason: string }
export function routeTurn(query: string, bot: Bot): RouteDecision;
```

Called from the chat path in `src/index.ts:439` in place of the bare `hasCorpus`
check, and it subsumes `isTooShortToRetrieve` (which stays exported and
unit-tested — it is the multilingual codepoint floor from B3 and must not be
re-derived).

### Skip conditions — conservative on purpose

**A false skip is a wrong answer; a false retrieve is only latency.** Skip only
on confidence. Concretely:

1. `isTooShortToRetrieve(query)` — unchanged, B3-correct
2. Whole-message match against a small multilingual closing/acknowledgement set
   (thanks, thank you, ok, okay, bye, goodbye, gracias, merci, danke, obrigado,
   谢谢, ありがとう, شكرا, …)
3. The message is a bare contact detail — matches an email or a phone-shaped
   string with nothing else in it. This is a lead-capture reply, not a question.

Rule 2 must be **whole-message**, after trimming punctuation and casing — never
a substring test. `"thanks, but what are your hours?"` is a question and
substring matching would kill it.

### What it must NOT do

**Do not route by intent regex.** `/what.*hours/i` will never match
`你们几点开门`, and the prompt explicitly tells the model to answer in the
visitor's language. You do not need intent detection anyway: because the profile
is *always* in the prompt, hours questions are answered correctly whether or not
you recognised them as hours questions. The router's job is to catch turns where
retrieval is **pointless**, not turns where it is **unnecessary**.

### Config

`rag_config.router?: 'off' | 'on'`, **defaulting to `'off'`**, so nobody's bot
changes under them on deploy. Same reasoning `retrieval_mode` defaults to
`'fallback'` for. Surface it on the Retrieval screen next to `retrieval_mode`.

### Observability

`retrievalLogRow` currently returns `null` for anything skipped, deliberately
(`src/rag/retrieve.ts:443`) — a greeting logged as `matched: false` inflates the
miss rate. Keep that. Instead:

- add `skipped: 'routed'` to `RetrievalOutcome['skipped']`
- count routed-skip turns in the existing stats path so the Retrieval screen can
  show **"N% of turns answered without a search"**, which is the number that
  tells a tenant whether this is working

Watch the miss report after switching a bot to `router: 'on'`. If the miss rate
moves at all, a skip rule is too aggressive.

---

## Phase 6 — Computed opening hours *(depends on D1; cuttable)*

With `hours.regular`, `hours.exceptions` and `hours.timezone`, compute in
`renderProfile` and emit one line:

```
It is currently Tuesday 14:20 in the business's local time.
The business is OPEN and closes at 18:00.
```

Rules: an `exceptions` entry for today wins over `regular`. A closed day emits
the next opening. Intervals are checked in order so a lunch break reads
correctly.

Use `Intl.DateTimeFormat` with `timeZone` and `formatToParts` to get local
wall-clock parts — do **not** do offset arithmetic by hand, and do not use
`toLocaleString` round-tripping, which is lossy across DST boundaries.

This whole phase is one function and one line of prompt output. If D1 lands as
"no timezone", delete both and nothing else is affected.

---

## Phase 7 — FAQ direct match

`supabase/016_faq_search.sql`:

```sql
create extension if not exists pg_trgm;

create index if not exists idx_faq_items_question_trgm
  on faq_items using gin (question gin_trgm_ops);
```

Plus an RPC `match_faq_items(p_bot_id, p_query_text, p_match_count,
p_min_similarity)` returning `id, question, answer, similarity`, filtered on
`enabled = true` and ordered by `similarity(question, p_query_text) desc`.

`similarity()` returns a normalised 0-1 score, which is why this is trigram and
not the existing `match_chunks_lexical`. That RPC already exists and already
restricts to FAQ chunks via `p_min_priority: 1`, so reusing it is tempting — but
`ts_rank` is not normalised and cannot be thresholded meaningfully. Reading
`faq_items` directly also means the shortcut works before the FAQ has been
ingested.

In `retrieve()`, before `resolveEmbeddingProvider`:

- run the trigram match, `match_count: 1`
- on a hit above `rag_config.faq_shortcut_threshold` (default `0.5`), return
  that Q&A as a single synthetic chunk and **skip the embed call entirely**
- add `'faq-direct'` to `RetrievalChannel` in `src/rag/retrieve.ts:56`.
  `retrieval_log.channel` is free text in SQL (011), so no migration is needed
  for it — the TS union is the only change.

Tunable per tenant on the Retrieval screen, off by threshold `0` rather than by
a separate boolean. One knob, not two.

---

## Phase 8 — Services as rows *(largest; deferrable — see D2)*

`supabase/017_services.sql`. Table shaped like `faq_items`, hanging off a
synthetic `documents` row so it inherits status, reindex, the chunk inspector,
citations and `ON DELETE CASCADE` unchanged:

```
services(id, bot_id, org_id, document_id, name, blurb, description,
         price_from, price_unit, duration_minutes, url, tags[],
         position, enabled, created_at, updated_at)
```

Needs `'service'` added to the `DocumentSource` union and its CHECK constraint,
RLS mirroring `faq_items` exactly (011 lines 432-454), and the same `org_id`
trigger.

Split at ingest:

- `name` + `blurb` → rendered into the prompt under `## What We Offer`, always,
  capped at ~15 items. Past that, render nothing and rely on retrieval — a
  fifty-item menu in every prompt is worse than a search.
- `description` → chunked into the corpus like any other source

Replaces `bots.services` (read-through deprecated, backfilled through the same
route as the profile).

---

## Retiring `knowledge_migrated_at`

The flag exists to cut `services` and `faq` out of the prompt once they are in
the corpus (`src/prompt.ts:172`). Under the tier model its job is done by the
tier assignment itself: FAQ stays out of the prompt permanently (Tier 2),
service *names* come back in permanently (Tier 1).

Retire it **last**, after Phase 8 ships and every bot has been backfilled. Drop
order: prompt branch first, then the migrate/revert routes (`src/index.ts:1723`,
`:1817`), then the column. Not before — it is the revert path for 011 and the
only thing standing between a failed backfill and a bot with no knowledge at
all.

---

## Phase 9 — Widget profile card *(optional)*

`GET /v1/bots/:id/health` already serves the widget's public config through
`widgetPublicConfig` (`src/config.ts:639`). A structured profile means it can
also serve a small card — hours, phone, map link, booking button — that
`public/widget.js` renders as real affordances instead of a URL the model
retypes and sometimes gets wrong.

Emit only set fields, camelCase, defaults filled in by the widget not the Worker
— the existing contract in that function, which exists so there is one copy of
the defaults. Additive: an older widget ignores the object.

**Resolve the `booking_url` overlap here.** `lead_config.booking_url` and
`profile.links.booking_url` are the same URL in two places. The profile owns it;
`leadCaptureLines` in `src/prompt.ts` reads `lead_config.booking_url ??
profile.links.booking_url` so nobody's existing configuration breaks, and the
lead form's field becomes an override with a "defaults to your Business Profile
link" hint.

---

## Phase 10 — Nav reorganisation *(optional)*

Move the `leads` section out of `BotConfiguration.tsx` and into `Leads.tsx` as a
tab, using the hash-route tab pattern from `Knowledge.tsx` (`TAB_ROUTES`, real
routes not local state). Lead capture is a workflow, and its settings belong
next to the data they produce.

Final shape:

- **Business Profile** — identity, location, hours, contact, links, policies
- **Bot Configuration** — persona, instructions, appearance, greeting,
  behaviour, access
- **Knowledge Base** — Sources, FAQ, Services
- **Leads** — captured leads + capture settings
- Retrieval, AI Providers, Conversations, Install — unchanged

Add aliases for anything that moves. `ALIASES` in `App.tsx:59` is the mechanism
and the existing `settings` → `configuration` entry is the precedent: a rename
is not a reason to break someone's bookmark.

---

## Tests

New `scripts/test-profile-units.mjs`, registered in `package.json` as
`test:profile` and added to the `test` chain. No network, no database — bundle
with esbuild and import, exactly as `test-knowledge-units.mjs` does.

Pin these, because none of them can be caught by reading the code:

1. **The prompt contract.** `profile IS NULL` produces the pre-015 prompt byte
   for byte, for a bot with every legacy column set and for a bot with none.
   String comparison, not reasoning.
2. **The renderer.** Structured hours render correctly; `notes` fallback fires
   when `regular` is absent; `regular` wins when both are present.
3. **Validation.** Bad times, overlapping intervals, non-day keys, and oversized
   text are each rejected or clamped as specified — and a valid profile
   round-trips through `validateProfile` unchanged.
4. **`orNull` behaviour.** A profile cleared back to defaults stores as NULL,
   not `{}`.
5. **The router.** `"thanks"` skips; `"thanks, but what are your hours?"` does
   **not** skip; `多少钱` does not skip; a bare email skips. This is the test
   that stops a skip rule from quietly eating real questions.
6. **Computed hours** (if D1 is yes). Open, closed, lunch break, exception day,
   day boundary, and a DST transition date.
7. **The context budget.** The `rendered` cap truncates and reports.

Extend `scripts/eval-rag.mjs` with profile-answerable questions (hours, address,
phone, booking) asserting they are answered with `route: 'skip'` — the
ranking-assertion pattern from commit `43426f1`.

---

## Order of work

Phases are listed in dependency order and each is separately shippable.

| # | Phase | Blocks | Notes |
|---|---|---|---|
| 1 | Schema + types + backfill route | 2,3,4 | 015 |
| 2 | `src/profile.ts` + prompt wiring | 4 | NULL path byte-identical |
| 3 | Validation + API | 4 | |
| 4 | Business Profile screen | — | remove `contact` from Bot Configuration |
| 5 | Retrieval router | — | default `off`; this is the one that saves the calls |
| 6 | Computed hours | — | needs D1; cuttable whole |
| 7 | FAQ direct match | — | 016 |
| 8 | Services as rows | 9, retiring the flag | 017; deferrable |
| 9 | Widget profile card | — | resolves the `booking_url` overlap |
| 10 | Nav reorg | — | cosmetic |

**Deploy order is schema first, code second, always** — the same order 009
followed. `selectBot` uses `select=*`, and PostgREST caches its schema: after
applying a migration, exercise every new query shape against the live database
through PostgREST before deploying the Worker, because a new column can 404
until PostgREST reloads.

---

## Risks

**R1 — The NULL prompt contract.** Every existing bot renders through the legacy
path until it is backfilled. If Phase 2 changes that output at all, every bot on
the platform changes behaviour on one deploy. Mitigated by the byte-for-byte
string test, which is why it is test #1 and not test #5.

**R2 — The router eating real questions.** A skip rule that is too broad answers
a real question from the profile alone and looks like the bot got dumber.
Mitigated by conservative rules, a default of `off`, and watching the miss report
after enabling.

**R3 — Wholesale replace across independent section saves.** Six sections saving
one jsonb column, each needing to send all of it. The bug this produces —
section A's save silently persisting section B's unsaved edits — is invisible in
testing and obvious in production. Mitigated by reusing `saveSection`'s existing
`{...saved}` + overlay construction rather than writing a new one.

**R4 — Backfill is one-way in practice.** The route is reversible (the legacy
columns are never written), but a tenant who backfills, restructures their hours
by hand, then reverts loses the restructuring. Say so in the dry-run plan, the
way `/knowledge/migrate` does.
