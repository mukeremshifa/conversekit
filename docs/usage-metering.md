# Usage metering — build brief

Roadmap [Phase 5 — Operations](roadmap.md#phase-5--operations), first item:

> **Usage metering** — token counts already flow back through `Usage` on every
> call and are currently discarded. Persist per-org and per-bot.

This is the self-contained version of that line: what is already true, what to
decide before writing SQL, the work in order, and the specific ways this
particular feature goes wrong on this particular deployment.

**Scope.** Persist tokens, price them, show them. It ends at a Usage screen a
tenant can read. Budget caps, cross-vendor failover and prompt caching all
depend on this landing first and are named in §8 as explicitly out.

**STATUS — built.** Phases 0–6 have landed. `supabase/017_usage.sql`, `logUsage`
and `getUsageLog` in `src/supabase.ts`, `estimateTokens` / `usageTokens` /
`buildUsage` in `src/stats.ts`, `resolvePrice` in `src/providers/catalog.ts`,
`GET /v1/admin/bots/:id/usage` and `POST /v1/admin/bots/:id/provider/test` in
`src/index.ts`, a second cron branch for `prune_usage_log`, and a **Usage**
screen in the dashboard.

Three things stated plainly, because they are what a reader of this file next
needs to know:

1. **The rates in `MODEL_PRICES` and `VENDOR_PRICES` were entered by hand, not
   read off a live vendor page.** `pricedAt` says `2026-08-20` and that is the
   hand-entry date. Verifying them is the first task before anyone treats a
   figure on the Usage screen as anything but indicative — which is what §2 D3
   said the field was for.
2. **Phase 3's unit tests and §7's `usage_log` RLS case were not written**, at
   the explicit instruction of whoever commissioned this run. `buildUsage` is
   therefore the only aggregate on the platform with no offline coverage, and
   the cases §7 names — the reported/estimated split, a day boundary, a vendor
   with no price, cost `null` versus zero, the cap — are the ones to write
   first.
3. **The reconciliation in §7 has not been run**, so "how far off the estimator
   is" is still the word *roughly* rather than a measured number. That
   measurement belongs in this document when someone takes it.

Two small deviations from the plan below, both noted where they occur: the route
clamps its window at **365 days rather than 90** (the table is kept for 400 days
precisely so year-over-year is answerable, and a 90-day ceiling would make the
extra retention unreadable), and `prune_usage_log` clamps into **[30, 800]**
rather than 012's [7, 365], because a default of 400 cannot survive a ceiling of
365.

---

## 1. The five facts this plan is built on

**F1 — the pipe is already laid, and it drains into nothing.** All four
adapters map their vendor's usage onto `Usage` correctly:
[anthropic.ts:102](../src/providers/anthropic.ts#L102),
[google.ts:41](../src/providers/google.ts#L41),
[openai-compat.ts:55](../src/providers/openai-compat.ts#L55),
[workers-ai.ts:82](../src/providers/workers-ai.ts#L82). It reaches the widget on
the SSE `done` frame ([index.ts:883](../src/index.ts#L883)) and the dashboard on
the preview route ([index.ts:1269](../src/index.ts#L1269)), and is dropped in
both places. `POST /v1/chat` does not return it at all. No migration in
`supabase/001`–`016` has a token column.

So this is a persistence and presentation job. **No adapter needs editing** —
which is what makes it small, and is also why it has sat undone: nothing is
broken, there is just nothing to look at.

**F2 — embeddings are the bigger number and are dropped harder.** `embedPieces`
in [ingest.ts:238](../src/rag/ingest.ts#L238) throws `res.usage` away and returns
`{ vectors, model, dimensions }`. Ingesting a corpus is where a tenant's tokens
actually go — one document is thousands of input tokens, one chat turn is
hundreds — and a meter that counts only chat under-reports the bill in the
direction that matters.

**F3 — on the platform default, three of the four adapters report nothing.**
This is the fact that decides the schema.

| Path | Vendor | Reports usage? |
|---|---|---|
| Chat, buffered | Gemini | yes |
| Chat, streamed | Gemini | yes |
| Embeddings, ingest | Workers AI | **no** — `NO_USAGE`, [workers-ai.ts:173](../src/providers/workers-ai.ts#L173) |
| Embeddings | Gemini | **no** — batch endpoint omits it, [google.ts:241](../src/providers/google.ts#L241) |
| Chat, streamed | Ollama / LM Studio / custom | **no** — `supportsStreamUsage: false`, [catalog.ts:178](../src/providers/catalog.ts#L178) |

The README's headline claim is that Gemini Flash Lite plus Workers AI
embeddings run the whole loop free. That is the configuration most deployments
are on, and a naive `usage_log` with `input_tokens integer` records `null` for
every ingest on it. Build against OpenAI, ship, and the default deployment
displays zeros.

**F4 — there are no prices anywhere.** `costTier` in the catalog is
`'paid' | 'free-tier' | 'local'` — a vibe, not a number. Tokens cannot become
money without adding rates.

**F5 — `retrieval_log` (012) is a working template for all of this, and
`buildMissReport` is a working template for the aggregate.** Same write pattern
(`waitUntil`, non-fatal, service-role), same org derivation (trigger, not
caller), same RLS shape (select for members, no tenant write), same cap
surfaced rather than hidden, same cron retention. **Copy it. Do not invent a
second pattern for the same problem** — most of the value of the second instance
of a pattern is that it is the same as the first.

---

## 2. Decisions taken

### D1 — One `usage_log` table, not a column on `conversations`

Four reasons, in order of how load-bearing they are:

1. **Embeddings have no conversation row.** Ingest is not a turn. A column on
   the transcript cannot hold F2's numbers at all, and the workaround — a
   separate embedding table — is this table with extra steps.
2. **A failed turn still spent tokens.** The vendor charges for the input it
   read before it 5xx'd. `persistTurn` never runs on that path, so a column on
   the assistant row silently loses exactly the spend a tenant most wants
   explained.
3. **Retention differs.** Transcripts and `retrieval_log` hold what visitors
   typed; usage rows hold six integers and no PII. Coupling them forces the
   stricter window onto data that does not need it, and the platform loses its
   own billing history every 90 days.
4. **One call is not one turn** — see L4.

*Rejected:* `conversations.usage jsonb`. Cheapest to write, fails 1–3.

### D2 — Every row records where its numbers came from

`source text not null` — `'reported'` or `'estimated'` — and the aggregate
returns the split rather than a single blended total.

This is the B1 lesson applied before the fact rather than after.
`retrieval_log` stores `min_similarity` beside `top_score` precisely so a stored
score stays interpretable months later; a token count with no provenance is the
same failure waiting to happen. "You used 1.2M tokens" is a materially different
statement from "you used about 1.2M tokens, 60% of it estimated by character
count", and a schema that cannot tell them apart will present the second as the
first.

The estimator is `Math.ceil([...text].length / 4)` — codepoints, not UTF-16
units, the same correctness the short-query gate already applies. **Say plainly
in the code comment that it is a rough proxy calibrated for Latin script that
inflates for Amharic and CJK.** It exists so a free-tier tenant sees a shape
rather than a blank, not so anyone can bill from it.

### D3 — Prices resolve exactly the way similarity floors do

Do not add a flat `pricePer1M` to `VendorPreset`. A tenant on `gpt-4o` pays
roughly sixteen times a tenant on `gpt-4o-mini`, and both are `vendor: 'openai'`.

Mirror [`resolveSimilarityFloor`](../src/providers/catalog.ts) — it is in the
file being edited, it already solved this exact shape (a property of the
*model*, defaulted by the *vendor*, reported with its provenance), and matching
it makes the second function free to understand:

```ts
export interface Price {
  inputPer1M: number;
  outputPer1M: number;
  embedPer1M?: number;
  currency: 'USD';
  /** ISO date these were last checked against the vendor's page. */
  pricedAt: string;
}

const MODEL_PRICES: Array<{ pattern: RegExp; price: Price }> = [ /* … */ ];

export function resolvePrice(
  ref: { vendor: string; model: string },
): { price: Price | null; source: 'model' | 'vendor' | 'none' };
```

`costTier: 'local'` resolves to a zero price, not to `null` — a local model
costs nothing, and that is a measurement rather than an absence. `custom`
resolves to `null`, because nobody knows what that endpoint charges.

**Cost is computed at read time, never stored.** A stored figure freezes a wrong
rate permanently and cannot be corrected; recomputing means a price fix applies
to the whole history. The cost is indicative regardless — BYOK tenants and
negotiated rates make it so — so the UI shows `≈` and surfaces `pricedAt`.

### D4 — Aggregate in the Worker, pure, capped, in `stats.ts`

`buildUsage(opts)` beside `buildStats` and `buildMissReport`, pure over rows the
caller fetched, with `USAGE_LOG_CAP` surfaced as `truncated`. The reasoning in
the [supabase.ts:1099](../src/supabase.ts#L1099) comment applies unchanged: a
`group by` means an RPC means a migration means deployment coupling, and at this
volume the round trip is cheaper. Move to an RPC when a bot regularly hits the
cap — not before.

It also inherits the offline harness, which is the only place aggregates on this
platform actually get tested.

### D5 — Written from `waitUntil`, non-fatal, always

Byte-for-byte the `logRetrieval` treatment at
[supabase.ts:1045](../src/supabase.ts#L1045): try, catch, `console.error`,
return. **A metering failure must never cost a visitor their answer.** Metering
is the platform's bookkeeping; the tenant's customer is mid-sentence.

### D6 — Preview traffic is metered, tagged `kind: 'preview'`

The preview route is `ephemeral` and writes no transcript — but it spends real
tokens on somebody's real key, and an operator testing thirty prompts in the
Playground is real spend. Log it under its own `kind` so it can be excluded from
a tenant-facing chart and included in a reconciliation against the vendor's own
invoice. **That reconciliation is the only end-to-end check this feature has**
(§7), and it fails by exactly the preview volume if preview is not recorded.

### D7 — `outcome` is a column, not an omission

`'ok' | 'error'`. On a provider failure, log what was spent — input tokens were
consumed even when no output came back. Without it the meter reads lowest
exactly when a tenant is burning money on retries against a misconfigured
vendor, which is the one moment it needs to read high.

---

## 3. The schema

`supabase/017_usage.sql`. Additive; nothing else changes.

```sql
create table if not exists usage_log (
  id                  uuid        primary key default gen_random_uuid(),
  bot_id              uuid        not null references bots(id)          on delete cascade,
  org_id              uuid        not null references organizations(id) on delete cascade,
  -- Nullable, same as retrieval_log: ingest and preview have no session.
  session_id          text,
  -- 'chat' | 'embed' | 'preview'. Deliberately not a CHECK constraint —
  -- same reasoning as retrieval_log.channel: a fourth kind (rerank is
  -- the obvious next one) should not need a migration to start
  -- recording itself.
  kind                text        not null,
  vendor              text        not null,
  model               text        not null,
  input_tokens        integer,
  output_tokens       integer,
  -- Reserved for prompt caching (roadmap Phase 6). Nullable and unused
  -- today: `Usage` carries two fields, and adding the third later should
  -- be a type change and a mapper edit, not migration 018 against a
  -- populated table. See L6.
  cached_input_tokens integer,
  -- 'reported' | 'estimated'. See D2 — this column is the feature.
  source              text        not null,
  -- 'ok' | 'error'. See D7.
  outcome             text        not null default 'ok',
  created_at          timestamptz not null default now()
);

create index if not exists idx_usage_log_bot on usage_log(bot_id, created_at desc);
-- Not redundant with the above: budget caps and any per-org rollup query
-- the org directly, and that is the next thing built on this table.
create index if not exists idx_usage_log_org on usage_log(org_id, created_at desc);
```

Then, all copied from 012 without variation: the `set_org_from_bot_row()`
trigger, `enable row level security`, a select policy on
`org_id in (select public.user_org_ids())`, `revoke all … from anon`,
`grant select … to authenticated`, `grant all … to service_role`, table and
column comments, and `prune_usage_log(p_days integer default 400)` with the
clamp **inside the function** for the reason 012's header gives.

400 days rather than 90: this table is billing history with no PII in it, and a
tenant comparing this March against last March is the normal question.

---

## 4. Phases

### Phase 0 — Migration · ~half a day
Write `017_usage.sql` per §3. Apply it. `npm run db:status`. Nothing reads or
writes it yet, and that is a complete, shippable step.

### Phase 1 — The write path · ~1 day
- `UsageLogInsert` and `logUsage()` in `src/supabase.ts`, next to
  `logRetrieval`.
- `estimateTokens()` — one exported function, one home, used by every caller.
  Do not inline `chars / 4` in three places.
- Both chat routes: build the row after generation, dispatch through
  `waitUntil` beside the existing `logRetrieval` call. On the streamed path,
  fall back to `estimated` when the `done` frame carried nulls (**L2**).
- Error paths in both routes: `outcome: 'error'`, estimated input (D7).
- Preview route: `kind: 'preview'` (D6).
- `embedPieces` accumulates `res.usage` across batches and returns it;
  `ingestDocument` and `ingestFaq` each write one `kind: 'embed'` row. Estimated
  from the joined `pieces` when the vendor reported nothing — which on the
  default stack is **always**.

**Verify before moving on:** a turn on Gemini and an ingest on Workers AI both
produce a row, one `reported`, one `estimated`. If only OpenAI was tested, this
has not been tested (**L1**).

### Phase 2 — Pricing · ~2 hours
`Price`, `MODEL_PRICES`, `resolvePrice` in `catalog.ts` per D3. Cover the
default chat model of every priced vendor plus the obvious upgrades (`gpt-4o`,
the Claude tiers, `gemini-*-pro`). Pure config and a pure function — no route
touches it yet. Unit-test the resolution order the way `resolveSimilarityFloor`
is tested.

### Phase 3 — The aggregate and the route · ~1 day
- `buildUsage` in `src/stats.ts`, returning: `totals` (input, output, total,
  calls), `estimatedShare` (0–1, the honesty field), `cost`
  (`{ amount, currency, pricedCalls, unpricedCalls }`, or `null` when nothing
  resolved a price), `byVendor[]`, `byModel[]`, `byKind`, `series[]` reusing
  `dayKey` and the existing UTC bucketing, and `truncated`.
- `getUsageLog` and `USAGE_LOG_CAP` in `supabase.ts`, modelled on
  `getRetrievalLog`.
- `GET /v1/admin/bots/:id/usage`, modelled on the retrieval route at
  [index.ts:2160](../src/index.ts#L2160) — same day clamp, same `UserDb` so RLS
  scopes it, **including the 501 branch** when the error message matches
  `usage_log`, so a Worker deployed ahead of 017 names the missing migration
  instead of sending whoever is debugging it to look at RLS.
- Extend `scripts/test-stats-units.mjs`, or add `test-usage-units.mjs` on the
  same harness. The cases that matter: the reported/estimated split, a day
  boundary, a vendor with no price, cost `null` versus zero, and the cap.

### Phase 4 — Dashboard · ~1 day
A **Usage** screen, not a tile bolted onto Overview: the interesting cut is by
vendor and model, and no existing screen has a shape for that. Spend headline
with `≈`, a stacked daily series, a by-model table, and a plain sentence
whenever `estimatedShare > 0` — *"Your embedding vendor does not report token
counts; N% of this is estimated from text length."* That sentence is the whole
point of D2 and it ships with the number, not after it.

One Overview tile linking through is fine. `estimatedShare` never appears
without its explanation.

### Phase 5 — Retention · ~2 hours
**Its own cron expression and its own branch on `event.cron`.** The comment
above the scheduled handler in `src/index.ts` says this explicitly and names the
failure it prevents — a shared "daily maintenance" function where one failure
takes down unrelated work. Adding a line to the existing handler is the obvious
move and it is the wrong one. Add the second expression to `wrangler.toml`,
branch on `event.cron`, log the row count.

Document the 400-day window in [tenancy.md](tenancy.md) beside the 90-day one.

### Phase 6 — Test connection · ~an afternoon, independent
Not metering, but part of the same arc: it is the cheapest way to find out
whether a given vendor reports usage at all, and it was named in the Phase 3
dashboard scope and never built.
`POST /v1/admin/bots/:id/provider/test` → `generate` with a five-token prompt →
`{ vendor, model, latencyMs, usage, reportsUsage }`, or `ProviderError.kind` on
failure. A button on
[Providers.tsx](../dashboard/src/screens/Providers.tsx).

Today a wrong BYOK key is discovered by a real visitor's turn failing.

---

## 5. Constraints you must not break

1. **Nothing on the request path.** Every write is `waitUntil`. If a change here
   makes a visitor wait, it is wrong regardless of what it measures.
2. **A usage write failure is a log line, never a status code.**
3. **No key material in `usage_log`.** Vendor and model only. `provider_config`
   may hold a BYOK key, and 004's column comment says it must never reach a
   browser; this table is read by browsers.
4. **`/v1/chat` and the SSE frames are additive only.** They are embedded in
   customers' HTML. Adding `usage` to the buffered response is fine; changing
   anything already there is not.
5. **`org_id` comes from the trigger.** Never from the caller, never from a
   claim.
6. **Schema before Worker**, one-directional, as with every migration here.
7. **The similarity-floor block in `catalog.ts` is not to be disturbed.** This
   adds a parallel function to that file; it does not refactor the one already
   in it.

---

## 6. Landmines

**L1 — The default deployment reports nothing (F3).** The single most likely way
this ships broken: developed against OpenAI or Groq, where every number is
`reported`, then run on Gemini + Workers AI where every embedding row is null.
**Develop against the platform default and treat the estimator as the primary
path, not the fallback.**

**L2 — A stream that dies mid-reply spent tokens and reports none.** Usage
arrives on a frame after the last delta; on a mid-stream error that frame never
comes and `usage` stays `{ null, null }` — while the vendor charges for
everything generated up to the failure. Estimate from the accumulated `visible`
text on the error path. This is precisely the case where a tenant's bill and the
meter disagree and they come asking why.

**L3 — The cron will try to accrete.** See Phase 5. The comment in the source
predicted this exact temptation; do not be the thing it predicted.

**L4 — Rows count calls, not turns.** The widget falls back from streaming to
the buffered endpoint on transport failure, so one visitor question can produce
two provider calls and two usage rows. That is **correct for cost** — both were
spent — and wrong for anyone reading row count as conversation volume. Say so in
the table comment, and count turns from `conversations` the way `buildStats`
already does.

**L5 — An estimate multiplied by a price looks exactly like a bill.** Round
hard, lead with `≈`, and never render a cost to the cent while
`estimatedShare > 0`.

**L6 — Prompt caching adds a third token class.** `Usage` has two fields;
Anthropic's `cache_creation_input_tokens` / `cache_read_input_tokens` and
Gemini's `cachedContentTokenCount` are a third and a fourth, priced differently.
`cached_input_tokens` is in §3 unused so that landing roadmap Phase 6 stays a
type change rather than a migration against a populated table.

**L7 — Failover, when it lands, must log the vendor that answered.** Roadmap
Phase 6 resolves a chain; the usage row records the attempt that produced the
tokens, not the tenant's configured first choice, and a failed attempt gets its
own `outcome: 'error'` row. Written down here because the failover work will not
think to come looking for it.

---

## 7. How to verify

- `npm run type-check`, `npm run test` (with the new aggregate cases).
- **The reconciliation, which is the real test:** a bot on a paid vendor with a
  usable console. Run a known number of turns and one ingest, wait for the
  vendor's own dashboard to catch up, and compare. Reported rows should match
  near exactly. Estimated rows will not, and how far off they are belongs in
  this document as a measured number rather than left as "roughly".
- The 501 path: query the route against a database without 017 and confirm the
  message names the migration.
- Isolation: `npm run verify:isolation` still passes, and org A's usage rows are
  invisible to org B. Add a `usage_log` case to `scripts/rls/` alongside the
  existing retrieval test.

---

## 8. Deliberately not built

- **Budget caps and quota enforcement.** The natural next thing, and it needs
  this table plus a rolling per-org sum checked in `preflight` — a request-path
  read, which is a different risk profile from everything above and deserves its
  own decision about caching and fail-open behaviour. `idx_usage_log_org` is
  here for it.
- **Cross-vendor failover** — roadmap Phase 6. Interacts per L7.
- **Prompt and semantic caching** — roadmap Phase 6. Schema leaves room, L6.
- **Billing.** No Stripe, no invoices, no plan enforcement. This is
  measurement.
- **Cloudflare AI Gateway.** A `baseUrl` change in the catalog would get
  logging, caching and cost analytics for the openai-compat vendors — but the
  numbers land in Cloudflare's dashboard, not the tenant's. A complement to this
  table, never a substitute, since the tenant-visible view is the entire
  deliverable.
