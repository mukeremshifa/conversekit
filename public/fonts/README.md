Vendored font subsets — do not edit.

The landing page (`public/index.html`) has no build step, so it cannot resolve
a bare npm import the way the dashboard does. These are copied verbatim from
the dashboard's dependencies:

  bricolage-grotesque-latin.woff2
    @fontsource-variable/bricolage-grotesque/files/bricolage-grotesque-latin-wght-normal.woff2

  instrument-sans-latin.woff2
    @fontsource-variable/instrument-sans/files/instrument-sans-latin-wght-normal.woff2

Latin subset only, weight axis only. Re-copy after bumping either package.
