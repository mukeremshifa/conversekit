Vendored font subsets — do not edit.

The landing page (`apps/site/assets/index.html`) has no bundler, so it cannot
resolve a bare npm import the way the dashboard does. These are copied verbatim from
the dashboard's dependencies:

  instrument-sans-latin.woff2
    @fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2

Latin subset only, weight axis only. Re-copy after bumping the package.

  bricolage-wordmark.woff2

NOT a verbatim copy. Bricolage appears on the landing page in exactly one
place — the `ConverseKit` wordmark in the header and footer — so shipping the
whole 41 KB latin subset to render ten glyphs was the single largest asset on
the page. This is that subset, subsetted again to those ten glyphs:

    python -m fontTools.subset \
        node_modules/@fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2 \
        --text="ConverseKit" --flavor=woff2 --layout-features='*' \
        --output-file=packages/brand/assets/fonts/bricolage-wordmark.woff2

2,704 bytes, and `--layout-features='*'` keeps the `wght` axis alive across the
cut (200–800) — which is what still lets "Converse" render at 700 and "Kit" at
400 out of the one file. Re-run this after bumping the package; do not copy the
full file back in, or the landing page silently regains 38 KB it has no use
for. Keeping the family confined to the wordmark is the other half of keeping
this true — a Bricolage rule anywhere else asks this subset for glyphs it does
not contain, and fails silently.

The dashboard is unaffected either way: it imports the family through
`@fontsource-variable/bricolage-grotesque` in `apps/app/src/index.css` and
never reads this directory.
