# Widget polish

Widget 0.10.0 closed the profile-card gap, the HTTP-status bugs, and the
dark-mode literals. **Widget 0.11.0 shipped everything this document used to
list as remaining, with two exceptions recorded at the bottom.**

Everything below is in `public/widget.js` unless a section says otherwise. Line
numbers move; the anchors are function and selector names.

---

## Shipped in 0.11.0

### Accessibility

- **The closed panel is out of the tab order.** `opacity:0` and
  `pointer-events:none` hide a node from the eye and the mouse but remove it
  from neither the accessibility tree nor sequential focus, so on every page
  carrying the tag a keyboard user tabbed off the last link and into a chat
  textarea and a Send button they could not see. `#aicb-panel` is
  `visibility:hidden` now, `visible` on `.open`, and `visibility` is in the
  transition list so the 0.22s animation is preserved — it flips at the *end* of
  a transition out and the *start* of one in. `display:none` would have killed
  the transition, and `inert` is Safari 15.5+ with no polyfill in this file.

- **`aria-modal` is gone.** It told a screen reader to ignore the rest of the
  page. Nothing traps focus, the host page stays fully usable behind the panel,
  and Escape closes it — the attribute described a widget this is not. A focus
  trap was explicitly *not* the other way to make it true: trapping focus in a
  persistent site widget makes the rest of the page unreachable for as long as
  the panel is open.

- **A streamed reply is announced once.** `#aicb-messages` is a polite live
  region and `append` rewrites the bubble on every delta, so a screen reader
  re-read the reply from the top fifty to a hundred times a message. The
  streaming bubble carries `aria-live="off"` while it fills; `done()` removes it
  and *then* renders, so that last mutation is the one the region reports.

- **Focus is handed back on close.** `closePanel` reads
  `dom.panel.contains(activeNode(dom))` *before* hiding the panel and focuses
  the launcher only if focus was inside — closing from a host page's own button
  via `window.ConverseKit.close()` must not yank focus out of whatever the
  visitor was doing.

- `#aicb-typing` has `role="status"` and a name; the three `.ck-dot` children
  are `aria-hidden`. `#aicb-badge` counts real unread replies instead of reading
  a hardcoded `'1'`, and the count reaches a screen reader through the
  launcher's own `aria-label`, because a button's label overrides anything
  nested inside it.

### Streaming performance

`append` re-rendered the whole accumulated reply and reassigned `innerHTML` on
every delta: O(n²) with full DOM teardown per token, which destroyed any
selection made mid-stream and replaced links under the cursor mid-click.

A delta now goes straight onto the trailing text node when it cannot change how
anything already painted *parses*. The guards are the proof, not caution:

1. no markdown-significant character in the chunk, **and** no `:` or `/` —
   those begin a bare URL, and `visit https:` + `//x.com` has to linkify as one;
2. `raw` does not end in a newline, or the chunk is at the head of a line where
   `- ` would open a list;
3. the bubble ends in a paragraph's own text node (`tailTextNode`), which rules
   out a trailing `<a>` still being typed, and lists.

`rendered` tracks the markup by splicing the escaped chunk in before the closing
`</p>`, and `done()` compares that against a real render and repaints only on a
mismatch — so a drift makes the widget slow, never wrong. The invariant is
asserted in `scripts/test-widget-markdown.mjs` under "Streaming fast path".

`#aicb-messages` also drops `scroll-behavior:smooth` (class `ck-jump`) while a
reply streams: `scrollTop` was assigned every delta and each assignment
restarted the smooth animation from wherever the last had reached, so it never
completed. That was the jitter.

### Shadow DOM

`buildDOM` attaches `root.attachShadow({ mode: 'open' })` and appends the
`<style>` and a `.ck-w` wrapper into it. About sixty selectors lost their
`#aicb-root` prefix.

What the move actually required, beyond the selectors:

- **The boundary stops selectors, not inheritance.** The host element is still
  an ordinary div in the page's DOM, it still matches the page's `*` rule, and
  every inherited property it picks up flows through. `.ck-w` re-declares them —
  `text-transform` and `letter-spacing` alone are two of the three most common
  globals in a CSS framework.
- **`:host` loses to the document on a tie**, by definition, so the host carries
  only inline `!important` geometry (`HOST_STYLE`) and every corner offset lives
  on `.ck-w` instead. `transform`/`filter`/`perspective`/`contain` are pinned to
  their no-op values there: each one would make the host the containing block
  for the fixed-position wrapper inside it.
- **`@font-face` does not cross a shadow boundary in any browser.** The face is
  injected into the document head by `injectFont`. This is the part that fails
  *silently* — a face declared only in the shadow root is never fetched and the
  panel renders in the system stack with nothing in the console.
- `document.activeElement` returns the shadow **host**; `activeNode()` reads
  `root.shadowRoot.activeElement` first.
- Escape still works: `keydown` is composed, so it retargets at the boundary but
  keeps bubbling to the document.
- The two test scripts lift pure functions out of the IIFE by string slicing.
  `test-widget-markdown.mjs`'s anchors survived unchanged;
  `test-widget-theme.mjs`'s end anchor moved to `  function applyColor(` because
  the parameter is now `scope`, which is what it always was.

### Self-hosting and mobile

- **`data-api-base`** is read off the script tag with the old constant as the
  fallback, and validated as an https **origin** — no path, query, or fragment.
  It becomes the prefix of every URL this file fetches, so it is refused rather
  than trimmed into shape. `dashboard/src/screens/Install.tsx` emits it only
  when the dashboard is pointed somewhere other than that default; see the
  remaining work below for why.
- **`visualViewport`** is tracked while the panel is open, and the wrapper's
  `bottom` is offset by the keyboard inset. The base offset is *read from the
  stylesheet* rather than assumed, because it is 24px on desktop and 16px under
  the 480px query. Feature-detected — absent on older Android WebViews. A
  40px threshold keeps a collapsing URL bar from counting as a keyboard.

### Markdown

- **Fenced code blocks** render as `<pre><code>`, escaped by the existing
  escape-first pass and deliberately *not* run through `renderInline` — nothing
  inside a code block is markdown and a URL in a shell snippet is not a link. An
  unterminated fence renders anyway, because that is the normal state mid-stream.
- **Autolinks no longer swallow trailing punctuation.** `see https://x.com/page.`
  used to put the full stop inside the `href`.

### Launcher identity *(not from the original brief)*

The tenant logo went onto the 56px launcher disc as well as into the panel
header. It is header-only now. The launcher is a control, and a visitor reads a
circle in the corner of a page as "chat"; cropped into it a wordmark reads as a
stray avatar instead, and the one affordance the widget has stops looking like a
button. `applyLogo` touches `#aicb-avatar` only, and the copy on the Logo field
in `BotConfiguration.tsx` says so.

---

## Still open

### The API default still points at `workers.dev`

Phase D1 asked for the default to move to the apex domain as well. **Not done,
and deliberately:** there is no apex domain to move it to. `wrangler.toml` has
`workers_dev = true` and no `routes`, so `conversekit.mukeremshifa.workers.dev`
is the only hostname currently serving the API, and repointing the constant
would break every widget already installed.

The order is: add the custom domain to `wrangler.toml`, deploy, confirm it
answers, *then* change `DEFAULT_API_BASE` in `public/widget.js` and
`DEFAULT_API` in `dashboard/src/lib/config.ts` in the same commit. Until then
the `data-api-base` override is the whole of the self-hosting story, which is
the half that actually needed the code.

### `scripts/test-widget-profile.mjs`

Still unwritten. The 0.10.0 profile helpers — `safeHref`, `telHref`, `waHref`,
`mailHref`, `todayKey` — are pure and sit in one contiguous block between
`var DAY_ORDER =` and `function actionLink(`, so the same string-slicing trick
works on them unchanged. They were verified once by hand and are **not** covered
by a committed test. The scheme checks are the security-relevant half: a
`javascript:` booking URL reaching an `href` is exactly the kind of regression a
unit test catches for free.

### Browser checks nobody has run yet

Everything above is covered by `npm run test:widget` and
`npm run test:widget-theme` only as far as pure functions go. These need a real
page:

- Drop the widget on a page with
  `* { font-family: cursive !important; text-transform: uppercase !important }`
  and confirm nothing inside the panel changes — and that it renders in
  Instrument Sans, not the system stack. That second half is the `@font-face`
  injection, and it is the one that fails quietly.
- Tab through a page with the panel closed; focus must never enter it.
- Stream a long reply and confirm a selection made mid-stream survives to the
  end, and that the transcript scrolls without stutter.
- iOS Safari, keyboard open, composer still visible.
