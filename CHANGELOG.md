# Changelog

Notable changes to ConverseKit. The widget carries its own version, shown in
`window.ConverseKit.version` and in the banner at the top of `public/widget.js`.

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
| 0.8.0 | Panel redesign, specificity fix, self-hosted type, contrast audit |
| 0.7.1 | `window.ConverseKit` public API |
| 0.7.0 | Contrast-aware foreground per tenant colour; gold default |
| 0.6.0 | SSE streaming with buffered fallback |
