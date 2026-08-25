# The demo bot

The landing page at [`apps/site/assets/index.html`](../apps/site/assets/index.html)
carries a live widget — the same `<script>` tag a tenant pastes into their own site,
served from the same CDN, talking to the same API. It is the product demonstrating
itself, so when it is broken the page is worse than if it had no chat on it at all.

This file explains how that bot exists. **It is not where its content lives** — that
is [`config/demo-bot.js`](../config/demo-bot.js), and editing it there and reseeding
is the supported way to change what the bot knows.

## How it used to work, and why that failed

The instructions here used to be a checklist: create a bot in the dashboard, paste
seven blocks of prose into six different fields, copy the generated uuid into the
landing page by hand, redeploy.

Every step of that was correct and the result still did not survive, because a bot
created by hand exists only in the database. `npm run db:reset` erased it, nothing
replayed it, and the page went on shipping a `data-bot-id` that matched no row in any
database — in fact a uuid that had never matched one, since it was typed rather than
copied. The widget handles that exactly as designed: a 404 from `/health` is
definitive, so it unmounts rather than greeting a visitor whose questions it cannot
answer. The visible symptom was a landing page with no chat on it and a "Try it live"
button that could only ever say "Chat unavailable".

So the bot is now declared in a file and provisioned by a script.

## The three pieces

| | |
|---|---|
| [`config/demo-bot.js`](../config/demo-bot.js) | Its ids, its settings and its whole corpus. The only declaration. |
| [`config/origins.js`](../config/origins.js) | Exports `DEMO_BOT_ID` as the `__CK_DEMO_BOT__` build token. |
| [`scripts/seed-demo-bot.mjs`](../scripts/seed-demo-bot.mjs) | Creates the rows the first file describes. |

The bot id is a **fixed uuid** rather than whatever the database generated, because it
is baked into the landing page at build time. A generated id would mean the page could
only be built after the database was seeded, and would have to be rebuilt after every
reseed. A fixed one makes the two independent — either can run first, and a schema
reset does not invalidate a deployed page.

The landing page carries `data-bot-id="__CK_DEMO_BOT__"`, substituted at build time
like every hostname on the page. That is what makes the id *checkable*:
[`scripts/check-landing.mjs`](../scripts/check-landing.mjs) fails the build on any
`__CK_*__` token that survived substitution, and separately asserts the widget tag
carries a 36-character uuid. Neither check could have caught a hand-typed literal,
which is why the broken one shipped.

## Seeding it

```
npm run seed:demo                 # provision or update
npm run seed:demo -- --dry-run    # say what would change, write nothing
npm run check:demo                # exit non-zero if it is not serving
```

Two credentials in `.env.tools`, alongside the migration token — see
[`.env.tools.example`](../.env.tools.example):

```
CK_DEMO_OWNER_EMAIL=you@example.com
CK_DEMO_OWNER_PASSWORD=<a password you choose>
```

The account is created on the first run and is the dashboard login for the demo bot
afterwards. It is required rather than optional: the knowledge half of the seed goes
through the admin API, and [`src/auth.ts`](../apps/api/src/auth.ts) refuses the
service-role key as a bearer token by design — `role` must be `authenticated` — so
there is no session-free path to it.

The seed writes through **two transports on purpose**. Rows go in as `service_role`
over PostgREST, because the demo bot needs ids the product's own create-bot route
cannot assign. Knowledge goes through the admin API as the signed-in owner, because
chunking, embedding and the FAQ document are the ingest pipeline's job — a seed that
reimplemented them would be a second copy of the pipeline, free to drift from the
first. It also means seeding exercises the same path a tenant does.

It is idempotent. Rows match on the fixed ids, sources on title, FAQ items on question
text; a source whose content has not changed is left alone rather than re-embedded.
Deleting an FAQ entry from `config/demo-bot.js` deletes it from the bot on the next
run, which is what makes that file a description of reality rather than a suggestion.

## After seeding

```
npm run check:landing && npm run deploy:site
```

Only needed when `DEMO_BOT_ID` itself changes, which should be never — the id is baked
into the page, and nothing else the seed writes is.

## The two ways it silently breaks

**The origin.** A bot's `allowed_origins` are compared exactly: scheme, host and port,
no trailing slash, no path. A mismatch is a 403 the widget cannot explain and the
visitor never sees. The seed writes `ORIGINS.site` from `config/origins.js` — the same
switch that writes the hostnames into the page — so the two cannot disagree. This is
also why `--env staging` insists on `CK_ENV=staging` being set: without it the staging
bot would be told to allow the production site.

**An empty corpus.** A bot with no chunks loads, greets, and then knows nothing, which
looks like a working widget and reads as a broken product. `npm run check:demo` asserts
`/health` answers, the site origin is allowed, and `chunk_count` is above zero — the
three ways this can be provisioned and still not work.

## Editing what it says

Change [`config/demo-bot.js`](../config/demo-bot.js) and run `npm run seed:demo`. The
content is split three ways for the reasons in [knowledge.md](knowledge.md):

- **`business_description`** and **`custom_instructions`** are always in the prompt, so
  the bot knows them whatever retrieval returns. Both are capped — 600 and 2000
  characters — because they ship on every single message.
- **`DEMO_SOURCES`** is prose, chunked and embedded by the ordinary pipeline. It is
  prose because that is what it is: continuous text where the useful passage for a
  given question is a paragraph somewhere inside it.
- **`DEMO_FAQ`** is question/answer rows, each indexed on its own, each eligible for the
  near-exact-match shortcut that skips retrieval entirely.

Lead capture is deliberately **off**. This bot exists to demonstrate answering, and a
landing-page widget that asks an evaluator for their phone number before they have
finished reading the page is the fastest way to make the demo feel like a trap. The
feature is described in the FAQ instead.
