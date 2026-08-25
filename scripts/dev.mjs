#!/usr/bin/env node
// ----------------------------------------------------------------
// `npm run dev` — the whole product on localhost, in one terminal.
//
// Four processes, one Ctrl-C:
//
//   api    8787   wrangler dev over apps/api
//   app    5173   vite over apps/app
//   site   8788   scripts/dev-static.mjs over apps/site/dist
//   cdn    8789   scripts/dev-static.mjs over apps/cdn/dist
//
// Every child runs with CK_DEV=1, which is what makes this a dev server
// rather than an expensive way to look at production: config/origins.js
// swaps the four deployed hostnames for the four localhost ones above,
// so the dashboard calls YOUR api and the landing page loads YOUR
// widget.js. Without it, a change to widget.js or to a route would show
// up nowhere, because the page would be loading the deployed copy.
//
// The ports are pinned (--port, --strictPort) rather than left to drift
// on a collision: they are written into config/origins.js, and a Vite
// that quietly moved to 5174 would produce a dashboard nothing served.
//
// Subsets are allowed — `npm run dev -- site cdn` when the API is not
// what you are working on. `npm run dev -- --list` names them.
//
// THE ONE THING THIS SHARES WITH THE DEPLOYED STACK is Supabase: there
// is one project, so a bot you create here is a bot that exists. That
// is the deliberate consequence of having one environment.
// ----------------------------------------------------------------
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// `wrangler` and `vite` are .cmd shims on Windows, and since Node 20.12
// spawn refuses to launch a .cmd without a shell. Going straight to each
// package's own JS entry point puts no shell in the path at all, and
// pins the versions in package-lock.json rather than whatever is on
// PATH.
//
// SEARCHED, not path-joined. npm decides per install whether a workspace
// dependency is hoisted to the root node_modules or kept in the
// workspace's own — vite is currently in apps/app/node_modules, wrangler
// at the root — and a hardcoded path is a dev server that stops starting
// after an unrelated `npm install` reshuffles the tree.
//
// `require.resolve` is not the tool here: both packages declare an
// `exports` map, which makes a deep path like `wrangler/bin/wrangler.js`
// unresolvable however present it is on disk.
const TREES = [ROOT, path.join(ROOT, 'apps', 'app'), path.join(ROOT, 'apps', 'api')];

function findBin(subpath) {
  for (const tree of TREES) {
    const candidate = path.join(tree, 'node_modules', subpath);
    if (fs.existsSync(candidate)) return candidate;
  }
  console.error(`\n  Cannot find node_modules/${subpath}. Run \`npm install\` and try again.\n`);
  process.exit(1);
}
const WRANGLER = findBin(path.join('wrangler', 'bin', 'wrangler.js'));
const VITE = findBin(path.join('vite', 'bin', 'vite.js'));

const COLORS = { api: 36, app: 35, site: 33, cdn: 32, build: 90 };
const paint = (name, text) => `\x1b[${COLORS[name] ?? 37}m${text}\x1b[0m`;

// Each server runs from its OWN directory rather than from the repo root
// with a `--config` flag. Vite roots at the working directory, not at the
// directory its config file sits in, so `vite --config apps/app/vite.config.ts`
// from the root serves the root — which has no index.html, and answers 404
// on every request while looking like it started correctly. wrangler is
// given the same treatment for symmetry, and because `.dev.vars` is
// resolved beside the config it loads.
const SERVICES = {
  api: {
    port: 8787,
    cwd: path.join(ROOT, 'apps', 'api'),
    args: [WRANGLER, 'dev', '--port', '8787'],
    // The AI binding has no local simulator, so wrangler proxies it to
    // the edge and the session needs `wrangler login` first. That is the
    // price of the only free 768-dimension embedding source the deployed
    // Worker can also reach — see the note in apps/api/wrangler.jsonc.
    note: 'needs `npx wrangler login` once',
  },
  app: {
    port: 5173,
    cwd: path.join(ROOT, 'apps', 'app'),
    args: [VITE, '--port', '5173', '--strictPort'],
  },
  site: {
    port: 8788,
    cwd: ROOT,
    args: [path.join(ROOT, 'scripts', 'dev-static.mjs'), 'apps/site/dist', '--port', '8788'],
    build: 'site',
    // Sources whose saving makes this target's dist/ stale.
    watch: ['apps/site/assets', 'packages/brand/assets', 'config'],
  },
  cdn: {
    port: 8789,
    cwd: ROOT,
    args: [path.join(ROOT, 'scripts', 'dev-static.mjs'), 'apps/cdn/dist', '--port', '8789'],
    build: 'cdn',
    watch: ['apps/cdn/assets', 'packages/brand/assets', 'config'],
  },
};

// ── arguments ────────────────────────────────────────────────────
const argv = process.argv.slice(2);
if (argv.includes('--list') || argv.includes('--help') || argv.includes('-h')) {
  console.log('\n  npm run dev [-- name ...]\n');
  for (const [name, s] of Object.entries(SERVICES)) {
    console.log(`  ${paint(name, name.padEnd(6))} :${s.port}${s.note ? `   ${s.note}` : ''}`);
  }
  console.log('');
  process.exit(0);
}

const requested = argv.filter((a) => !a.startsWith('-'));
const unknown = requested.filter((n) => !(n in SERVICES));
if (unknown.length) {
  console.error(`\n  Unknown service: ${unknown.join(', ')}. Known: ${Object.keys(SERVICES).join(', ')}\n`);
  process.exit(2);
}
const selected = requested.length ? requested : Object.keys(SERVICES);

// CK_DEV is set here and nowhere else. Every child inherits it, so the
// build subprocesses below resolve the same localhost origins the
// servers do — a dist/ built against deployed hostnames but served from
// localhost is exactly the split this exists to prevent.
const env = { ...process.env, CK_DEV: '1', FORCE_COLOR: '1' };

// ── output ───────────────────────────────────────────────────────
// One prefixed stream per service, so four servers in one terminal stay
// readable. Partial lines are held back rather than printed unprefixed:
// wrangler and vite both write progress without a trailing newline.
function prefixer(name) {
  let held = '';
  return (chunk) => {
    held += chunk.toString();
    const lines = held.split('\n');
    held = lines.pop() ?? '';
    for (const line of lines) console.log(`${paint(name, name.padStart(5))} │ ${line}`);
  };
}

// ── build ────────────────────────────────────────────────────────
// dev-static serves dist/, not assets/, because the sources hold
// `__CK_CDN__`-style tokens rather than hostnames — so dist/ has to
// exist before its server starts, and be rebuilt whenever a source
// changes. dev-static watches dist/ and pushes a reload over SSE, so a
// rebuild IS the reload mechanism.
function build(target) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'scripts', 'build-assets.mjs'), target], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out = prefixer('build');
    p.stdout.on('data', out);
    p.stderr.on('data', out);
    p.on('exit', (code) => resolve(code ?? 0));
  });
}

const children = [];
let shuttingDown = false;

function start(name) {
  const svc = SERVICES[name];
  const child = spawn(process.execPath, svc.args, {
    cwd: svc.cwd, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = prefixer(name);
  child.stdout.on('data', out);
  child.stderr.on('data', out);
  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`${paint(name, name.padStart(5))} │ exited (${code}). The others are still up; Ctrl-C to stop them.`);
  });
  children.push(child);
}

// ── watch ────────────────────────────────────────────────────────
// Debounced: an editor save is several filesystem events, and a rebuild
// per event is a rebuild racing itself into a half-written dist/.
function watch(name, dirs) {
  const target = SERVICES[name].build;
  let timer = null;
  let running = false;
  let again = false;

  const rebuild = async () => {
    if (running) { again = true; return; }
    running = true;
    await build(target);
    running = false;
    if (again) { again = false; rebuild(); }
  };

  for (const dir of dirs) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    fs.watch(abs, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(rebuild, 120);
    });
  }
}

// ── go ───────────────────────────────────────────────────────────
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('');
  for (const c of children) c.kill();
  // Give them a moment to release their ports, then leave regardless — a
  // dev server that will not quit on Ctrl-C is worse than an abrupt one.
  setTimeout(() => process.exit(0), 300).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

for (const name of selected) {
  if (SERVICES[name].build) await build(SERVICES[name].build);
}

console.log('');
for (const name of selected) {
  const svc = SERVICES[name];
  console.log(`  ${paint(name, name.padEnd(6))} http://localhost:${svc.port}${svc.note ? `   ${paint('build', svc.note)}` : ''}`);
}
console.log('');

for (const name of selected) {
  start(name);
  if (SERVICES[name].watch) watch(name, SERVICES[name].watch);
}
