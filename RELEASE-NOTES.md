ConverseKit is a multi-tenant conversational AI platform. One Cloudflare Worker
serves the API and one Pages site serves the widget and admin dashboard,
together supporting an unlimited number of client bots. Installing it on a
customer site is one `<script>` tag.

The platform was already functional before this release. **v1.0.0 is where it
stopped looking like a work in progress.**

## Highlights

**A real front door.** `public/` had no `index.html` at all, so the site root
served nothing. There is now a landing page at
https://conversekit-widget.pages.dev with the actual widget running on it.

**A visual identity.** A gold and crisp-neutral system, the ConverseKit mark,
and a generated asset set — favicons, Apple touch icon, PWA and maskable icons,
an Open Graph card, and light/dark lockups — all reproducible from
`scripts/gen-brand-assets.mjs`. Bricolage Grotesque and Instrument Sans are
self-hosted across the dashboard, the landing page and the widget.

**A widget worth embedding.** Redesigned panel, and a small public API so a host
page can drive it:

```js
window.ConverseKit.open();
window.ConverseKit.toggle();
window.ConverseKit.isOpen();   // -> boolean
```

**CI.** Type-check, unit tests, dashboard build, and static checks on the
landing page and every documentation link. No secrets required.

## Two bugs worth naming

**Every padding and margin in the widget was being discarded.** The reset
`#aicb-root *{margin:0;padding:0}` carries ID specificity (1,0,0) and outranked
all 25 class-based rules (0,1,0) — so message bubbles, chips, list indents,
paragraph spacing and inline code all computed to `0`. The panel had never
rendered with its intended spacing. The reset has to stay aggressive, since a
host page's own `p{margin:1em 0}` must not leak in, so the rules are now scoped
under `#aicb-root`.

**Contrast was wrong wherever the brand colour met text.** The widget painted
white on whatever `primaryColor` a tenant set, which fails for any light colour;
two icons declared `stroke` on inner elements where a presentation attribute
beats the stylesheet, leaving them at 1.80:1; and the dashboard's focus ring was
heading for 1.75:1. Foreground is now chosen per colour by luminance, and the
accent splits into fill, stroke and text tokens.

Full detail in [CHANGELOG.md](CHANGELOG.md).

## Removed

- `public/test.html`, the Pearl Dental demo site — the landing page now
  demonstrates the widget with a live one.
- The stale root `index.html`, a different product's demo from the first commit.

## Note on licensing

The source is public to read but **not open source**. See
[LICENSE](LICENSE) — no rights to use, deploy or redistribute are granted.
