// ----------------------------------------------------------------
// Screenshot harness — a second Vite entry beside main.tsx.
//
// It mounts THE REAL APP. Not a copy of the Shell, not a re-implemented
// Leads table: `<App/>`, with the network replaced underneath it and a
// hash route set from the query string. The moment a shot is allowed to
// diverge from the shipped component it stops being evidence and starts
// being an illustration, and nobody notices the day the two drift.
//
// Everything it takes to make that work is a stub of something the app
// already treats as external:
//
//   ?screen=leads&theme=dark   picks the route and the palette
//   window.fetch               a fixture router keyed on the path
//   localStorage               a session, so SignIn never renders
//
//   npm run shots:build        builds this to dashboard/.shots-build/
//   npm run shots:shoot        builds it, then drives Chrome over it
//
// Nothing here reaches the deployed dashboard: vite.shot.config.ts is a
// separate config with its own entry list and an outDir well outside
// public/.
// ----------------------------------------------------------------
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import {
  BOT_ID, SHOT_NOW_ISO, bot, conversations, documents, embedding, faq, leads, me,
  stats, vendors,
} from '@/fixtures/fernbrook';

/** Read back by scripts/shoot.mjs, which asserts it matches the instant
 *  it froze the page's clock at. A drift between the two is silent
 *  otherwise — the images just quietly start showing a different day. */
declare global {
  interface Window {
    __ckShotNow?: string;
    /** Paths the fixture router did not recognise. The shoot fails on a
     *  non-empty list rather than shipping a screenshot with an error
     *  toast sitting in the corner of it. */
    __ckShotMisses?: string[];
  }
}
window.__ckShotNow = SHOT_NOW_ISO;
window.__ckShotMisses = [];

const params = new URLSearchParams(window.location.search);
const screen = params.get('screen') || 'overview';
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';

// Explicit, never "system": the shot must not depend on what the OS of
// whoever runs it is set to.
document.documentElement.setAttribute('data-theme', theme);

// ── The session ──────────────────────────────────────────────────
// Shaped like lib/auth.ts writes it, and dated far enough out that
// freshToken() hands the token straight back rather than trying to
// refresh it against Supabase.
localStorage.setItem('ck_admin_session', JSON.stringify({
  access_token: 'shot-harness',
  refresh_token: 'shot-harness',
  expires_at: Date.now() + 86_400_000,
  email: me.email,
}));
localStorage.setItem('ck_theme', theme);

// ── The fixture router ───────────────────────────────────────────
//
// Keyed on the path, because that is the whole of the app's API
// surface: lib/api.ts is one `fetch()` behind a table of endpoints, so
// intercepting it replaces the entire backend with no seam anywhere
// above it.

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const B = `/v1/admin/bots/${BOT_ID}`;

/** Exact-path routes, in the order lib/api.ts's `endpoints` map lists
 *  them. A screen that starts calling something new lands in the miss
 *  list below rather than silently rendering an error state. */
const ROUTES: Record<string, () => Response> = {
  '/v1/admin/me': () => json(me),
  '/v1/admin/providers': () => json({ vendors }),
  '/v1/admin/bots': () => json({ bots: [bot] }),
  [B]: () => json(bot),
  [`${B}/stats`]: () => json(stats),
  [`${B}/leads`]: () => json({ leads }),
  [`${B}/documents`]: () => json({ documents, embedding }),
  [`${B}/conversations`]: () => json({ conversations }),
  [`${B}/faq`]: () => json(faq),
};

/** Requests still in flight, and how many have been answered. The
 *  readiness flag below waits on both rather than on a timeout, so a
 *  slow first paint delays the shot instead of cropping half a chart
 *  out of it — and so "nothing has asked for anything yet" is never
 *  mistaken for "everything has arrived". */
let pending = 0;
let served = 0;

const realFetch = window.fetch.bind(window);

window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === 'string' ? input
    : input instanceof URL ? input.href
      : input.url;
  const url = new URL(href, window.location.origin);

  // Anything that is not the API — a Vite asset, a font — goes through
  // untouched.
  if (!url.pathname.startsWith('/v1/')) return realFetch(input as RequestInfo, init);

  const route = ROUTES[url.pathname];
  if (!route) {
    window.__ckShotMisses!.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    return Promise.resolve(new Response(JSON.stringify({ error: 'No fixture' }), { status: 404 }));
  }

  pending++;
  // A macrotask rather than an immediate resolve: an instantly-settled
  // promise lets a screen paint its loaded state inside the same frame
  // as its skeleton, which is not the sequence the real app runs and
  // has hidden a layout bug in a skeleton before now.
  return new Promise<Response>((resolve) => {
    setTimeout(() => {
      pending--;
      served++;
      resolve(route());
    }, 0);
  });
}) as typeof window.fetch;

// ── Harness-only styling ─────────────────────────────────────────
//
// Two things the app is right to do and a screenshot is not. A
// scrollbar on the main column eats fifteen pixels of the shot and
// draws a grey rail down the right of every image; and a caret left
// blinking in a focused input is a coin flip on whether it lands in the
// frame. Nothing here touches layout, so the shot is still the app.
const harnessCss = document.createElement('style');
harnessCss.textContent = `
  ::-webkit-scrollbar { width: 0; height: 0; }
  * { scrollbar-width: none; caret-color: transparent; }
`;
document.head.appendChild(harnessCss);

// ── Readiness ────────────────────────────────────────────────────
//
// `data-shot="ready"` on <html> is the signal scripts/shoot.mjs waits
// for. Every condition below has spoiled a screenshot at some point:
// nothing requested yet (a shot of the spinner), a request still in
// flight (half a skeleton), fonts still resolving (the whole page in
// the fallback face), React not yet flushed (a chart with no path).

function watchReadiness() {
  let quiet = 0;
  const tick = () => {
    const settled = served > 0 && pending === 0 && document.fonts.status === 'loaded';
    quiet = settled ? quiet + 1 : 0;
    // Three consecutive idle frames: one for the fetch to resolve, one
    // for React to commit, one for the browser to lay the result out.
    if (quiet >= 3) {
      document.documentElement.setAttribute('data-shot', 'ready');
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ── Mount ────────────────────────────────────────────────────────
// The hash goes on before render so App's useHashRoute picks the route
// up in its initial state rather than routing once and then again.
window.location.hash = screen;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

watchReadiness();
