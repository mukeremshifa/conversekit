import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
// Plain JS on purpose; see the note in vite.config.ts.
import { ORIGINS, installSrc } from '../../config/origins.js';

// ----------------------------------------------------------------
// Build config for the screenshot harness. Separate from
// vite.config.ts on purpose, and the differences are the whole point:
//
//   outDir     apps/app/.shots-build/ — gitignored, and outside any
//              assets/ or dist/ directory. The main config writes to
//              apps/app/dist with emptyOutDir on, so sharing it would
//              either put a harness in the deploy or delete the
//              dashboard.
//   base       '/', same as the real dashboard, but here because
//              scripts/shoot.mjs serves this directory at the server
//              root.
//   input      the two harness pages only. index.html is not listed, so
//              the real dashboard is never built by this config.
//
// `npm run shots:build`, or `npm run shots:shoot`, which runs it first.
// ----------------------------------------------------------------
export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Must match vite.config.ts: src/lib/config.ts reads these, so a
  // harness built without them fails at load with an undefined global
  // rather than rendering a screenshot with the wrong hostname in it.
  define: {
    __CK_API__: JSON.stringify(ORIGINS.api),
    __CK_CDN__: JSON.stringify(ORIGINS.cdn),
    __CK_SITE__: JSON.stringify(ORIGINS.site),
    __CK_WIDGET_SRC__: JSON.stringify(installSrc()),
  },
  build: {
    outDir: '.shots-build',
    emptyOutDir: true,
    // The harness is loaded once, from localhost, by a browser this
    // repo controls. Readable stack traces when a replay stalls are
    // worth more here than bytes nobody downloads.
    minify: false,
    rollupOptions: {
      input: {
        shot: fileURLToPath(new URL('./shot.html', import.meta.url)),
        widget: fileURLToPath(new URL('./shot-widget.html', import.meta.url)),
      },
    },
  },
});
