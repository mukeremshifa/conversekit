# Landing page redesign — execution plan

The reference is a light-mode SaaS template ("veris"). We take its **structure
and its devices** — the floating header, the orbit, the bento of product shots,
the caption-under-visual rhythm — and nothing else. Colour, type, voice, assets
and content stay ConverseKit's.

Every design decision is settled. This document is written so a session with no
prior context can open it and start building at phase A.

---

## 0. Status

| Phase | Work | Size | State |
|---|---|---|---|
| **A** | Tokens and theme: dashboard palette in, hardcoded dark out, three-state switch, header toggle | half a day | **done** |
| **B** | Typography: Bricolage down to the wordmark subset, Instrument at display size | small | **done** |
| **C** | Sprite pipeline: vendor marks and lucide glyphs inlined, checker extended | small | **done** |
| **D** | Header (floating pill) and hero (eyebrow, headline, description, CTAs, **orbit**) | the design-heaviest day | **done** |
| **E** | Shot harness, fixtures, `shoot.mjs`; fourteen images generated | a day | **done** |
| **F** | Hero shot, bento and workflow tabs wired up with the light/dark swap | half a day | **done** |
| **G** | Providers logo grid, credibility band, closing CTA, footer, card redesign | half a day | **done** |
| **H** | Perf and a11y pass; regenerate `docs/media/landing.png` and the OG image | half a day | **done** |

Phases are independently shippable — the page is never broken between them.
Update the State column as you go; it is the handoff between sessions.

**To start:**

```bash
npm run dev:site         # build + static server on :8788, live reload
npm run check:landing    # sprite freshness + every static check; must pass
npm run check:motion     # drives the page in Chrome: reveals, CLS, reduced motion
```

CI runs `check-landing.mjs` and `check-links.mjs` on every push, so a broken
page fails the build rather than shipping.

### 0.1 What A–E actually landed, where it differs from the plan below

Read this before §1; the rest of the document is the design as specified, and
these are the places the build diverged from it or resolved something it left
open. Nothing here is a deviation from a *decision* — §4 and §8 are intact.

**A — tokens and theme.** The page carries a hand copy of the dashboard's
palette under short local names (`--fg`, not `--color-fg`) because ~700 lines
of existing CSS are written against them; the mapping is annotated one-to-one
per line in the token block, and `apps/app/src/index.css` now says in a
comment that it is the source. Five tokens the dashboard has no equivalent for
were needed to finish de-hardcoding the page and are derived rather than
picked: `--gold-hover` (a `color-mix` of the accent toward the foreground, so
one rule darkens on light and brightens on dark), `--code-tag` / `--code-attr`
/ `--code-str` for the snippet's syntax spans (sourced from `--color-chart-2`,
`--color-accent-ink` and `--color-success`, all already contrast-validated),
`--success` for the "Local" tier badge, `--raised` for inline code chips, and
`--shadow`. Every colour below the token block is now a `var()` or a
`color-mix` of one — there are no literal hex values left in the stylesheet.

Two things work better than the plan described. The selected state of the
theme toggle is driven by `[data-theme]` selectors rather than by a class the
script adds, so the right button is gold on the first frame — the pre-paint
script has already stamped the attribute — and JS only owns `aria-checked`.
And because the toggle overrides the OS, the two `theme-color` tags carry
`data-scheme` and get retargeted (`all` / `not all`) on an explicit choice;
without that, forcing light on a dark OS leaves the address bar black.

**B — typography.** The subset is 2,704 bytes exactly as predicted, the `wght`
axis survives at 200–800, and `packages/brand/assets/fonts/` is now two files totalling 33 KB.
The checker guard that keeps Bricolage confined to the wordmark landed in B
rather than C — a guard that arrives a phase after the constraint it protects
is a phase in which the regression can ship.

**C — sprite.** `scripts/gen-vendor-sprite.mjs` emits 27 symbols (11 vendor
marks + 16 lucide glyphs), 21.7 KB inline. Two things to know before touching
it:

- **The manifest at the top of the script is the source of truth.** Phases G
  and H will want glyphs; add them there and re-run `npm run gen:sprite`,
  rather than hand-inlining a path. The script prints which symbols nothing
  references yet, which is the pruning list for phase H.
- Internal ids are rewritten per symbol (`url(#x)` and `href="#x"` follow).
  Only Gemini ships gradients today and they are already namespaced, but a
  package bump adding a gradient named `a` to two marks would otherwise have
  one icon quietly painting itself in the other's colours.

`node scripts/gen-vendor-sprite.mjs --check` fails if the block is stale;
`npm run check:landing` runs it before the static checks.

**D — header and hero.** The header is a sticky invisible rail with the pill
inside it; the rail carries a gradient so page content does not slide visibly
through the 14px gap above the pill. The Dashboard CTA moved out of
`.nav-links` into a `.nav-right` group beside the toggle, so it has its own
`.nav-cta` rule rather than `.nav-links a.cta`.

The orbit needed one geometric decision the plan did not anticipate: **no
radius that clears the hero copy also fits inside the fold.** The copy occupies
roughly 700×420 centred on the same point (half-diagonal 408px), so the inner
chip ring cannot come in below ~470px; a circle of that radius needs a hero
1000px tall to show whole. So the orbit is deliberately clipped, as the
reference's is, and roughly six of the eleven chips are visible at any moment
while the ring turns. What makes that read as a choice rather than a bug is
two mask layers intersected: a radial one closing the left and right edges,
and a linear one closing top and bottom just inside where the section overflow
would slice them. If `mask-composite` is ever unsupported the layers add
instead of intersecting and the failure is the hard clip, not a blank hero.

The hero grew to `132px 0 148px` of padding to give the orbit that room. The
snippet left the hero as specified, so `copy-hero` and `snippet-hero` are out
of the checker's id list and `wireCopy` is called once.

**Checker.** `scripts/check-landing.mjs` grew from 77 to ~180 lines across the
four phases: theme (pre-paint script present and ahead of the stylesheet, all
three palette blocks, three-state toggle, both `theme-color` tags,
`color-scheme`), sprite (markers present, every `<use>` resolves), orbit (11
vendor marks, 6 `is-outer` slots, every logo on a chip), and typography
(Bricolage declared exactly twice and confined to `.brand .wm`, wordmark subset
loaded). It stays dependency-free and reads only `apps/site/assets/index.html`.

**Two environment notes.**

- Headless Chrome on this machine will not lay out below roughly 500 CSS px:
  `--window-size=390,844` produces a 390px *image* of a ~498px *layout*, which
  looks exactly like a horizontal-overflow bug and is not one. `shoot.mjs`
  sets the viewport through puppeteer's `setViewport` (CDP
  `Emulation.setDeviceMetricsOverride`), which does not have this problem — but
  do not verify a phone-width layout with a bare `--screenshot` and believe
  what you see.
- Verify a scratch copy of the page under `public/__*` (gitignored, and
  `check-deploy.mjs` guards the deploy), never by editing `apps/site/assets/index.html`
  and reverting: `git checkout -- apps/site/assets/index.html` throws away every
  uncommitted phase in one keystroke.

**E — shots.** Fourteen images, 56 files, 1.45 MB on disk, every one inside
the §6 budget with room to spare — the hero is 37 KB AVIF against a 120 KB
ceiling. Run `npm run shots:shoot`; add `--only=<slot>` while iterating,
`--no-build` to skip the Vite step, `--keep-png` to leave the raw captures in
`apps/app/.shots-build/png/`.

The harness mounts **the real `<App/>`**, not a rebuilt Shell. `?screen=` sets
the hash route, `?theme=` stamps `data-theme`, `window.fetch` is replaced by a
fixture router and `localStorage` is seeded with a session so `SignIn` never
renders. That is the whole of the stubbing: `lib/api.ts` is one `fetch()`
behind a table of endpoints, so intercepting it replaces the backend with no
seam above it. The widget harness is the same idea one level down — it loads
the real `apps/cdn/assets/widget.js`, stubs `/health` and `/v1/chat/stream`, and then
*types the visitor's lines into the real composer*, so the panel in the image
is the widget rendering a conversation rather than a mock-up of one.

**Reproducibility took four pins, not one.** Identical input has to produce
identical bytes or every shoot rewrites fourteen content hashes into the diff.
The wall clock is frozen (`SHOT_NOW_ISO`, duplicated in `shoot.mjs` and
`fernbrook.ts` and **checked** — the harness reports its copy back as
`window.__ckShotNow` and the shoot refuses to run if they have drifted); the
timezone is the clinic's own and the locale is `en-US`, because every date on
these screens goes through `toLocaleDateString(undefined, …)`; motion is
`prefers-reduced-motion: reduce`, which the dashboard's stylesheet already
honours by killing every keyframe; and the colour profile is forced to sRGB.
Two runs now produce byte-identical files, verified.

Things the build taught us, in the order they bit:

- **A frozen clock breaks any `Date.now()`-based timeout.** The widget
  harness's `until()` polls on `performance.now()` for exactly this reason —
  with a Date deadline a failed replay hangs forever instead of failing.
- **`data-shot="ready"` is not enough on its own.** The app's `me`/`bots`
  requests settle before a screen has even mounted, so the flag can go up in
  the window between them and the screen's own fetch. Every dashboard slot
  therefore also names `expect`: text that only appears once *that screen's*
  data has landed. Both checks, in that order.
- **Content-hashed siblings need the extension in the prune match.** An AVIF
  and its WebP fallback differ only in hash and suffix, so a prefix-only sweep
  deleted each AVIF as its WebP was written and left half the set on disk.
- **The fixtures have to be ordered the way the API orders them.**
  `/conversations` returns newest-first and `Transcript.orderedForReading`
  reverses it; handing it oldest-first rendered every session backwards, with
  the bot answering before it was asked. Two turns sharing a minute does the
  same thing to one pair of bubbles, so no two turns share one.

Three judgement calls worth knowing about:

- **The suggestion chips are absent from the widget shot.** `widget.js` hides
  them the moment the visitor sends anything — §5 lists them as part of the
  transcript, but a real visitor does not see them at that point, so neither
  does the shot.
- **The Knowledge Base shot is scrolled.** "Add a source" comes first on that
  screen and should: the empty knowledge base is the state that needs the
  affordance. The shot is about the six sources under it, so `shoot.mjs` grew
  a `scrollTo` that brings a named card to the top of the frame. Reordering
  the real screen for a screenshot would have been the tail wagging the dog.
- **The Leads table is clipped at its right edge**, mid-way through the
  "Conversation" action column. 1120px leaves 880px of content and the table
  wants ~1160, so it scrolls inside its card — which is exactly what the app
  does at that width. Widening the slot to ~1200px would fix it at the cost of
  a bento cell that no longer matches the other four. Left as it is; phase F
  should decide whether the crop reads as intent.

`apps/site/assets/shots/manifest.json` ships beside the images: slot, capture size, alt
text, and every file with its width, format and byte count. **Phase F should
build the `<picture>` markup from it** rather than pasting eight hashes per
image into the page by hand. It deliberately carries no timestamp — a
generated file that changes on every run is a file that says nothing in every
diff.

**F — wiring.** The `<picture>` markup is generated, not written:
`scripts/gen-shots.mjs` reads `apps/site/assets/shots/manifest.json` and rewrites a
block per slot between `<!-- generated:shot hero -->` markers, exactly as
the sprite works. Fifty-six content-hashed filenames all change on a
re-shoot; that is not a thing to maintain by hand. It has a `--check`
mode, wired into `npm run check:landing`, and the comparison collapses
whitespace so an editor reformatting the page is not a stale block.

The swap itself is four CSS rules with the same shape as the palette —
`.shot-d` hidden by default, revealed under both
`:root:not([data-theme="light"])` inside the dark media query and
`:root[data-theme="dark"]`. Verified in all six combinations of OS and
toggle (a scratch harness clicked each state and asserted which
`<picture>` computed to `display: block`; five visible shots, all
correct, in every combination — the sixth and seventh live in closed tab
panels).

Three decisions the plan left open:

- **Both hero images load eagerly.** Which one is visible cannot be known
  at parse time when the visitor is on "system", and the hero shot sits
  at the fold. Two eager sources cost 75 KB against a 900 KB viewport
  budget; a wrong guess costs the LCP. Every other pair is lazy, and
  `display: none` keeps the wrong-theme copy unfetched.
- **The toggle warms the other theme on hover.** Lazy hidden images mean
  the first theme toggle would otherwise swap to an empty box.
  `pointerenter` and `focusin` both fire before the click, so
  `warmShots()` sets `loading="eager"` on every shot that is not inside a
  closed tab panel and the bytes are usually there by the time they are
  needed.
- **The Leads crop stays.** Phase E left this for F to decide: in a bento
  cell about 500 px wide the clipped "Conversation" column reads as the
  frame cutting a wide table, which is what it is. Widening the slot
  would cost the bento its matching cell heights.

The checker grew a shots block (both themes present per slot, every
`srcset` file on disk, `width`/`height` on every `<img>`, the three swap
rules) and a tabs block (tablist present, every tab points at a panel,
exactly one selected, exactly one panel open).

**G — the remaining sections.** Section order and numbering are now
01 What it does · 02 How it works · 03 AI providers · 04 Under the hood ·
05 Install. The credibility band carries **both** surviving bodies of
technical detail in two columns — multi-tenant on the left, knowledge
plus the facts strip on the right — which is what keeps `#tenancy` and
`#knowledge` resolvable for the nav and the footer.

- The vendor grid is **two per row inside its column**, not three: at
  three, "Anthropic Claude" wrapped and the tier badge collided with it.
- Cards went from twelve to five, all redesigned per §4.5. **They link
  nowhere.** §4.5 wanted them to link into `docs/`, but `docs/` is not
  deployed and the checker refuses any host other than
  `conversekit-widget.pages.dev`, so there is nothing to link to. The
  copy is short enough to stand alone.
- The stale free-tier claim is fixed: the page now says Gemini Flash Lite
  for chat and Workers AI for embeddings, matching `wrangler.toml`.
  Note that `docs/media/widget.png` still shows the old Groq answer — it
  is a README asset, not part of this page.
- The closing CTA's orbit echo is three rings, no chips, `--line`,
  radially masked. It sits behind the snippet rather than around it.

**H — polish.** Three real defects, found by measuring rather than by
looking:

- **`--faint` fails AA as text.** 3.3:1 on the light ground and 4.1:1 on
  the dark one, against the 4.5:1 normal-text threshold — it had been
  carrying the hero note, the shot caption, the snippet label, the tab
  numbers, the "Paid" badge and the footer credit. All six moved to
  `--muted` (6.5:1 and 7.7:1); `--faint` stays where it was already
  fine, on borders. **No palette value was tuned** — the dashboard is
  still the source; this is only about which token a piece of text asks
  for. Size and weight carry the hierarchy the colour step used to.
  The oversized wordmark is a separate case: at 198 px it is large text,
  so AA asks 3:1, which `--line-strong` missed and `--faint` clears.
- **A heading level was skipped**, h3 → h5, because the provider cards
  sat under a section head with no column label between. Their titles are
  h4; only the band's cards, which do have an h4 column label above them,
  are h5. `h5` joined the checker's tag-balance list.
- **The page scrolled sideways on a phone.** Two independent causes. The
  bento's one-line snippet has a 900 px min-content width, and a grid
  item and a flex item both take `min-width: auto`, so the whole bento
  track sized itself to it — `min-width: 0` on `.tile` and on the
  snippet, plus wrapping the line under 760 px. And the header pill could
  not hold the brand, three links, the toggle and the CTA: the links go
  at 760 px, the brand and CTA shrink at 560 px, and the nav wordmark
  goes at 380 px, leaving the mark. Verified clean at 320, 360, 390, 430,
  560, 720, 768, 1024 and 1440.

The sprite was pruned with the report the generator prints: 28 symbols
down to 22, 22.3 KB to 20.3 KB.

**Lighthouse could not be run** — the npm registry is unreachable from
this machine, so it could not be installed. What replaced it is a
measured audit rather than a claim: every text node in both themes walked
for contrast against its resolved background (all pass AA), heading order
(no skips), accessible names on every link and button (none missing),
duplicate ids (none), and a transfer measurement over a gzipping server.
Initial viewport, nothing scrolled: **251 KB desktop, 190 KB phone**,
against a 900 KB budget.

One number in there is worth knowing: the single largest request on the
page is **47.7 KB for the live widget's bot logo**, pulled from the
production Worker by `widget.js`. It is not a page asset and cannot be
fixed here — it is whatever image is on that bot in the dashboard, and
re-uploading a smaller one is the fix.

**The OG image was deliberately left alone**, against §10's H criterion.
Its headline still says "Drop-in AI chat"; the page says "Drop-in chat".
§4.4 dropped the word because the orbit of vendor logos underneath says
it better — and the OG card has no orbit, so there the word is still
doing the work. §9 also says `gen-brand-assets.mjs` stays untouched.
`docs/media/landing.png` **was** regenerated, in dark, matching the
existing `widget.png` beside it, and the README's alt text now describes
the page that is actually there.

---

## 1. Where the page stood before phase A

Kept as the "before", not as a description of the file today — phases A–D have
landed and §0.1 says what changed. Read it for the constraints, which all still
hold.

[apps/site/assets/index.html](../apps/site/assets/index.html) — one 36 KB file, no build step, dark only.

| Piece | Today |
|---|---|
| Type | Bricolage Grotesque (display) + Instrument Sans (UI) + `ui-monospace` |
| Colour | Dark palette hardcoded into `:root`; a *copy* of the dashboard's dark tokens, not a shared source |
| Theme | `<meta name="color-scheme" content="dark">`. The file states this is a deliberate identity choice, not an omission |
| Sections | Hero (with the snippet inside it) → How it works (3 prose cards) → Providers (12 text tiles + 3 cards) → Knowledge (3 cards + 4 facts) → Multi-tenant (3 cards) → Install → Footer |
| Images | **Zero.** Every section is type on a surface |
| Motion | One entrance stagger in the hero. Nothing else moves |
| Guardrails | [scripts/check-landing.mjs](../scripts/check-landing.mjs) — no external hosts, no CDN imports, balanced tags, unique ids, `alt` on every `<img>`, exactly one `<h1>`, and five hardcoded element ids the inline script depends on |

Constraints that survive the redesign, because they are load-bearing:

- **No build step, no CDN, no external host.** Fonts are vendored into
  `packages/brand/assets/fonts/`; the checker fails on anything remote.
- **`public/` is the deploy root.** [scripts/check-deploy.mjs](../scripts/build-assets.mjs)
  exists because a screenshot harness (`public/__shot.html`) once shipped to
  production. Any harness we build lives outside `public/`.
- **The widget on the page is real.** The bubble bottom-right is `widget.js`
  running against the live ConverseKit bot. That stays, and it is *not* the
  demo tenant in the screenshots — see §5.

The design system already exists and is unusually well specified: see the token
block in [apps/app/src/index.css](../apps/app/src/index.css). It has a
complete light and dark palette, a three-state theme switch (`system` / `light`
/ `dark` via `data-theme` on `<html>`), and documented contrast reasoning for
the gold. The landing page is the only surface not using it.

---

## 2. The template, read as structure

| # | Template section | The device underneath it |
|---|---|---|
| 1 | Header | Floating rounded bar, logo left, nav centre, one dark CTA right |
| 2 | Hero | Centred stack: pill → 5-word headline (2/3 split) → 3-line description → two CTAs. Concentric orbit rings with app icons behind it, faded at the edges |
| 3 | Hero shot | Wide product screenshot in a rounded frame, floating chips overlaid, clipped by the fold |
| 4 | Trust row | "Trusted by teams at…" + grayscale customer logos |
| 5 | "Why creative teams love us" | **Bento** of four product visuals. Caption *below* each: bold 2–3 word title, two muted lines |
| 6 | "Your workflow, streamlined" | Tab bar (4 steps) → one panel, copy left, visual right, "Step 1" chip |
| 7 | "Discover how…" | Horizontal row of illustration cards with an "Explore more ⊕" link |
| 8 | Testimonials | Three columns, one of them a photograph |
| 9 | Integrations | A second, larger orbit |
| 10 | Pricing | Monthly/Yearly toggle, three tiers, middle one emphasised |
| 11 | Closing CTA | Full-bleed gradient panel repeating the hero |
| 12 | Footer | Columns + an oversized wordmark |

The template's own weakness, so we don't inherit it: it uses the orbit **twice**
(2 and 9) and the word "streamlines" twice. One orbit is a signature; two is a
tic.

---

## 3. The mapping

| Template | ConverseKit | Notes |
|---|---|---|
| 1 Header | **Take.** Our mark + wordmark, nav = How it works · Providers · Knowledge · Multi-tenant, CTA = Dashboard, plus the theme toggle | Floating pill instead of the current full-width sticky bar |
| 2 Hero orbit | **Take.** App icons → **AI vendor logos** | The orbit *is* the "eleven vendors, one interface" claim, told as a picture |
| 2 Social-proof pill | **Cut.** → eyebrow: the script tag | We have no users to count and will not invent any |
| 2 Headline | **Rewrite** to five words, two over three, in the UI font | §8 |
| 2 Description + 2 CTAs | **Take** as-is structurally | "Try it live" (opens the real widget) + "Open the dashboard" |
| 3 Hero shot | **Take.** Real Overview screen, light **and** dark | Replaces the code snippet that currently sits in the hero |
| 4 Trust row | **Cut** — no customers to name | |
| 5 Bento | **Take.** "Why small businesses love us" — mobile widget, two dashboard screens, the script tag | The script-tag tile stays *live DOM*, not an image |
| 6 Workflow tabs | **Take** for "How it works" — the three prose steps become three tabs with a real screenshot each | Where the current step cards go to be useful |
| 7 Illustration cards | **Skip.** Needs commissioned art we don't have | Its slot is better spent on the vendor grid |
| 8 Testimonials | **Cut** — nothing real to quote | |
| 9 Second orbit | **Cut.** Providers becomes a dense logo grid with tier badges | Keeps the orbit rare, keeps the vendor list scannable |
| 10 Pricing | **Cut.** No plans exist; `docs/usage-metering.md` Phase 2 is unbuilt | §11 |
| 11 Closing CTA | **Take**, restrained: the install snippet, two CTAs, a faint orbit echo. No gradient wash | Our identity has one chroma; a purple field is not ours |
| 12 Footer | **Take**, including the oversized wordmark | |

Content with no template home that must survive: **Multi-tenant** (RLS, origin
lock, signed sessions) and the **facts strip** (768 / pgvector / HNSW / SSE).
Both become a compact two-column credibility band before the closing CTA — the
only place technical density earns its keep.

**Final section order:**

1. Header (sticky, floating)
2. Hero — orbit, eyebrow, h1, description, two CTAs
3. Hero shot — Overview, light/dark
4. Why small businesses love us — bento of four
5. How it works — three tabs, one shot each
6. Eleven vendors, one interface — logo grid with tier badges + two facts
7. Credibility band — multi-tenant claims + facts strip
8. Install — snippet, two CTAs, faint orbit echo
9. Footer

---

## 4. The decisions

All four open questions are answered. Recorded here with their consequences so
nothing gets relitigated.

### 4.1 Theme-aware, following the OS

The page adopts light and dark and defaults to the visitor's system setting.
This reverses the comment currently in `index.html` ("there is no light palette
here by choice, not omission") — **rewrite that comment to say why it changed;
do not silently delete it.**

What it takes:

- Replace the hardcoded `:root` block with the dashboard's token set — light
  values on bare `:root`, dark under **both** `@media (prefers-color-scheme:
  dark) :root:not([data-theme="light"])` **and** `:root[data-theme="dark"]`.
  Copy the values from `apps/app/src/index.css`; do not invent new ones.
- Same `data-theme` attribute and the same `ck_theme` localStorage key as the
  dashboard, so a visitor's choice carries into `/admin/`.
- A pre-paint inline script in `<head>` — `apps/app/index.html` already has one
  to copy verbatim — so dark users get no white flash.
- Header theme toggle: the dashboard's three-icon `system` / `light` / `dark`
  radiogroup (`Shell.tsx`, `ThemeToggle`), redrawn in plain HTML with inline
  lucide glyphs from the sprite.
- `<meta name="theme-color">` gains a second copy with
  `media="(prefers-color-scheme: dark)"`; `color-scheme` becomes `light dark`.
- **The image swap.** Because the toggle overrides the OS, `<picture>` media
  queries alone are not enough. Use one wrapper holding two `<img>`, one per
  theme, switched by CSS on `[data-theme]` *and* the media query. Both carry
  `alt` (the checker requires it); the hidden one is `loading="lazy"` so it
  usually costs no request. This is the fiddliest mechanism on the page — build
  it once as a documented pattern in phase F and reuse it for all seven shots.

### 4.2 The wordmark keeps Bricolage, from a 2.7 KB subset

Instrument Sans becomes the only text face: headline, sections, captions, nav.
`ui-monospace` appears in exactly two places — the eyebrow and the install
snippet. Bricolage survives **only** in `.brand .wm`, so brand identity across
the dashboard, the OG image and the favicon set is untouched.

The 41 KB objection is solved by subsetting to the ten glyphs the wordmark
needs. Verified with the fontTools already installed on this machine:

```bash
python -m fontTools.subset packages/brand/assets/fonts/bricolage-grotesque-latin.woff2 \
    --text="ConverseKit" --flavor=woff2 --layout-features='*' \
    --output-file=packages/brand/assets/fonts/bricolage-wordmark.woff2
```

**2,704 bytes**, and the `wght` axis survives the cut (200–800) so both the 700
of "Converse" and the 400 of "Kit" still render from the one file. Landing font
payload: **71 KB → 33 KB**.

Add that command to `packages/brand/assets/fonts/README.md` beside the two existing vendoring
notes, or a package bump will quietly restore the full file. Delete
`bricolage-grotesque-latin.woff2` from `packages/brand/assets/fonts/` once the subset is in;
the dashboard uses its own fontsource import and is unaffected.

The `.disp` class and every `font-family: "Bricolage"` rule other than the
wordmark come out, and phase C adds a checker guard that keeps them out.

The `<h1>` therefore has to earn presence from size, weight and tracking rather
than from Bricolage's personality: `clamp(44px, 7.4vw, 84px)`, weight 700,
`letter-spacing: -0.035em`, `line-height: 1.02`.

### 4.3 Screenshots come from a harness

Nobody takes screenshots by hand. §6 has the architecture.

### 4.4 The headline

> **Drop-in chat**
> **for any website.**

Five words, two over three. Continuous with the README and the OG image, and it
drops "AI" from the current line — the orbit of vendor logos directly beneath it
says that better than the word does.

### 4.5 The cards

Twelve prose cards, zero visuals, four to six lines each: documentation voice on
a marketing page. Three moves:

- **Ditch** the three Providers cards (fold into two facts beside the logo grid)
  and one of the three Knowledge cards.
- **Redesign** the survivors: a 20 px lucide glyph in a gold-tinted rounded
  square, a three-to-five word title, and **at most two lines** of copy — about
  a 50% cut to body text. The detail belongs in `docs/`, and the card should
  link there.
- **Promote** the strongest claims out of cards entirely and into the bento,
  where a screenshot does the arguing.

Icon set is lucide, which the dashboard already uses (`lucide-react`), so the
landing and the app share an icon language for free.

### 4.6 The orbit

- Rings: one SVG with three or four concentric circles stroked at `--line`,
  edge-faded with `mask-image: radial-gradient(…)`. SVG rather than bordered
  divs because a 1 px circular border rasterises unevenly at large radii.
- Icons: `transform: rotate(θ) translate(R) rotate(-θ)` per slot, so each sits
  on its ring and stays upright.
- Motion: the ring group rotates once a minute; each icon counter-rotates at the
  same duration so it never tilts. Transform-only — no layout, no paint.
- Reduced motion: the existing global `prefers-reduced-motion` rule already
  kills every animation on the page, so the orbit inherits that for free.
- Mobile: two rings and five icons below 720 px; the outer ring is mostly
  off-screen anyway.
- **Each logo sits on a chip** — `--surface` fill, `--line` border, 12 px
  radius. This is what the template does with its app icons, and it is what lets
  full-colour third-party logos survive on both a light and a dark ground.

---

### 4.7 Motion: what moves, and what it is for

Motion here is product behaviour, not decoration. Every piece of it does one
of four jobs — orient, attract, confirm, transition — and anything that does
none of them is not added.

There are exactly two kinds on the page:

| | What | Job | Runs |
|---|---|---|---|
| **Ambient** | The hero orbit: the ring turns once a minute, each chip counter-turns over the same minute so the logos stay upright | *Attract.* It is the "eleven vendors, one interface" claim told as a picture, and a still ring does not tell it | Forever — the only thing on the page that does |
| **Entrance** | The hero stagger on load (eyebrow → headline → description → CTAs), and a scroll reveal per section block | *Orient.* Marks the arrival of a section so the page reads as a sequence rather than a wall | Once per element, ever |

**The reveal.** 15 targets: the five section heads, the four bento tiles, the
tab row, the vendor grid, the three pillar cards, and the closing CTAs.
`opacity 0 → 1` and `translateY(12px) → 0` over 0.5s, with siblings that cross
the fold together offset by 0.06s each, capped at three steps. Shallower and
quicker than the hero's 14px / 0.62s on purpose: the hero is the page
introducing itself, a section is a section turning up.

An `IntersectionObserver` with a `-12%` bottom inset adds `.is-in`, then
**unobserves that element**. This is the load-bearing detail. The reveal is
one-way — nothing fades back out going up, nothing re-runs coming back down,
and no callback survives the entrance. Without it the page would have grown a
second perpetual animation by accident, which is the thing this policy exists
to prevent.

**Not on the shotband.** The dashboard screenshot under the hero is the page's
LCP candidate, and an element at `opacity: 0` is not an LCP candidate at all.
Revealing it would trade a real metric for an effect nobody had to scroll to
reach. It belongs to the hero's arrival anyway, not to a section's.

**Two escape hatches, both of which fail blank.** Neither fails on the machine
of whoever breaks it, which is why both are tested rather than trusted:

- **Reduced motion.** The global `prefers-reduced-motion` block nulls
  `animation` and `transition`, but that stops the *movement*, not the
  position it starts from — a reveal's resting state is invisible, and those
  two rules cannot undo it. So the block also resets `[data-reveal]` to
  `opacity: 1`. The reveal is switched off at the source: nothing hidden,
  nothing to cross in from, and the class the observer adds becomes a no-op.
- **No JS.** The hidden state is scoped to `.js`, set by a pre-paint script in
  `<head>` — before the stylesheet, so nothing is ever hidden *after* it has
  appeared. No JS means no class means no hidden state, and the page renders
  exactly as it did before reveals existed. An old browser without
  `IntersectionObserver` gets every target revealed at once instead.

#### The acceptance rule

Stated as a property, not a stopwatch: **every animation on this page moves
`opacity` and `transform` and nothing else.** Both composite, so an element
occupies its final box from first paint and crossing in cannot move anything
around it — no layout, no paint, no contribution to CLS. That is a rule about
the source, so it is checked against the source, and it is enforced rather
than remembered:

`npm run check:landing` reads every `@keyframes` block and the reveal's
`transition` and fails on any property that is not `opacity` or `transform`;
it counts `infinite` declarations and fails on a third; and it fails if the
`.js` gate, the pre-paint marker, the reduced-motion override, the
`unobserve`, or the `IntersectionObserver` fallback goes missing. Every one of
those checks was mutation-tested — each rule was broken on purpose and the
checker had to catch it.

`npm run check:motion` drives the real page in Chrome for the half that only
exists at runtime: every reveal actually fires at three viewports (the phone
matters — the observer's inset is a *percentage* of the viewport, so the
elements nearest the end of the document are the ones that can be stranded
behind it), CLS across a full scroll stays under 0.01, reduced motion and
no-JS both leave a fully visible page, and nothing but the orbit is still
running.

**On "no visible jank on low-end mobile".** `check:motion` measures frame
pacing and total blocking time under 4x CPU throttling on a 390x844 phone and
**prints them without asserting on them**. This was measured before it was
decided: across repeated paired runs of this page against the same page with
every `data-reveal` stripped out, the round-to-round spread on a developer
machine swamped the difference between the two — one session showed the
reveals clearly worse in 6 of 6 paired rounds, a later one showed the control
worse. A gate on a number that noisy fails honest work and passes real
regressions. Total blocking time is the figure worth watching, because it is
the one that stayed stable and it is the one the design makes a claim about:
the reveal is meant to cost the compositor, not the main thread, so it should
sit near the same value with the reveals stripped out. On a quiet machine the
page scrolls at p95 16.9ms with 3.3% of frames over 32ms and CLS 0.0000.

## 5. The demo tenant — Fernbrook Veterinary

Every screenshot shows one fictional business, consistent across all fourteen
images. Invented wholesale; approved as synthetic.

> **Note the deliberate contrast:** the live widget in the corner of the landing
> page is the real ConverseKit bot, gold. The widget *inside* the screenshots is
> Fernbrook's, teal. That difference is the point — the widget takes its colour
> from the bot — and the bento caption should say so.

### Identity

| Field | Value |
|---|---|
| Business | Fernbrook Veterinary |
| Assistant name | Fern |
| Industry | Veterinary clinic |
| Tagline | A family veterinary practice on Fernbrook Road. |
| Brand colour | `#0F766E` (teal 700 — white on it is 4.9:1, and it collides with nothing in our palette) |
| Domain | `fernbrookvet.com` — checked, no A record resolves, so it is not a live business |
| Address | 214 Fernbrook Road, Ashfield, OR 97402, US |
| Phone | +1 (555) 0148 |
| Email | hello@fernbrookvet.com |
| Timezone | America/Los_Angeles |
| Bot id (fixtures) | `b0700001-0000-4000-8000-0000000000f1` — synthetic, matches no real row |
| Vendor | Google Gemini `gemini-3.5-flash-lite`; embeddings Workers AI `@cf/baai/bge-base-en-v1.5`, 768 dims — the real platform default, per `wrangler.toml` |
| Allowed origins | `https://fernbrookvet.com`, `https://www.fernbrookvet.com` |

**Conventions that keep the fiction safe and auditable:** phone numbers use the
555-01xx range reserved for fiction; lead surnames are invented compounds
unlikely to belong to anyone; no real business, customer or person appears
anywhere.

### Business profile (shapes: `BusinessProfile` in `apps/app/src/lib/api.ts`)

- **Hours** — Mon–Fri `08:00–12:30` and `13:30–18:30` (two intervals, which
  exercises `HoursInterval[]` and makes the shot more interesting), Sat
  `09:00–13:00`, Sun closed. One exception row: a holiday closure, so the
  exceptions table is not empty.
- **Links** — booking `https://fernbrookvet.com/book`, pricing
  `https://fernbrookvet.com/services`.
- **Policies** — payment methods Visa / Mastercard / cash / pet-insurance direct
  billing; cancellation "24 hours' notice, or the deposit is retained";
  languages English, Spanish.

### Numbers — 30-day window (shape: `Stats`)

Chosen to look healthy and to chart well. **Generate the series
deterministically** — a seeded formula, never `Math.random()` — so re-shooting
produces byte-identical images and the git diff stays clean.

```
totals:     sessions 1284 · visitorMessages 5906 · assistantMessages 5930
            messages 11836 · leads 216 · conversionRate 0.168
            turnsPerSession 4.6
            documents 6 · documentsReady 5 · documentsPending 1
            documentsFailed 0 · chunks 124
previous:   sessions 1043 · messages 9402 · leads 168      (so every delta is up)
```

Series shape, per day over 30 days: a weekday rhythm (weekdays 30–60 sessions,
weekends 12–20), a gentle upward trend across the month, and small deterministic
jitter. `visitor ≈ sessions × 4.6`, `assistant ≈ sessions × 4.62`, `leads ≈
sessions × 0.17` rounded. No flat runs and no single freak spike — both read as
fake at a glance.

**Top questions** (the readable part of the Overview shot):

| Question | Count |
|---|---|
| Do you take walk-ins? | 214 |
| How much is a first visit? | 186 |
| Are you open on Saturday? | 171 |
| Do you see rabbits? | 133 |
| Do you do dental cleanings? | 118 |
| Can I get flea treatment without an appointment? | 97 |
| Do you take pet insurance? | 84 |

### Leads (shape: `Lead`) — ten rows, newest first

| Name | Email | Phone | Inquiry | Age |
|---|---|---|---|---|
| Talia Hallowell | t.hallowell@gmail.com | (555) 0142 | Saturday morning slot for a kitten's first shots | 2h |
| Marcus Brackenbury | marcus.b@outlook.com | (555) 0117 | Second opinion on a limping retriever | 5h |
| Priya Nandakumar | p.nandakumar@gmail.com | (555) 0163 | Do you microchip rabbits? | 1d |
| Dev Okonjo-Reyes | dev.okonjo@icloud.com | — | Boarding over the holidays | 1d |
| Hannah Wexley | hwexley@gmail.com | (555) 0129 | Dental cleaning quote for a 9-year-old cat | 2d |
| Tomás Iriarte | t.iriarte@outlook.com | (555) 0155 | Puppy vaccination schedule | 2d |
| Nell Arboghast | nell.arboghast@gmail.com | (555) 0108 | Flea treatment without an appointment? | 3d |
| Yusuf Demirbaş | y.demirbas@icloud.com | (555) 0171 | Anyone available after 6pm? | 3d |
| Cora Villanueva-Platt | cora.vp@gmail.com | — | Transferring records from another clinic | 4d |
| Bram Osterhout | b.osterhout@outlook.com | (555) 0134 | Senior wellness package pricing | 4d |

Two rows with a null phone are deliberate — the table must show that a lead can
arrive partial.

### Knowledge sources (shape: `Doc`) — six rows, 124 chunks

| Title | Source | Status | Chunks |
|---|---|---|---|
| Services & pricing | `url` — fernbrookvet.com/services | ready | 34 |
| New patient FAQ | `faq` | ready | 22 |
| Vaccination schedules 2026 | `file` — PDF, 284 KB | ready | 41 |
| Boarding & daycare policy | `markdown` | ready | 18 |
| After-hours & emergencies | `text` | ready | 9 |
| Post-op care sheets | `file` — PDF | **processing** | 0 |

The processing row is intentional: it shows the pipeline alive rather than
static. A `failed` row is not — that is a bad look in a marketing shot.

### The widget transcript (the bento money shot)

Scrolled to the bottom on a 390×844 frame, showing roughly the last four
bubbles:

- **Fern:** Hi! I'm Fern. Ask me anything about the clinic — hours, prices, or
  what we can see.
- *(profile card with today's hours; suggestion chips: "Do you see rabbits?" ·
  "First visit cost" · "Saturday hours")*
- **Visitor:** Do you see rabbits?
- **Fern:** Yes — Dr. Amara Osei sees rabbits and guinea pigs, usually Tuesdays
  and Thursdays. A first exam is $65 and covers a dental check, weight and nail
  trim. Shall I take your details so the front desk can call you back with a
  slot?
- **Visitor:** Yes please — Talia Hallowell
- **Fern:** Thanks, Talia. What's the best number or email to reach you on?

One screenshot showing retrieval *and* lead capture *and* the brand colour. Note
that Talia is also the top row of the Leads table — the two shots tell one
story, and someone will notice.

---

## 6. The shot pipeline

Seven raster slots × two themes = **14 images**, AVIF + WebP at two widths.

| Slot | Screen | Size | Why this one |
|---|---|---|---|
| Hero shot | Overview | 1440×900 | Charts and stat tiles read at large size; the prettiest true screen |
| Bento A (tall) | Widget open, phone frame | 390×844 | The product as a visitor sees it |
| Bento B | Leads | 1120×720 | "Captures the lead while it talks" |
| Bento C | Knowledge Base → Sources | 1120×720 | "Feed it what you already have" |
| Bento D (wide) | **The script tag — live DOM, not an image** | — | It themes itself, stays copyable, and is the one honest use of the code font |
| Workflow tab 1 | Business Profile | 1120×720 | "Tell it about the business" |
| Workflow tab 2 | Install | 1120×720 | "Paste one tag" |
| Workflow tab 3 | Conversations | 1120×720 | "It answers, and it listens" |

### Why a harness works here

- The dashboard's API layer is a single `fetch()` in
  [apps/app/src/lib/api.ts](../apps/app/src/lib/api.ts) — trivially stubbed.
- Theme is one attribute on `<html>`.
- Chrome is installed on this machine and headless capture is verified working
  at `--force-device-scale-factor=2`.

### Architecture

`apps/app/src/shot.tsx` — a second Vite entry that:

1. reads `?screen=leads&theme=dark` from the URL;
2. stamps `data-theme` before first paint;
3. replaces `window.fetch` with a fixture router keyed on the request path;
4. seeds `localStorage` with a fake session so `SignIn` never renders;
5. mounts the real `Shell` plus the real screen component — no re-implementation,
   or the shots stop being true.

`apps/app/vite.shot.config.ts` — separate config, **`outDir` outside
`public/`** (`apps/app/.shots-build/`, gitignored). Not `apps/app/dist/`, where
the main config's `emptyOutDir` points. A harness in the deploy root is exactly
the mistake `check-deploy.mjs` was written after.

`apps/app/src/fixtures/fernbrook.ts` — every value in §5, typed against the
real interfaces so a shape change breaks `tsc -b` instead of the screenshots.

Fixture routes to stub, taken from the `endpoints` map:

| Path | Returns |
|---|---|
| `GET /v1/admin/me` | `Me` with one org |
| `GET /v1/admin/bots` | `{ bots: [fernbrook] }` |
| `GET /v1/admin/bots/:id/stats?days=30` | `Stats` (§5) |
| `GET /v1/admin/bots/:id/leads` | `{ leads: [...] }` |
| `GET /v1/admin/bots/:id/documents` | `{ documents: [...], embedding: { vendor, model } }` |
| `GET /v1/admin/bots/:id/conversations` | `{ conversations: Message[] }` |
| `GET /v1/admin/providers` | `{ vendors: Vendor[] }` — Google `keyConfigured: true` |
| `GET /v1/admin/bots/:id/faq` | `FaqResponse` |

The widget shot is its own page: a plain HTML harness that stubs the widget's
three endpoints —`GET /v1/bots/:id/health` (returns `name`, `businessName`,
`primaryColor`, `suggestions`, `profile`, `widget`), `POST /v1/chat` and `POST
/v1/chat/stream` — then loads the real `apps/cdn/assets/widget.js`, opens the panel, and
replays the §5 transcript. It renders inside a 390×844 phone frame drawn in CSS.

`scripts/shoot.mjs` — drives the installed Chrome over CDP with `puppeteer-core`
(no browser download), `deviceScaleFactor: 2`, clips to the app frame, writes
`apps/site/assets/shots/<slot>-<theme>.<hash>.{avif,webp}` at two widths via `sharp`, and
prints a table of the resulting byte sizes so budget regressions are visible.

### Budget

- Hero shot: ≤ 120 KB AVIF at 1440w, ≤ 180 KB WebP fallback. Eager,
  `fetchpriority="high"`.
- Every other shot: ≤ 70 KB each, `loading="lazy"`, explicit `width`/`height` so
  nothing shifts.
- Vendor logos plus lucide glyphs inlined: ~20 KB raw, ~5 KB gzipped.
- **Under 900 KB for the initial viewport, under 1.5 MB total.**

A `/shots/*` rule joins `/fonts/*` and `/brand/*` in `apps/cdn/assets/_headers` —
immutable, one-year cache, since filenames are content-hashed.

---

## 7. Libraries

### Vendor logos: `@lobehub/icons-static-svg`

Verified against the registry and inspected locally, so this is fact rather than
recollection:

- **v1.94.0, MIT, 903 icons**, purpose-built for AI/LLM brands.
- Covers **every** vendor in [apps/api/src/providers/catalog.ts](../apps/api/src/providers/catalog.ts):
  OpenAI, Anthropic / Claude, Google Gemini, Groq, OpenRouter, Mistral,
  DeepSeek, Together AI, Cloudflare (Workers AI), Ollama, LM Studio.
- Three cuts per brand: `name.svg` (mono, `fill="currentColor"`),
  `name-color.svg` (brand colour), `name-text.svg` (lockup with wordmark).
- `viewBox="0 0 24 24"`, `width`/`height` of `1em`, each carrying a `<title>`.
- Eleven colour marks together ≈ 15 KB raw, ~4 KB gzipped.

Rejected: `simple-icons` (patchy AI coverage — no Groq, no LM Studio, no
OpenRouter — and monochrome only); hand-tracing (a week of nobody's time).

**Which cut per vendor:** colour where the mark carries colour that holds on both
grounds (Gemini, Mistral, DeepSeek, OpenRouter, Together, Cloudflare, Claude);
mono plus `currentColor` where the mark is essentially black (OpenAI, Groq,
Ollama, LM Studio) — a black logo on the dark palette is invisible, and this is
the case the mono cut exists for.

Trademark usage is accepted: these appear to say "we integrate with these",
which is ordinary nominative use.

### Card icons: `lucide-static`

v1.33.0, the same glyph set as the dashboard's `lucide-react`. Roughly twelve
glyphs, folded into the same sprite.

### The sprite

There is no build step, so `scripts/gen-vendor-sprite.mjs` reads both packages
and writes an inline `<svg><symbol>` block into `index.html` between generated
markers:

```html
<!-- generated:sprite --> … <!-- /generated:sprite -->
```

Inline rather than an external sprite file, because `currentColor` does not
reliably cross an external `<use>` boundary and the mono marks depend on it. The
script is idempotent and rerunnable; the checker (phase C) verifies the markers
exist and that every `<use href="#…">` resolves to a symbol in the block.

### Build-time dependencies added

All `devDependencies`; none reach the browser.

| Package | For |
|---|---|
| `@lobehub/icons-static-svg` | vendor marks |
| `lucide-static` | card icons |
| `puppeteer-core` | drives the already-installed Chrome |
| `sharp` | PNG → AVIF/WebP at two widths |

`sharp` is the only heavy one. Fallback if it is unwanted: WebP only, via a
Chrome canvas round-trip, at roughly 25% more bytes.

---

## 8. Copy

**Eyebrow** — the pill above the headline, mono, the rare code-font usage:

```
<script src="…/widget.js">
```

**Headline** — five words, two over three:

> **Drop-in chat**
> **for any website.**

**Description** — three lines, muted:

> The AI chat widget for small businesses. It answers from your own documents,
> captures leads while it talks, and installs with one script tag — no plugin,
> no build step, no developer.

**CTAs** — "Try it live" (opens the real widget via `window.ConverseKit.open()`)
and "Open the dashboard".

**Section headings**

- `Why small businesses love us`
- `How it works` → tabs: *Tell it about the business* · *Paste one tag* ·
  *It answers, and it listens*
- `Eleven vendors, one interface` — keep, it is a good line
- `Built for someone running this for other people` — keep, it is the sharpest
  line on the current page

**Bento captions** — bold 2–3 word title, two muted lines each:

| Tile | Title | Line |
|---|---|---|
| A — widget | It looks like yours | The widget takes its colour, name and greeting from the bot. This one is a veterinary clinic's. |
| B — leads | It asks for the number | When a visitor shows intent, it collects a name and a way to reach them, mid-conversation. |
| C — sources | It reads what you have | A services page, an FAQ, a PDF price list. Chunked, embedded, searched at question time. |
| D — snippet | One line, once | Paste it before the closing body tag. Nothing to install, nothing to rebuild. |

**One copy bug, already diagnosed:** the current landing page says "Groq for chat
and Cloudflare Workers AI for embeddings" run the free loop. That is **stale**.
`wrangler.toml` sets `AI_VENDOR = "google"`, `AI_MODEL = "gemini-3.5-flash-lite"`,
`EMBEDDING_VENDOR = "workers-ai"`, and `apps/api/src/providers/index.ts` has
`FALLBACK_VENDOR = 'google'`. The README is the correct one. The rewritten page
says **Gemini Flash Lite for chat and Workers AI for embeddings**, and the demo
tenant in §5 is configured the same way so the shots agree with the prose.

---

## 9. Files that change

| File | Change |
|---|---|
| `apps/site/assets/index.html` | Rewritten. ~2500 lines after H, of which ~150 are the inlined sprite and ~230 the generated shot markup |
| `apps/site/assets/shots/*` | Done in E — 14 images x 2 widths x 2 formats, content-hashed, plus `manifest.json` |
| `packages/brand/assets/fonts/bricolage-wordmark.woff2` | New, 2.7 KB; the 41 KB file is deleted |
| `packages/brand/assets/fonts/README.md` | Add the subsetting command |
| `apps/cdn/assets/_headers` | Done in E: `/shots/*`, immutable, one year |
| `scripts/check-landing.mjs` | **Same commit as the page.** Done in A–D: id list, theme block, sprite markers + `<use>` resolution, orbit shape, Bricolage confinement. Done in F: both themes per shot, every `srcset` file on disk, `width`/`height` on every `<img>`, the three swap rules, tab semantics; the id list gained `copy-bento` / `snippet-bento`. Done in H: `h5` in the tag-balance list |
| `scripts/check-motion.mjs` | **New.** The runtime half of the motion policy in §4.7 — reveals fire at three viewports, CLS budget, reduced motion and no-JS both readable, one perpetual animation. Needs Chrome, like `shoot.mjs`. Throttled-phone frame stats are printed, not asserted; §4.7 says why |
| `scripts/gen-vendor-sprite.mjs` | Done in C. Manifest-driven, idempotent, `--check` mode. Pruned in H to 22 symbols |
| `scripts/gen-shots.mjs` | **New in F.** Reads `manifest.json`, writes a `<picture>` pair per slot between `generated:shot` markers, `--check` mode. Not in the original plan — the alternative was 56 hashed filenames maintained by hand |
| `package.json` | Done in C: `gen:sprite`, `check:landing`; devDeps `@lobehub/icons-static-svg`, `lucide-static`. Done in E: `shots:build`, `shots:shoot`; devDeps `puppeteer-core`, `sharp`. `apps/app/package.json` also gained `build:shots`. Done in F: `gen:shots`, and `check:landing` now runs both generators in `--check` mode first |
| `scripts/shoot.mjs` | Done in E. Builds the harness, serves it beside `public/`, drives Chrome, encodes, prunes old hashes, prints the budget table |
| `apps/app/src/shot.tsx` · `apps/app/src/shot-widget.ts` · `apps/app/shot.html` · `apps/app/shot-widget.html` · `apps/app/vite.shot.config.ts` · `apps/app/src/fixtures/fernbrook.ts` | Done in E — harness, gitignored output |
| `apps/app/src/index.css` | Done in A: values untouched, comment added marking it the source the landing tokens are copied from |
| `.gitignore` | Done in E: `apps/app/.shots-build/` |
| `README.md` | Done in H: `docs/media/landing.png` regenerated in dark at 1640px, and the alt text rewritten — it described a dark hero above the install snippet, and the snippet left the hero in D |
| `scripts/gen-brand-assets.mjs` | Untouched, deliberately, and H left the OG image alone with it — see §0.1 |

---

## 10. Phases, with acceptance criteria

Run `node scripts/check-landing.mjs` after each. Every phase ends with the page
loading correctly at `npm run dev:site`.

**A — Tokens and theme.** ✅ Palette swapped, pre-paint script, three-state
toggle, dual `theme-color`. Verified: renders correctly in light and dark, the
choice persists and shares the `ck_theme` key with `/admin/`, no white flash on
a dark OS, and no literal colour survives below the token block.

**B — Typography.** ✅ Wordmark subset generated (2,704 B, `wght` 200–800
intact), the 41 KB file deleted, `.disp` and every other Bricolage rule gone,
`<h1>` retuned per §4.2. `packages/brand/assets/fonts/` holds two files totalling 33 KB and
the wordmark still renders both weights.

**C — Sprite.** ✅ Both icon devDeps added, `gen-vendor-sprite.mjs` written,
27 symbols inlined. Verified idempotent (byte-identical on a second run) and
the checker fails on a `<use>` pointing at a missing symbol.

**D — Header and hero.** ✅ Floating pill header, orbit, eyebrow, headline,
description, CTAs; the snippet left the hero and the checker's id list follows.
Motion is transform-only on composited layers, freezes under
`prefers-reduced-motion` (verified — the chips hold their static positions,
upright), degrades to two rings and five chips under 720 px, and "Try it live"
is untouched.

**E — Shots.** ✅ Harness, fixtures, `shoot.mjs`, 14 images. Verified: two
consecutive runs produce byte-identical files (every content hash unchanged),
every image is inside the §6 budget — the hero at 37 KB AVIF against a 120 KB
ceiling, the tightest at 63 KB against 70 — and the only thing added to
`public/` is `apps/site/assets/shots/`. The harness builds to `apps/app/.shots-build/`,
which is gitignored and outside the deploy root.

**F — Wiring.** ✅ Hero shot, bento of four, workflow tabs, and the swap
built once in `scripts/gen-shots.mjs` plus four CSS rules. Verified: all six
combinations of OS and toggle show the right theme's copy of every visible
shot; every `<img>` carries its capture `width`/`height`, so the boxes are the
right shape before a byte arrives and nothing shifts; the wrong-theme copy of
the eleven lazy shots is never fetched, and the toggle warms them on hover so
the first swap is not a blank frame.

**G — Remaining sections.** ✅ Providers logo grid with the sprite's vendor
marks and tier badges, two facts beside it, the two-column credibility band,
the closing CTA with its orbit echo, and the footer's oversized wordmark.
Twelve cards became five, none longer than two lines, each with its lucide
glyph. The stale Groq free-tier claim is gone.

**H — Polish.** ✅ Every text node in both themes passes AA; no skipped
heading levels; no unnamed control; no duplicate id; motion stops dead under
`prefers-reduced-motion` (14 running animations to 0, chips upright and in
place); no horizontal overflow at any width from 320px up; sprite pruned to
22 symbols. Initial viewport 251 KB desktop and 190 KB phone against a 900 KB
budget. `docs/media/landing.png` is the new page.

**Lighthouse itself did not run** — the npm registry is unreachable from this
machine, so it could not be installed, and the numbers above are measured
directly instead. The ≥95 / 100 criterion is therefore *unverified by the tool
named in it*, and someone with a network should run it before treating that
line as met.

---

## 11. Settled, cut, and outstanding

**Settled by the user:** theme-aware page following the OS · wordmark keeps
Bricolage · harness screenshots · the headline · a fictional demo tenant of my
choosing with synthetic numbers · vendor trademark usage accepted.

**Cut, and the page is better for it:** a trust/logo row, testimonials, the
illustration cards, the second orbit, and pricing. Every one of them would need
either commissioned art or claims we cannot make truthfully. If a real customer,
quote or price list appears later, testimonials and pricing slot back in as
template sections 8 and 10.

**Assumed unless someone says otherwise:**

- The install URL stays `https://conversekit-widget.pages.dev/widget.js`. If a
  real domain lands before phase H, it is a find-and-replace across the snippet,
  the canonical link and the OG tags — cheap now, a copy pass later.
- No social proof of any kind appears on the page.
- The demo tenant is exactly §5, everywhere, with no second fictional business.

---

## 12. Pass 2 — the tidy-up after A–H

Six small changes made in one pass after the page was up. Recorded here
rather than edited into §§1–11, which are the record of the original plan:
where this section and an earlier one disagree, this one is what shipped.

### 12.1 The theme toggle is gone; the page follows the OS

Cut from the header. A landing page is a visitor's first contact and asking
them to pick a colour scheme before they know what the product is spends a
header slot on a preference they have already expressed to their OS.

What stays, and why it is not dead weight: the pre-paint script, the three
palette blocks, the two `theme-color` tags and the `.shot-l` / `.shot-d`
swap. `/admin/` still writes `ck_theme`, so a visitor who chose dark in the
dashboard still arrives here with `[data-theme]` stamped, and every one of
those mechanisms is what honours it. `check-landing.mjs` now asserts the
toggle markup is *absent* rather than well-formed.

Removed with it: `warmShots()` (§10's "the toggle warms the other theme on
hover" — with no toggle the only thing that can flip the theme mid-visit is
the OS, and the copy that becomes visible is the copy lazy loading fetches),
and the `monitor` / `sun` / `moon` glyphs from the sprite.

Superseded: §0 phase A's "three-state switch, header toggle", §4.1's toggle
paragraphs, §10's warming note, and §10's "the links go at 680" — the nav
now carries five links and hides them at 860.

### 12.2 The nav names the sections, in their order

`Features · How it works · Providers · Specs · Install` → `#why`, `#how`,
`#providers`, `#tenancy`, `#install`, which is sections 01–05 in the order
a reader meets them. Previously three links pointed at 02, 03 and 04 and
skipped the two ends, so the nav read as a sample of the page rather than
its table of contents.

### 12.3 The eyebrow takes the description's ink

`--faint` → `--muted`, the colour `.sub` and `.lede` already use. The
eyebrow belongs to the sentence under it, and at `--faint` it read as a
disabled control sitting on top of the page's loudest type. The comment
above the rule claiming the eyebrow is set in the code face was stale — it
never carried a `font-family` — and has been rewritten to what is true.

### 12.4 A code face that exists on Windows

`--mono`, shared by `.snippet pre` and `.card code`. The old stack was
`ui-monospace, SFMono-Regular, Menlo, monospace` — three Apple faces and a
generic, so Windows fell through to Courier New. Now `ui-monospace, "SF
Mono", SFMono-Regular, "Cascadia Mono", Consolas, "Liberation Mono", Menlo,
monospace`: every platform lands on something drawn for code. Still no
webfont — the face appears twice on the page and neither is worth a request.

### 12.5 The workflow shots sit flat

`.shot.float` loses its `box-shadow`. §02's panel is already a recessed
stage; a drop shadow on the screen sitting on it was the panel wearing two
devices to say one thing. The class keeps its own radius, so it is still
distinct from `.flat`.

### 12.6 The closing section: no second snippet, and a dome

The install snippet appeared three times (hero, bento, §05). The hero's went
in phase E; §05's goes now. It survives once, as the bento's fourth tile,
which is the copyable one. `copy-install` / `snippet-install` are out of the
page and out of `check-landing.mjs`; the deployed-URL assertion still passes
against the bento copy.

In its place the orbit echo becomes a **dome**: the same three radii drawn
as half rings rising off a baseline, with the innermost stroked in gold —
the one place on the page where the brand colour is a line rather than a
fill. Rings only, no chips: the hero spends those once. Two masks do the
edge work, and they are separate on purpose. The arcs take a radial mask
pinned to the baseline's centre, so they are solid where they leave the
ground and gone before any of them reaches an apex or an edge — which is
also what makes the fixed 980px width safe on a narrow screen. The baseline
runs to the flat middle of that mask, where it is still fully opaque, so it
carries its own left-to-right gradient instead and fades to nothing at both
ends. Content is centred inside the dome.

### 12.7 The widget shot is a desktop shot

**The problem.** The bento tile looked padded no matter what width it was
given. The capture was a 390×844 phone viewport, and under 481px `widget.js`
drops the panel to `calc(100vw - 32px)` — so the image was a 358px panel
wearing 16px of page margin down both sides, inside a tile that then had to
leave room for it. `.tile-a .shot` capped it at 330px to stop it out-growing
the two landscape screens beside it, which made it narrow as well as padded.

**The shot.** A 900×575 desktop viewport, where the panel is its own 380px,
cropped to the panel's box plus room for its drop shadow and out to the
corner it is anchored in — so the launcher bubble stays in frame. Delivered
426×575 at `scale: 3`, filling the bento column at 512px instead of 330.
`.tile-a .shot` loses its `max-width`.

**Two mechanisms this needed:**

- `cropFromPage` on a slot. The frame is the panel's box, and only the
  harness can measure it: the panel's height is its content's, capped by a
  viewport-derived max-height, and neither number is a constant. The
  harness reports `window.__ckShotCrop` and `shoot.mjs` reads it. The two
  themes must agree — the manifest carries one size per slot — so the second
  capture checks the first rather than overwriting it.
- `scale` on a slot. The crop keeps 426 of 900 CSS pixels, and at the shared
  2× that is not enough to serve the tile's display width twice over. The
  widget slot is the only one that buys 3×.

**Where the fold lands.** The replay ends scrolled to the bottom and the
conversation is ~549px of content, so the viewport height decides what the
panel header crops through — something is always above the fold. 575 puts it
in the 8px gap between the business-profile card and the visitor's first
question: the card scrolls out whole and the exchange below starts clean,
four pixels down. Folding *above* the card instead would need a transcript
~440px tall, and `widget.js` caps that at 420 once the viewport passes 700px
high, so the window for it does not exist. Off by twenty either way and the
shot slices a line of the clinic's address in half, which reads as a broken
render rather than as a scrolled chat.

**Consequences.** §5's transcript reply is shortened, and the same shortening
is applied to `turn(1, 'assistant', …)` so the Conversations screen and the
widget still show the same words — they are the same turn. The tile caption
said the widget takes its "colour, name and greeting" from the bot; the
greeting is above the fold, so it now says "colour, name and avatar", all
three of which are in the panel header. The `alt` text no longer says
"on a phone".

Superseded: §6's `--window-size=390,844` note and §5's transcript text.
