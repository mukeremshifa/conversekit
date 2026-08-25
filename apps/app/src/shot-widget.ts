// ----------------------------------------------------------------
// Screenshot harness for the widget itself — the bento money shot.
//
// The dashboard harness (shot.tsx) mounts the real app; this one loads
// the REAL public/widget.js, stubs the three endpoints it talks to, and
// then replays the §5 conversation through the actual composer. The
// visitor's lines are typed into the real input and sent with the real
// button; the replies arrive as real SSE frames over a stubbed
// /v1/chat/stream. Nothing about the panel in the resulting image is
// drawn by this file.
//
// It is a Vite entry rather than a plain HTML file for one reason: it
// can then import the same fixtures the dashboard harness uses, so the
// clinic's name, colour, opening hours and suggestion chips exist once
// instead of twice.
//
// Two things worth knowing about the result:
//
//   * The suggestion chips are GONE from the final frame. widget.js
//     hides them the moment the visitor sends anything, which is what a
//     real visitor sees, so the shot shows that too.
//   * The panel is teal, not gold. That is Fernbrook's brand colour and
//     the whole point of the caption phase F will put under it — the
//     widget takes its colour from the bot.
// ----------------------------------------------------------------
import { BOT_ID, SHOT_NOW_ISO, health, transcript } from '@/fixtures/fernbrook';
import './index.css';

declare global {
  interface Window {
    __ckShotNow?: string;
    __ckShotMisses?: string[];
    __ckShotCrop?: { left: number; top: number; right: number; bottom: number };
    ConverseKit?: { open: () => void; close: () => void; isOpen: () => boolean };
  }
}

window.__ckShotNow = SHOT_NOW_ISO;
window.__ckShotMisses = [];

const params = new URLSearchParams(window.location.search);
const theme = params.get('theme') === 'dark' ? 'dark' : 'light';
document.documentElement.setAttribute('data-theme', theme);

/** The bot's own light/dark setting, which is what the widget reads —
 *  not the OS preference. Pinning it per shot is what makes the pair of
 *  images a real light/dark swap rather than two captures of whatever
 *  the machine happened to be set to. */
const healthPayload = { ...health, widget: { ...health.widget, theme } };

// ── The three stubbed endpoints ──────────────────────────────────
//
// widget.js has no data-api-base here, so it calls its default host.
// Matching on the pathname rather than the full URL keeps that an
// implementation detail of the widget rather than a constant in here.

const SESSION_ID = 'b0700001-0000-4000-8000-00000000c001';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** What the widget would get back if it asked this question for real.
 *  An unscripted message is a bug in the replay, not something to
 *  invent an answer for. */
function replyFor(message: string): string | null {
  return transcript.find((t) => t.ask === message)?.reply ?? null;
}

/**
 * A real SSE body, not a shortcut.
 *
 * The widget's fast path appends a plain delta straight onto the
 * trailing text node and only re-renders markdown when a chunk could
 * change how something already painted parses. Handing it the whole
 * reply as one delta would skip that path entirely — so the reply is
 * cut into word-sized chunks, which is the shape a provider actually
 * streams and the shape the widget is tuned for.
 */
function streamBody(reply: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = reply.match(/\S+\s*/g) ?? [reply];

  return new ReadableStream({
    start(controller) {
      for (const text of chunks) {
        controller.enqueue(encoder.encode(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`));
      }
      controller.enqueue(
        encoder.encode(`event: done\ndata: ${JSON.stringify({ sessionId: SESSION_ID })}\n\n`),
      );
      controller.close();
    },
  });
}

const realFetch = window.fetch.bind(window);

window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const href = typeof input === 'string' ? input
    : input instanceof URL ? input.href
      : input.url;
  const { pathname } = new URL(href, window.location.origin);

  if (pathname === `/v1/bots/${BOT_ID}/health`) return json(healthPayload);

  if (pathname === '/v1/chat' || pathname === '/v1/chat/stream') {
    const body = JSON.parse(String(init?.body ?? '{}')) as { message?: string };
    const reply = replyFor(body.message ?? '');
    if (reply === null) {
      window.__ckShotMisses!.push(`unscripted message: ${body.message}`);
      return new Response(JSON.stringify({ error: 'No fixture' }), { status: 404 });
    }
    if (pathname === '/v1/chat') return json({ reply, sessionId: SESSION_ID });
    return new Response(streamBody(reply), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  if (pathname.startsWith('/v1/')) {
    window.__ckShotMisses!.push(`${init?.method ?? 'GET'} ${pathname}`);
    return new Response(JSON.stringify({ error: 'No fixture' }), { status: 404 });
  }

  return realFetch(input as RequestInfo, init);
}) as typeof window.fetch;

// ── Drive the real widget ────────────────────────────────────────

/**
 * Poll until `read` returns something, or give up loudly. A silent hang
 * here would look exactly like a slow build.
 *
 * performance.now(), NOT Date.now(): scripts/shoot.mjs freezes the wall
 * clock in this page, so a Date-based deadline never arrives and a
 * failed replay would wait forever instead of failing.
 */
function until<T>(what: string, read: () => T | null | undefined, timeoutMs = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const tick = () => {
      const value = read();
      if (value) { resolve(value); return; }
      if (performance.now() - started > timeoutMs) { reject(new Error(`timed out waiting for ${what}`)); return; }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

async function replay() {
  // The tag is created here rather than written into the HTML so Vite
  // never tries to resolve /widget.js out of this project — the file
  // belongs to public/, and the shoot's static server is what joins the
  // two. document.currentScript is still set for a dynamically inserted
  // external script, so the widget reads data-bot-id normally.
  const tag = document.createElement('script');
  tag.src = '/widget.js';
  tag.setAttribute('data-bot-id', BOT_ID);
  document.body.appendChild(tag);

  const shadow = await until('the widget shadow root',
    () => document.getElementById('aicb-root')?.shadowRoot);
  const api = await until('window.ConverseKit', () => window.ConverseKit);
  const panel = await until('the panel', () => shadow.getElementById('aicb-panel'));

  // The same two suppressions the dashboard harness makes, injected
  // inside the shadow root because nothing from the page reaches in:
  // no scrollbar rail down the transcript, no blinking caret in the
  // composer to land at random in the frame.
  const style = document.createElement('style');
  style.textContent = `
    ::-webkit-scrollbar { width: 0; height: 0; }
    * { scrollbar-width: none; caret-color: transparent; }
  `;
  shadow.appendChild(style);

  api.open();

  const messages = await until('the transcript', () => shadow.getElementById('aicb-messages'));
  const input = await until('the composer', () => shadow.getElementById('aicb-input') as HTMLTextAreaElement);
  const send = await until('the send button', () => shadow.getElementById('aicb-send') as HTMLButtonElement);

  // The greeting, the profile card and the chips are one opening turn
  // and they arrive together. Waiting for the card specifically is
  // waiting for the slowest of the three.
  await until('the profile card', () => shadow.getElementById('aicb-card'));

  const lastBotText = () => {
    const bubbles = messages.querySelectorAll('.ck-msg.bot');
    return bubbles.length ? (bubbles[bubbles.length - 1].textContent ?? '') : '';
  };

  for (const { ask, reply } of transcript) {
    input.value = ask;
    // The real listener: it is what enables the send button and resizes
    // the composer, and a click on a disabled button does nothing.
    input.dispatchEvent(new Event('input', { bubbles: true }));
    send.click();
    // The tail rather than the whole string: the bubble renders
    // markdown, so its textContent is the reply's text but not always
    // its exact characters. The last few words only appear once the
    // stream has finished.
    const tail = reply.slice(-24);
    await until(`the reply to "${ask}"`, () => (lastBotText().includes(tail) ? true : null));
  }

  // Scroll pinning is the widget's job during a stream, but the last
  // delta and the final markdown re-render can settle a pixel or two
  // apart. Ending on an explicit bottom makes the framing the same on
  // every run.
  messages.scrollTop = messages.scrollHeight;
  await until('a settled frame', () => (messages.scrollTop >= messages.scrollHeight - messages.clientHeight - 1 ? true : null));

  /* What the shoot should keep, in CSS pixels, as an inset from each
     edge of the viewport.

     The viewport is a desktop one, so the panel is its own 380px rather
     than the full-bleed calc(100vw - 32px) widget.js switches to under
     481px — and it therefore sits in one corner with most of the page
     empty beside it. The frame is the panel, room for its drop shadow
     on the two open sides, and everything out to the corner it is
     anchored in, which is what keeps the launcher bubble in the shot.

     Measured here rather than written into scripts/shoot.mjs because
     the panel's height is its content's, capped by a viewport-derived
     max-height: neither is a constant, and both move the moment the
     scripted conversation changes. */
  const box = panel.getBoundingClientRect();
  const SHADOW_ROOM = 22;
  window.__ckShotCrop = {
    left: Math.max(0, Math.round(box.left - SHADOW_ROOM)),
    top: Math.max(0, Math.round(box.top - SHADOW_ROOM)),
    right: 0,
    bottom: 0,
  };

  document.documentElement.setAttribute('data-shot', 'ready');
}

void replay().catch((err: unknown) => {
  window.__ckShotMisses!.push(String(err));
  document.documentElement.setAttribute('data-shot', 'failed');
});
