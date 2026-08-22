import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// ----------------------------------------------------------------
// Build config for the screenshot harness. Separate from
// vite.config.ts on purpose, and the differences are the whole point:
//
//   outDir     dashboard/.shots-build/ — gitignored, and NOT under
//              public/. The main config writes to public/admin/ with
//              emptyOutDir on, so sharing it would either put a harness
//              in the deploy root or delete the dashboard.
//   base       '/', because scripts/shoot.mjs serves this directory at
//              the server root rather than under /admin/.
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
