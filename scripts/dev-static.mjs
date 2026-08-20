// Dev server for the buildless parts of `public/` — the landing page,
// widget.js and the brand assets.
//
// Deliberately not `wrangler pages dev public`: that reads the root
// wrangler.toml, and the AI binding there forces a remote connection
// (see the comment on [ai]) before it will serve a single byte of
// static HTML. Editing the landing page needs none of that.
//
// No dependencies, for the same reason the landing page has no bundler:
// nothing here is worth a lockfile entry.
//
//   node scripts/dev-static.mjs [dir] [--port N]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const argv = process.argv.slice(2);
const portFlag = argv.indexOf('--port');
const PORT = portFlag === -1 ? 8788 : Number(argv[portFlag + 1]);
const ROOT = path.resolve(argv.find((a) => !a.startsWith('--') && a !== String(PORT)) ?? 'public');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  // Without the font types the browser refuses the file and silently
  // falls back to a system face — the exact failure /_headers exists
  // to prevent in production.
  '.woff2': 'font/woff2',
  '.woff':  'font/woff',
  '.txt':  'text/plain; charset=utf-8',
};

// ── live reload ──────────────────────────────────────────────────────
// The landing page is hand-edited HTML, so a save should show up the
// same way a Vite save does in the dashboard. SSE rather than a
// WebSocket: one-way is all a reload signal needs.
const clients = new Set();

const RELOAD_SNIPPET = `
<script>
  // injected by scripts/dev-static.mjs — not present in the built output
  (function () {
    var es = new EventSource('/__dev/reload');
    es.onmessage = function () { location.reload(); };
    // The server going away closes the stream; retry quietly rather
    // than spraying the console while it restarts.
    es.onerror = function () {};
  })();
</script>`;

let pending = null;
function watch() {
  fs.watch(ROOT, { recursive: true }, (_event, file) => {
    // Editors write a temp file then rename, so one save can fire
    // several events. Debounce, or the page reloads mid-write and
    // renders a half-written document.
    if (file && /(~|\.swp|\.tmp)$/.test(file)) return;
    clearTimeout(pending);
    pending = setTimeout(() => {
      console.log(`  reload  ${file ?? ''}`);
      for (const res of clients) res.write('data: reload\n\n');
    }, 60);
  });
}

// ── request handling ─────────────────────────────────────────────────
function resolveFile(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const target = path.join(ROOT, clean);

  // path.join collapses "..", so compare the result to the root rather
  // than scanning the raw URL for traversal patterns.
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return null;

  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
    const index = path.join(target, 'index.html');
    return fs.existsSync(index) ? index : null;
  }
  return fs.existsSync(target) ? target : null;
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/__dev/reload')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  const file = resolveFile(req.url);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end(`404  ${req.url}`);
  }

  const ext = path.extname(file).toLowerCase();
  const headers = {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    // Never cache in dev. The production rules live in public/_headers.
    'Cache-Control': 'no-store',
    // Mirrors _headers so a locally served widget.js and its fonts
    // behave the same when embedded in a test page on another port.
    'Access-Control-Allow-Origin': '*',
  };

  if (ext === '.html') {
    const html = fs.readFileSync(file, 'utf8');
    const body = html.includes('</body>')
      ? html.replace('</body>', `${RELOAD_SNIPPET}\n</body>`)
      : html + RELOAD_SNIPPET;
    res.writeHead(200, headers);
    return res.end(body);
  }

  res.writeHead(200, headers);
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  watch();
  console.log(`\n  serving  ${ROOT}`);
  console.log(`  landing  http://localhost:${PORT}/`);
  console.log(`  widget   http://localhost:${PORT}/widget.js`);
  console.log(`  live reload on\n`);
});
