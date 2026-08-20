# Changelog

Notable changes to ConverseKit. The widget carries its own version, shown in
`window.ConverseKit.version` and in the banner at the top of `public/widget.js`.

## Unreleased

### Added

- **Widget v0.11.0 — shadow DOM, accessibility, and streaming that does not
  fight the browser.** Five things, shipped together because four of them are
  in the same file and the fifth rewrites every selector in it
  (docs/widget-polish.md).

  **The widget renders into a shadow root.** It used to render into the light
  DOM behind a three-property reset, so every host-page rule reached it —
  `button{text-transform:uppercase}`, a framework's global `line-height`,
  anything with `!important` on `font-family`. That had already bitten once
  (`46a9488`, "restore spacing killed by reset specificity"), and the fix then
  was more specificity, which has no next move: nothing outspecifies an
  `!important` on someone else's page. About sixty selectors lost their
  `#aicb-root` prefix in the move.

  The boundary stops selectors, not **inheritance** — the host element is still
  an ordinary div in the page's DOM — so `.ck-w` inside the shadow root
  re-declares every inherited property the widget cares about, and the host
  itself carries only inline `!important` geometry, because a `:host` rule
  loses to the document's own on a tie. `@font-face` is injected into the
  document head rather than the shadow root, which is the one part of this that
  fails silently: a face declared only inside a shadow root is never fetched,
  and the panel would have rendered in the system stack with nothing in the
  console to say so.

  **Accessibility.** A closed panel was still in the tab order — `opacity:0`
  and `pointer-events:none` hide a node from the eye and the mouse but not from
  sequential focus, so on every page carrying the tag a keyboard user tabbed off
  the last link into a chat textarea and a Send button they could not see. It is
  `visibility:hidden` now, in the transition list so the 0.22s animation
  survives. `aria-modal="true"` is gone: nothing traps focus, the host page
  stays usable behind the panel, and the attribute described a widget this is
  not. Closing hands focus back to the launcher, but only when focus was inside
  the panel to begin with. The typing indicator has a name. The unread badge
  counts, instead of reading a hardcoded `1` forever, and the count is spoken
  through the launcher's `aria-label` because a button's label overrides
  anything nested inside it.

  And a streamed reply is announced **once**, not once per token: the bubble
  carries `aria-live="off"` while it fills, lifted at the end, with the final
  render as the single mutation the transcript's polite region reports.

  **Streaming performance.** `append` re-rendered the entire accumulated reply
  and reassigned `innerHTML` on every delta — O(n²), with full DOM teardown per
  token. Beyond the arithmetic: a selection made mid-stream was destroyed, so
  nothing could be copied out of a reply until it finished, and a link in an
  already-painted part was replaced under the cursor mid-click. A delta that
  cannot change how anything already rendered **parses** now goes straight onto
  the trailing text node. Most deltas from every provider in `src/providers/`
  are plain prose, so that is the common path. Smooth scrolling is also off
  while a reply streams: `scrollTop` was being assigned every token and each
  assignment restarted the smooth animation from wherever the last one had
  reached, so it never arrived — that was the stutter.

  **The launcher is the same on every bot.** A tenant logo went onto the 56px
  disc as well as into the panel header; it is header-only now. The launcher is
  a control, and a visitor reads a circle in the corner of a page as "chat" —
  cropped into it, a wordmark reads as a stray avatar instead and the one
  affordance the widget has stops looking like a button.

  **`data-api-base`.** `API_BASE` was hardcoded, so a tenant self-hosting
  `widget.js` — a supported deployment, and the reason `ASSET_BASE` is derived
  from the script's own `src` — still called home for every message. The
  attribute is validated as an https **origin**, with no path, query, or
  fragment: it becomes the prefix of every URL this file fetches, and a
  deployment knob that silently half-works is worse than one that visibly falls
  back. The install snippet emits it only when the dashboard is pointed
  somewhere other than the default, because baking that hostname into every
  pasted tag would make it impossible to move later.

  Also: **fenced code blocks** render as `<pre><code>` instead of a literal row
  of backticks — escaped, and never run through the inline pass, so a URL in a
  shell snippet is not a link — and **autolinks stop swallowing trailing
  punctuation**, which used to put the full stop ending a sentence inside the
  `href`. On iOS, the panel now tracks `visualViewport` so the composer does
  not slide under the keyboard.

- **Widget v0.10.0 — the profile card.** `GET /v1/bots/:id/health` has served a
  structured `profile` object since supabase/015 and nothing consumed it, so the
  only way a visitor got a phone number was to ask the model to retype one out
  of its prompt. It usually did. The widget now renders that object as
  affordances — a **Book** button, **Call**, **WhatsApp**, **Email**,
  **Directions**, and an hours disclosure collapsed to today's line with today's
  row bolded in the expanded week. A `tel:` link built from the column cannot
  drop a digit and a booking button cannot point at a URL that never existed,
  which is the entire argument for the feature (docs/business-profile.md,
  Phase 9).

  Today is resolved in the **business's** timezone, not the visitor's: a shop in
  Lagos is open on its own Tuesday. Every URL is scheme-checked before it
  becomes an `href`, on the same grounds `safeUrl` checks model output — the
  channel is trusted, the column is not the only thing that can write it.

  Renders nothing at all for a bot with no profile, which is every bot until it
  is backfilled.

- **Hybrid retrieval** (`rag_config.retrieval_mode`, supabase/013) — the vector
  and lexical channels can now run on **every** turn over the **whole** corpus
  and be fused by reciprocal rank, instead of lexical being a fallback that only
  fires when vector finds nothing and only over curated FAQ chunks. That is the
  case keyword search wins: a part number or a proper noun buried in a PDF,
  which meaning-based search reads straight past.

  Fused **by rank, never by score** — `match_chunks` returns a cosine and
  `match_chunks_lexical` returns a `ts_rank_cd`, and any weighted sum of two
  scales nobody has measured is a guess dressed as arithmetic.

  It needed a migration, contrary to what the brief predicted: `and c.priority >
  0` was hard-coded inside `match_chunks_lexical`, and that line *is* what makes
  lexical a fallback. It is `p_min_priority` now.

  **Ships off** (`'fallback'` remains the default), and the reason is written
  into the setting itself: lexical over every chunk almost always returns
  something, so "the bot could not answer" stops being reachable and
  `fallback_message` and `escalate_after_misses` quietly die — the same failure
  the similarity-floor fix was about, reached from the opposite direction. The
  miss report is the canary; a miss rate collapsing toward zero after enabling
  it is the symptom, not the win.
- **Second-pass ranking** (`rag_config.rerank`) — an optional cross-encoder pass
  (`@cf/baai/bge-reranker-base`) over the candidates `match_chunks` already
  over-fetches. Reads the question and the passage together rather than
  comparing two independently-produced vectors. No migration: the Worker simply
  asks for more rows.

  **Fails open by design.** The Workers AI binding is a property of the
  deployment, not of the tenant, so a bot with this on may be running somewhere
  that cannot do it — absent binding, unrecognised response, or a call that
  throws all degrade to similarity order. It is a quality improvement sitting on
  the visitor's hot path and may never fail the turn. It runs *after* the
  similarity floor, so it reorders what survived and never rescues what did not.
- **Prose chunks now carry their document title and nearest heading.** The FAQ
  chunker has always repeated the question into every piece of a split answer,
  for the reason its header gives: a fragment without its question is a fragment
  nothing matches. Chunk 14 of a pricing page had no equivalent — a bare
  paragraph with nothing in it saying it was about pricing.

  This could not be a change to the chunker alone, because **all three
  extractors were destroying headings before the chunker could see them** — the
  markdown path stripped the `#` markers, the HTML path replaced `<h2>` with a
  newline, and only a converted file arrived as markdown by accident. So
  `extract.ts` preserves them in one canonical form first, and the chunker
  consumes the markers when building the breadcrumb.

  Existing sources keep their current chunks until reindexed. The prefix also
  feeds the keyword index, which helps it — a heading carries the words a
  visitor types.
- **Near-duplicate suppression.** The same boilerplate paragraph indexed on
  three pages returned three near-identical excerpts that took three of five
  slots and most of the prompt budget to say one thing. Duplicates are dropped
  **before** the budget is spent, so a dropped copy frees its slot *and* its
  characters for a passage that says something new.

  Done by shingle overlap rather than by cosine, and that is a constraint rather
  than a preference: the Worker never receives a chunk's vector, so the obvious
  implementation would mean shipping 768 floats per candidate over PostgREST.
  Literal duplication is what the failure actually is.
- **`bots.chunk_count`** (supabase/013) — replaces the "does this bot have a
  corpus" query that ran before retrieval on every single chat turn with a read
  of a column the bot row already carries. Maintained by a statement-level
  trigger on `chunks`, so a 400-chunk reindex fires it twice rather than 800
  times.

  Deliberately **not** the fold that was proposed for it. Deriving "no corpus"
  from an empty `match_chunks` result would have made `missedRetrieval`
  unreachable — killing `fallback_message`, `escalate_after_misses` and the
  keyword fallback all over again — and would have cost an embedding call per
  turn for bots that have no corpus at all, which is the one case the check
  exists to make free.
- **`scripts/rls/ranking-test.sql`** — the last open housekeeping item. The
  priority boost and the keyword overlap gate had been verified by hand against
  the live database and were covered by no test: it asserts that the boost
  reorders at 0.5 and does *not* at the 0.05 default, that the similarity floor
  tests raw similarity rather than the boosted score, that the overlap gate
  rejects one term in five and accepts four, that an apostrophe a visitor typed
  is a literal rather than a query syntax error, and that `chunk_count` survives
  a delete-then-insert cycle.
- **Retrieval logging, and the report a tenant actually wants** (`retrieval_log`,
  supabase/012) — nothing recorded what visitors asked or whether the bot could
  answer, so every question about this pipeline needed a hand-written SQL query
  against a table that happened to be small. One row per turn now carries the
  query, whether the model was shown anything, which channel found it, the top
  score and the similarity floor that score was tested against — written from
  `waitUntil`, so a visitor's reply never waits on bookkeeping.

  On top of it: **"Questions your bot could not answer"** at the top of
  Knowledge → Retrieval, with counts, last-asked, and an **Add as FAQ** action
  that drops into the editor with the question already typed. The gap between
  seeing the problem and fixing it is where a report like this normally dies.

  **Hits are logged as well as misses**, and that is not padding: a miss-only
  table has rows and no denominator — no miss rate, and no score distribution to
  tune a floor against, which is precisely how a similarity floor that could
  never reject anything survived four months of looking like it worked. Skipped
  turns (a greeting, a disabled bot, a drifted index) are logged not at all,
  because a greeting counted as a miss inflates the number the whole report
  exists to produce.
- **Embedding-model drift is now visible and non-destructive.** Changing a bot
  from one 768-dimension embedder to another passed every check the pipeline
  had — the width assertion, the pgvector column type, Postgres itself — and
  left the stored vectors and the query vector in different embedding spaces,
  where cosine similarity is noise. The bot answered confidently and wrongly,
  permanently, with no error and no dashboard signal.

  `bots.embedding_model_indexed` is stamped by both ingest paths on success, and
  `retrieve()` compares it against the embedder it has just resolved — a string
  compare on a row it already holds, so no extra query. A mismatch skips
  retrieval *before* the embedding call and the turn proceeds on the plain
  prompt. Sources shows **"re-index required"** per document, and offers to
  re-index the lot.

  Two things this had to get right, and both are pinned by tests: **NULL is not
  drift** (every corpus indexed before 012 has no stamp, and reading unknown as
  mismatched would have switched retrieval off platform-wide), and **a stale
  index is not a miss** (otherwise `fallback_message` fires on every turn and
  `escalate_after_misses` escalates every conversation, on a bot that is
  answering fine from its knowledge-base fields).
- **A re-index claim** (`documents.ingest_started_at`). Two clicks, or a click
  landing while a background re-index was still running, interleaved
  delete-then-insert: the loser marked the document `failed` while the winner's
  chunks sat there indexed and working, so the tenant saw a red row on a
  document that was fine and the natural response was to click again.

  `claimDocument` is a single conditional PATCH, so the compare-and-set is one
  UPDATE and atomic. It lives inside `ingestDocument`/`ingestFaq`, so every
  caller inherits it, and the loser throws rather than touching status. A claim
  older than 10 minutes is reclaimable — a Worker can die mid-`waitUntil`, and a
  document nobody can ever re-index is the worse failure. The reindex route also
  answers **409** rather than a `202` for work that will not happen.
- **`GET /v1/admin/bots/:id/retrieval`** — the miss report, and
  **`GET /v1/admin/bots/:id/documents`** now returns the embedding model that
  would run today alongside the list. See [docs/api.md](docs/api.md).
- **One knowledge pipeline** — `bots.services` and `bots.faq` were pasted into
  every system prompt by `buildSystemPrompt` while `documents → chunks →
  match_chunks` ran alongside and never saw them. They are now ingested sources
  like any other, so a tenant who uploads their FAQ as a PDF *and* fills in the
  FAQ box no longer ships it twice. The identity card — name, business,
  description, hours, address, contacts — stays hardcoded, because a bot should
  know its own opening hours without a vector search rolling the dice. Full
  brief: [docs/knowledge-pipeline.md](docs/knowledge-pipeline.md).
- **FAQ items are rows, not a textarea** (`faq_items`) — add, edit, reorder and
  switch off individual questions. Each enabled item is indexed as exactly one
  chunk by a Q&A-aware chunker, and when an answer is too long to fit, **the
  question is repeated into every piece**: the question carries the words a
  visitor actually types, so a fragment without it is a fragment nothing will
  match. A character splitter cannot do that, because it cannot tell which part
  of the text is the question.
- **Two retrieval guarantees for hand-written answers.** FAQ chunks index at
  `priority = 1`, and `match_chunks` adds a configurable boost when *ordering*
  while the similarity floor still tests the raw score — so a boosted chunk wins
  near-ties but can never smuggle an irrelevant one into the prompt. When the
  vector search returns nothing at all, `match_chunks_lexical` matches words
  against the FAQ instead. It runs only on that miss, so it costs nothing on a
  normal message, and it is what catches "do u take insurance" against "Do you
  accept insurance?".
- **`supabase/011_knowledge.sql`** — `faq_items`; `chunks.kind`,
  `chunks.priority`, `chunks.metadata` (specified in the roadmap's Phase 2 and
  never built) and a generated `chunks.search` tsvector with a GIN index;
  `documents.source` gains `'faq'`; `bots.knowledge_migrated_at`. The tsvector
  uses the `'simple'` config, not `'english'` — this platform is explicitly
  multilingual, and an English stemmer applied to Turkish or Amharic is worse
  than no stemmer at all. With these columns in place, hybrid search with
  reciprocal-rank fusion becomes a scoring change rather than another migration.
- **A bounded system prompt, for the first time.** `renderContext` spends a
  `rag_config.context_chars` budget (default 6000) and drops a chunk that does
  not fit whole rather than cutting it; `business_description` and
  `custom_instructions` are capped at 600 and 2000 characters. Both were plain
  unbounded `text` with no limit in the schema, in the Worker or in the UI, so a
  tenant who pasted 40 KB shipped 40 KB on every message, forever. This closes
  the roadmap's "budget the context window" item.
- **"What would this retrieve?"** — `POST /v1/admin/bots/:id/retrieve-preview`
  and a panel on the Retrieval tab. Runs the real retrieval path, fallback and
  all, and reports which channel matched. The chunk inspector answers *what is
  indexed*; this answers *what comes back*, which until now was only visible in
  the Worker's logs.
- **A reversible, per-bot cutover.** `POST /v1/admin/bots/:id/knowledge/migrate`
  parses the legacy FAQ into items, turns services into a document, embeds
  everything **and only then** stamps `knowledge_migrated_at`. A failure
  anywhere before that last step leaves the flag NULL and the bot answering
  exactly as it did before. `…/knowledge/revert` nulls it again. Text that
  parses as no Q/A pair becomes an ordinary document rather than being
  discarded.

### Changed

- **`hnsw.iterative_scan` is set before the vector search** on pgvector 0.8+
  (supabase/013), the second half of the recall mitigation `hnsw.ef_search`
  started. Guarded by an exception block, because setting an unknown parameter
  *errors* and this one does not exist before 0.8 — unguarded it would turn
  every search on an older deployment into a 500. Paired with
  `hnsw.max_scan_tuples` so relaxed ordering cannot degenerate into scanning the
  index. **Still not verified against a large-row fixture**, and documented that
  way.
- **The miss report counts a `hybrid` channel, and pools only vector scores into
  its typical-match median.** That was an allow-list change rather than a
  cosmetic one: the previous test was "not lexical", and under fusion the top
  result of a hybrid turn may be the lexical one — whose score is a text rank,
  not a similarity. It would have gone straight into the one continuous
  measurement the platform has.
- **The RLS fixtures give their chunks a real embedding.** No fixture ever had
  one, so `retrieval-test.sql`'s title-fold assertion would have failed the
  first time anyone ran the RAG block against a Postgres with pgvector — taking
  every later file with it. Those assertions have still never executed, which is
  exactly how it went unnoticed.
- **Ingestion now survives the failure its own header claimed it survived.**
  `embedPieces` looped batches of 32 with no retry and no partial-progress
  record, so one 429 on batch 7 of 13 threw, the catch marked the document
  `failed`, and every batch already embedded was discarded — the next attempt
  starting from zero and failing the same way. It now retries each batch three
  times at 1s/2s/4s, honours the vendor's own `Retry-After` (newly parsed onto
  `ProviderError.retryAfter`) capped at 10s, and **only retries `retryable`
  failures** — a `bad_request` or an `auth` error fails on the first attempt,
  because retrying those burns the `waitUntil` budget to reach the same error
  three times as slowly.

  The constant that matters is the cumulative one: **30 seconds per document**,
  not per batch. Three attempts × ten seconds × thirteen batches is minutes of
  wall clock inside a `waitUntil` that will be killed part-way, which is a
  silent partial failure and strictly worse than the clean one being fixed. On
  exhaustion the error names the batch, so "the vendor is throttling you" reads
  differently from "your document is broken".
- **One fewer round trip on every chat turn with citations on.** Both retrieval
  RPCs now return `document_title` from a join to `documents`, so naming a
  source no longer costs a second query — the fold the citation-alignment fix
  explicitly deferred because it changes the signature of a versioned SQL
  function. `getDocumentTitles` was deleted rather than left as an unused
  export.
- **`hnsw.ef_search` is set before the vector search.** One shared `chunks`
  table, one global HNSW index and a `bot_id` filter applied after the vector
  ordering is a recall trap: once a tenant's slice is large enough that the
  planner prefers the index scan, it walks only `ef_search` candidates
  *globally* and keeps whichever happen to belong to this tenant — fewer than
  `top_k` rows, sometimes zero, for a corpus containing a perfectly good answer.
  Invisible at today's row counts and unpleasant to debug later. `match_chunks`
  became `plpgsql` for this one line; the two-phase over-fetch and re-rank is
  otherwise unchanged.
- **The Retrieval screen stops presenting 0.3 as the minimum-similarity
  default.** There is no platform default any more — the floor is resolved from
  the embedding model that runs the query, and 0.3 is wrong for every bot on the
  platform embedder, whose measured floor is twice that. The field is now an
  optional override that can be cleared, and the effective floor and its
  provenance (`tenant` / `model` / the unmeasured `default`) are shown beneath
  it.
- **One Cron Trigger, deliberately narrow.** `17 3 * * *` prunes `retrieval_log`
  at 90 days and does nothing else. The day count is clamped into `[7, 365]`
  inside the Postgres function rather than in the Worker: the Worker holds a
  service-role key, and this is the one table where a wrong number deletes
  tenant data outright.
- **Three dashboard screens became one.** Knowledge Base, Knowledge Sources and
  Retrieval were split by implementation detail rather than by what a tenant is
  trying to do; they are now the FAQ, Sources and Retrieval tabs of a single
  **Knowledge** screen. `#knowledge`, `#sources` and `#retrieval` all still
  resolve — they select a tab. Business description and custom instructions
  moved to Bot Configuration, with live counters against their new caps.
- **Custom instructions stay in the prompt, deliberately.** They are the one
  knowledge-base field that cannot be ingested: `renderContext` frames
  everything retrieval emits as facts to use and never as orders to follow,
  because ingested pages are attacker-controlled in the general case — so
  instructions routed through retrieval would be ignored by design.
- **A bot whose `knowledge_migrated_at` is NULL produces the pre-011 prompt byte
  for byte**, and `scripts/test-knowledge-units.mjs` compares the two strings
  directly rather than trusting the reading — the convention
  `test-lead-capture.mjs` set.

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

- **A rate-limited visitor was told the bot was broken, and charged twice for
  it.** `/v1/chat/stream` answering 4xx threw a bare `HTTP nnn`, which the widget
  read as a transport failure and quietly replayed on the buffered endpoint —
  where the same preflight said the same thing. So a 429 cost a *second* message
  off `CHAT_LIMITER` and surfaced as "I'm having a moment", never as the "please
  slow down" the server actually wrote. The status now travels with the error;
  only transport failures and 5xx fall back, and 429 is the one status whose
  server copy is shown to the visitor verbatim.

- **A deleted or mistyped bot id mounted a widget that could not work.**
  `fetchConfig` called `r.json()` without checking `r.ok`, and a 404 answers with
  a JSON body that parses perfectly — so the widget kept every default, greeted
  the visitor as "Assistant", and failed on every message. A 404 now unmounts and
  names the id in the console, for the one person who can fix it. A transport
  failure still does not: the defaults are a working widget.

- **Five colours in the widget were light-mode literals.** Inline `code` was
  tinted `#0A0A0C` at 6% and so was invisible on the dark panel; the error bubble
  was a light-pink slab in the middle of it; the scrollbar, typing dots and
  online dot were untokenised, and Firefox painted the *visitor's* system
  scrollbar down a panel the tenant had set to dark. All six now have a pair in
  both palettes, with a note at the top of the block saying why a literal hex
  anywhere below it is a bug.

- **The panel hung off the top of short viewports.** It was sized purely by its
  content — about 564px — and the only media query keyed on width, so a
  landscape phone (844×390) was far too wide to match it and far too short to
  show the panel. It has a `dvh` ceiling now, plus a `max-height` query that
  releases the transcript's flex floor: without that the panel honoured the
  ceiling by clipping the composer instead of shrinking the scroller.

- **The focus ring vanished on older Safari.** The input's focus `box-shadow` was
  a bare `color-mix()`, which is Safari 16.2 — in a file that still carries an
  `addListener` fallback for Safari 13. An unsupporting browser dropped the whole
  declaration and got no ring at all. A neutral ring is declared first now and
  the tinted one overwrites it wherever it parses.

- **Clearing your suggestion chips handed them back.** `renderChips` tested
  `config.suggestions && .length`, so an empty array — a tenant who deliberately
  deleted their chips — fell through to the three built-in defaults. Only `null`,
  the key absent from `/health`, means "never set one".

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
| 0.10.0 | Profile card (book/call/directions/hours); 4xx no longer retried; dark-mode token sweep |
| 0.9.0 | Position, logo, greeting + delay, light/dark/auto, typing toggle, citations |
| 0.8.0 | Panel redesign, specificity fix, self-hosted type, contrast audit |
| 0.7.1 | `window.ConverseKit` public API |
| 0.7.0 | Contrast-aware foreground per tenant colour; gold default |
| 0.6.0 | SSE streaming with buffered fallback |
