import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
// Plain JS on purpose — see config/origins.d.ts. It is read by Vite, by
// scripts/build-assets.mjs and by the landing-page checks, none of which
// run through tsc.
import { ORIGINS, installSrc, substitute } from '../../config/origins.js';

// Served from its own hostname now (app.conversekit.…), so the base is
// the root rather than /admin/. The dashboard used to share a Pages
// project with the landing page and the widget; splitting them is what
// stopped a marketing copy edit from redeploying customer-facing JS.
export default defineConfig({
  base: '/',
  plugins: [
    react(),
    tailwindcss(),
    // index.html is not JavaScript, so `define` never reaches it. The
    // same token substitution the landing page and widget.js get, so
    // this file can name a hostname the same way they do: not at all.
    {
      name: 'ck-origins',
      transformIndexHtml: (html: string) => substitute(html),
    },
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // The shared brand package, copied verbatim into dist/. Same single
  // copy the landing page and the CDN are built from — favicons and
  // fonts are same-origin here rather than pulled off cdn., so nothing
  // in the dashboard depends on a second host being up.
  publicDir: fileURLToPath(new URL('../../packages/brand/assets', import.meta.url)),
  // The one place hostnames enter the bundle. Everything else reads
  // these through src/lib/config.ts.
  define: {
    __CK_API__: JSON.stringify(ORIGINS.api),
    __CK_CDN__: JSON.stringify(ORIGINS.cdn),
    __CK_SITE__: JSON.stringify(ORIGINS.site),
    __CK_WIDGET_SRC__: JSON.stringify(installSrc()),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
