/*!
 * ConverseKit Chat Widget v0.11.0
 * Drop-in AI chatbot for any website.
 * Usage: <script src="widget.js" data-bot-id="YOUR_BOT_ID" defer></script>
 *
 * Renders into a SHADOW ROOT: no host-page rule reaches inside it.
 *
 * Streams replies over SSE, falling back to the buffered /v1/chat
 * endpoint on a TRANSPORT failure. A 4xx is the server's considered
 * answer and is never retried.
 *
 * Once loaded it exposes window.ConverseKit:
 *   open() close() toggle() isOpen() -> boolean
 *   botId  version
 * so a host page can drive the panel from its own button.
 */
(function () {
  'use strict';

  var WIDGET_VERSION = '0.11.0';

  /* Two copies of the tag would mount two panels and leave
     window.ConverseKit pointing at whichever booted last. */
  if (window.ConverseKit) {
    console.warn('[ConverseKit] Already loaded; ignoring duplicate script tag.');
    return;
  }

  // ── Bootstrap ─────────────────────────────────────────────────
  var scriptTag = document.currentScript ||
    (function () {
      var s = document.getElementsByTagName('script');
      return s[s.length - 1];
    })();

  var botId = scriptTag && scriptTag.getAttribute('data-bot-id');
  if (!botId) { console.warn('[ConverseKit] No data-bot-id found.'); return; }

  /* Where our own assets live. Read from the script's own src rather than
     hard-coded, so a tenant who self-hosts widget.js serves the font from
     their copy instead of reaching back to our Pages project. */
  var ASSET_BASE = (function () {
    try { return new URL('.', scriptTag.src).href.replace(/\/$/, ''); }
    catch (e) { return 'https://conversekit-widget.pages.dev'; }
  })();

  /* Where the API lives. Overridable for the same reason ASSET_BASE is
     derived from the script's own src: a self-hosted copy of this file
     is a supported deployment, and without this every message sent from
     one still calls home.

     ORIGIN-ONLY, AND https. The value becomes the prefix of every URL
     this file fetches, so a path on it, a query, or a scheme that is not
     https is refused rather than trimmed into shape — a deployment knob
     that silently half-works is worse than one that visibly falls back.
     Precedent for the override: VITE_API_BASE in
     dashboard/src/lib/config.ts. */
  var DEFAULT_API_BASE = 'https://conversekit.mukeremshifa.workers.dev';

  var API_BASE = (function () {
    var raw = scriptTag && scriptTag.getAttribute('data-api-base');
    if (!raw) return DEFAULT_API_BASE;
    try {
      var u = new URL(String(raw).trim());
      if (u.protocol === 'https:' && u.pathname === '/' && !u.search && !u.hash) return u.origin;
    } catch (e) { /* not a URL at all */ }
    console.warn('[ConverseKit] Ignoring data-api-base "' + raw +
      '" - expected an https origin with no path.');
    return DEFAULT_API_BASE;
  })();

  /* Session ids are issued and signed by the server. The widget never
     invents one: a client-generated id could be guessed or replayed to
     read another visitor's transcript. Sending none on the first
     message makes the server mint one, which we then carry. */
  var SESSION_KEY = 'ck_session_' + botId;
  var sessionId   = sessionStorage.getItem(SESSION_KEY) || null;

  function rememberSession(id) {
    if (!id || id === sessionId) return;
    sessionId = id;
    try { sessionStorage.setItem(SESSION_KEY, id); } catch (e) { /* private mode */ }
  }

  // ── State ─────────────────────────────────────────────────────
  /* Defaults live HERE, not in the Worker. /health sends only the keys
     a tenant actually set, so this object is the single description of
     what an unconfigured bot looks like — and a widget served from a
     tenant's own copy keeps behaving as it did when they copied it,
     whatever fields the API learns later. */
  var config = {
    name: 'Assistant',
    businessName: null,
    contact: null,
    primaryColor: '#EEBA2B',
    suggestions: null,
    position: 'bottom-right',
    theme: 'light',
    logoUrl: null,
    greeting: null,          // null → the built-in line, which needs config.name
    greetingDelayMs: 0,
    showTyping: true,
    showCitations: false,
    /* The public business card from /health (supabase/015). Null until a
       tenant fills in a Business Profile, which is every bot until it is
       backfilled — so every consumer of this treats null as "no card". */
    profile: null
  };
  var isOpen   = false;
  var isTyping = false;


  // ── Colour ────────────────────────────────────────────────────
  /* A tenant picks primaryColor and the widget paints text on it.
     Painting white unconditionally breaks for any light brand colour —
     white on the ConverseKit gold scores 1.80:1 — so the foreground is
     chosen per colour, and brand-coloured text that sits on the white
     panel is dimmed along its OWN hue rather than swapped for a neutral,
     so it still reads as the brand. */
  var INK = '#0A0A0C';

  function hexToRgb(hex) {
    var h = String(hex || '').trim().replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }

  function luminance(rgb) {
    var v = rgb.map(function (c) {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  }

  function ratio(a, b) {
    var hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }

  function rgbToHsl(rgb) {
    var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var l = (mx + mn) / 2;
    var s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    var h = 0;
    if (d) {
      if (mx === r) h = 60 * (((g - b) / d) % 6);
      else if (mx === g) h = 60 * ((b - r) / d + 2);
      else h = 60 * ((r - g) / d + 4);
    }
    return [(h + 360) % 360, s, l];
  }

  function hslToRgb(h, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs((h / 60) % 2 - 1));
    var m = l - c / 2, t;
    if (h < 60) t = [c, x, 0];
    else if (h < 120) t = [x, c, 0];
    else if (h < 180) t = [0, c, x];
    else if (h < 240) t = [0, x, c];
    else if (h < 300) t = [x, 0, c];
    else t = [c, 0, x];
    return t.map(function (v) { return Math.round((v + m) * 255); });
  }

  function toHex(rgb) {
    return '#' + rgb.map(function (v) {
      return ('0' + Math.max(0, Math.min(255, v)).toString(16)).slice(-2);
    }).join('');
  }

  /** Ink or white — whichever is more readable on the given colour. */
  function onColor(hex) {
    var rgb = hexToRgb(hex);
    if (!rgb) return '#ffffff';
    var l = luminance(rgb);
    return ratio(l, luminance(hexToRgb(INK))) >= ratio(l, 1) ? INK : '#ffffff';
  }

  /* Relative luminance of each theme's panel. --ck-surface is #FFFFFF
     in light and #141417 in dark; these are those two values, and they
     are what inkVariant searches against. */
  var SURFACE_LUM = { light: 1, dark: luminance([0x14, 0x14, 0x17]) };

  /** Same hue and saturation, walked AWAY from the surface until it
      clears 4.5:1 against it. Returns the colour itself when it already
      does.

      The surface argument is not decoration. This function used to walk
      only downward, because the panel was always white — run that
      search against a dark panel and it happily returns near-black text
      on a near-black background, which is the one way dark mode here is
      more than swapping a palette. */
  function inkVariant(hex, surfaceLum) {
    var away = surfaceLum > 0.5 ? '#0A0A0C' : '#FFFFFF';
    var rgb = hexToRgb(hex);
    if (!rgb) return away;
    if (ratio(luminance(rgb), surfaceLum) >= 4.5) return hex;

    var hsl = rgbToHsl(rgb);
    var darker = surfaceLum > 0.5;
    for (var i = 1; i <= 100; i++) {
      var l = darker ? hsl[2] - i * 0.01 : hsl[2] + i * 0.01;
      if (l <= 0.03 || l >= 0.99) break;
      var candidate = hslToRgb(hsl[0], hsl[1], l);
      if (ratio(luminance(candidate), surfaceLum) >= 4.5) return toHex(candidate);
    }
    /* A fully saturated hue can run out of room before it clears 4.5:1
       — pure yellow on white never does. Fall back to the neutral that
       does rather than returning something unreadable. */
    return away;
  }

  /* `scope` is the wrapper INSIDE the shadow root, never the host
     element. A custom property set on the host is one `#aicb-root{}` rule
     on the page away from being overwritten, and every colour below
     resolves through these three. */
  function applyColor(scope) {
    scope.style.setProperty('--ck-color', config.primaryColor);
    scope.style.setProperty('--ck-on-color', onColor(config.primaryColor));
    scope.style.setProperty('--ck-color-ink', inkVariant(config.primaryColor, SURFACE_LUM[resolvedTheme()]));
  }

  // ── Theme ─────────────────────────────────────────────────────
  /* Three states, matching the dashboard's: an explicit light or dark,
     and "auto", which follows the visitor's OS and keeps following it
     if that changes while the panel is open.

     Resolved in JS rather than by a bare prefers-color-scheme media
     query, because a bot set to "light" must stay light for a visitor
     whose OS is dark — a media query alone cannot express that. */
  function prefersDark() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
    catch (e) { return false; }
  }

  function resolvedTheme() {
    if (config.theme === 'dark') return 'dark';
    if (config.theme === 'auto') return prefersDark() ? 'dark' : 'light';
    return 'light';
  }

  function applyTheme(scope) {
    if (resolvedTheme() === 'dark') scope.classList.add('ck-dark');
    else scope.classList.remove('ck-dark');
    /* --ck-color-ink is contrast-derived, so it has to be recomputed
       against the new surface, not just re-declared. */
    applyColor(scope);
  }

  function watchSystemTheme(scope) {
    if (!window.matchMedia) return;
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () { if (config.theme === 'auto') applyTheme(scope); };
    /* addListener is the Safari < 14 spelling; it is deprecated, not
       absent, and this widget still runs on old iOS. */
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }

  // ── Styles ────────────────────────────────────────────────────
  /*
   * Everything below is injected into the SHADOW ROOT, so none of these
   * selectors can reach the host page and none of the host page's can
   * reach them. That is the whole reason the widget moved behind a
   * shadow boundary in 0.11.0: the old three-property reset lost to any
   * host rule carrying !important, and `46a9488 restore spacing killed
   * by reset specificity` was the warning shot. There is no amount of
   * specificity that beats a host page's `* { font-family: X !important }`.
   *
   * What the boundary does NOT stop is INHERITANCE. The host element is
   * still an ordinary div in the page's DOM, it still matches the page's
   * `*` rule, and every inherited property it picks up flows straight
   * through into here. `.ck-w` below is where that stops — see the
   * comment on it.
   */

  /* Injected into the DOCUMENT head, not into the shadow root.
     @font-face is resolved against the document that declares it and
     does NOT cross a shadow boundary in any browser, so a copy in here
     alone leaves the panel silently rendering in the system stack.
     Safe to put in the page: a rule with no selector matches nothing. */
  var FONT_CSS = '@font-face{font-family:"ck-sans";src:url("' + ASSET_BASE + '/fonts/instrument-sans-latin.woff2") format("woff2");font-weight:400 700;font-style:normal;font-display:swap;}';

  var FONT_STACK = '"ck-sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';

  var CSS = [
    /* Present here too, harmlessly: a browser that ever does honour a
       shadow-scoped face gets it, and the declaration documents which
       family the stack below is naming. */
    FONT_CSS,

    /* EVERY colour in this file belongs in one of these two blocks.
       A literal hex further down is a light-mode assumption that dark
       mode will not catch — `code` chips were tinted #0A0A0C at 6% and
       were simply invisible on the dark panel, and the error bubble was
       a light-pink slab in the middle of it. If a new rule needs a
       colour, add the pair here first. */
    '.ck-w{--ck-ink:#0A0A0C;--ck-muted:#5B5B66;--ck-faint:#6E6E78;--ck-line:#E8E8EC;--ck-surface:#FFFFFF;--ck-sunk:#FAFAFA;--ck-chip:#F2F2F4;--ck-shadow:rgba(10,10,12,.28);--ck-code:rgba(10,10,12,.06);--ck-scroll:#D6D6DC;--ck-dots:#C4C4CC;--ck-online:#157347;--ck-err-bg:#FEF3F2;--ck-err-ink:#B42318;--ck-err-line:#FDA29B;}',
    /* Dark. Applied by class, never by a bare media query: a bot set to
       "light" has to stay light for a visitor whose OS is dark, and only
       JS knows which of the three settings is in play. Values mirror the
       dashboard's dark tokens so the two products look related. */
    '.ck-w.ck-dark{--ck-ink:#F7F7F8;--ck-muted:#A1A1AC;--ck-faint:#71717B;--ck-line:#26262C;--ck-surface:#141417;--ck-sunk:#08080A;--ck-chip:#1E1E23;--ck-shadow:rgba(0,0,0,.55);--ck-code:rgba(255,255,255,.10);--ck-scroll:#33333C;--ck-dots:#4A4A54;--ck-online:#3FB950;--ck-err-bg:#2A1614;--ck-err-ink:#FDA29B;--ck-err-line:#5C2620;}',
    '.ck-w *,.ck-w *::before,.ck-w *::after{box-sizing:border-box;margin:0;padding:0;}',

    /* THE INHERITANCE FIREWALL, and the widget's layout root.
       .ck-w is the outermost node inside the shadow tree, which makes it
       the first node no host selector can name — so every inherited
       property is re-declared here rather than left at whatever the page
       set on the host div. The list is not padding: text-transform and
       letter-spacing alone are two of the three most common globals in a
       CSS framework, and a widget rendered in ALL CAPS is a bug report.

       Positioning lives here too, not on the host, for the same reason:
       :host declarations lose to the document's own rules on a tie, so
       the host carries only inline !important geometry (see HOST_STYLE)
       and the real corner offsets sit safely in here. */
    '.ck-w{position:fixed;bottom:24px;right:24px;font-family:' + FONT_STACK + ';font-size:15px;line-height:1.5;font-weight:460;font-style:normal;font-variant:normal;letter-spacing:normal;word-spacing:normal;text-transform:none;text-align:left;text-indent:0;text-shadow:none;white-space:normal;word-break:normal;color:var(--ck-ink);direction:ltr;cursor:auto;visibility:visible;pointer-events:auto;-webkit-font-smoothing:antialiased;}',

    /* Launcher */
    '#aicb-bubble{width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;background:var(--ck-color);box-shadow:0 6px 24px -6px var(--ck-shadow);transition:transform .2s ease,box-shadow .2s ease;outline:none;position:relative;padding:0;font-family:inherit;}',
    '#aicb-bubble:hover{transform:scale(1.06);box-shadow:0 10px 30px -8px var(--ck-shadow);}',
    '#aicb-bubble:focus-visible{outline:3px solid var(--ck-color-ink);outline-offset:3px;}',
    '#aicb-bubble-icon{transition:opacity .15s,transform .15s;display:flex;}',
    '#aicb-bubble-icon svg{width:26px;height:26px;fill:none;stroke:var(--ck-on-color);stroke-width:2;stroke-linecap:round;stroke-linejoin:round;display:block;}',
    '#aicb-bubble-close{position:absolute;opacity:0;transform:scale(.7) rotate(-90deg);transition:opacity .15s,transform .15s;display:flex;}',
    '#aicb-bubble-close svg{width:20px;height:20px;display:block;fill:none;stroke:var(--ck-on-color);stroke-width:2.5;stroke-linecap:round;}',
    '.ck-w.is-open #aicb-bubble-icon{opacity:0;transform:scale(.7) rotate(90deg);}',
    '.ck-w.is-open #aicb-bubble-close{opacity:1;transform:scale(1) rotate(0);}',

    /* Unread badge. aria-hidden — the count it shows is spoken through
       the launcher's own aria-label instead, because a button's label
       overrides its contents and a number nested inside one is silent. */
    '#aicb-badge{position:absolute;top:-1px;right:-1px;min-width:19px;height:19px;border-radius:10px;background:#B42318;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 5px;opacity:0;transform:scale(0);transition:opacity .2s,transform .2s;border:2px solid var(--ck-surface);}',
    '#aicb-badge.visible{opacity:1;transform:scale(1);}',

    /* Panel */
    /* The max-height pair is not belt-and-braces, it is the fallback
       chain: dvh is Safari 15.4 / Chrome 108, and a browser without it
       takes the vh line rather than no line at all. 110px is the room
       the launcher and the two bottom offsets need underneath.

       Without a ceiling here the panel is sized purely by its content —
       ~564px — and a landscape phone (844x390) is far too WIDE to match
       the 480px query below and far too SHORT to show it, so the header
       and half the transcript sat above the top of the screen.

       visibility, not just opacity: opacity:0 and pointer-events:none
       hide a node from the eye and the mouse but leave it in the
       accessibility tree and in sequential focus order, so on every page
       carrying the tag a keyboard user tabbed off the last link and into
       a chat textarea and a Send button they could not see. visibility
       is in the transition list on purpose — it flips at the END of the
       fade out and the START of the fade in, so the 0.22s animation is
       preserved. display:none would kill the transition outright. */
    '#aicb-panel{position:absolute;bottom:70px;right:0;width:380px;max-width:calc(100vw - 32px);max-height:calc(100vh - 110px);max-height:calc(100dvh - 110px);background:var(--ck-surface);border:1px solid var(--ck-line);border-radius:16px;box-shadow:0 24px 60px -18px var(--ck-shadow),0 2px 8px -2px rgba(10,10,12,.10);display:flex;flex-direction:column;overflow:hidden;transform-origin:bottom right;transition:opacity .22s cubic-bezier(.2,.7,.3,1),transform .22s cubic-bezier(.2,.7,.3,1),visibility .22s;opacity:0;transform:scale(.96) translateY(10px);pointer-events:none;visibility:hidden;}',
    '#aicb-panel.open{opacity:1;transform:none;pointer-events:all;visibility:visible;}',

    /* Header — neutral, so the tenant colour reads as an accent rather than
       a slab. The avatar disc and the send button carry it instead. */
    '#aicb-header{background:var(--ck-surface);border-bottom:1px solid var(--ck-line);padding:13px 12px 13px 15px;display:flex;align-items:center;gap:11px;color:var(--ck-ink);flex-shrink:0;}',
    '#aicb-avatar{width:34px;height:34px;border-radius:50%;background:var(--ck-color);display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;}',
    '#aicb-avatar svg{width:18px;height:18px;fill:none;stroke:var(--ck-on-color);stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',
    '#aicb-avatar svg .ck-eye{fill:var(--ck-on-color);stroke:none;}',
    /* Tenant logo, in the header avatar and NOWHERE ELSE. `cover` on a
       square box: a wordmark uploaded as a wide rectangle crops to its
       middle, which reads better than the letterboxing `contain` gives
       inside a circle. The launcher deliberately keeps the generic chat
       mark — see applyLogo. */
    '#aicb-avatar img{width:100%;height:100%;border-radius:50%;object-fit:cover;display:block;}',
    '#aicb-header-text{flex:1;min-width:0;}',
    '#aicb-bot-name{font-size:14.5px;font-weight:640;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.015em;line-height:1.3;}',
    '#aicb-status{font-size:11.5px;color:var(--ck-muted);display:flex;align-items:center;gap:5px;margin-top:1px;}',
    '#aicb-status-dot{width:6px;height:6px;border-radius:50%;background:var(--ck-online);display:inline-block;flex-shrink:0;}',
    '#aicb-close{width:30px;height:30px;border-radius:8px;border:none;background:transparent;color:var(--ck-faint);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s,color .15s;padding:0;font-family:inherit;}',
    '#aicb-close:hover{background:var(--ck-chip);color:var(--ck-ink);}',
    '#aicb-close:focus-visible{outline:2px solid var(--ck-color-ink);outline-offset:1px;}',
    '#aicb-close svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;display:block;}',

    /* Transcript */
    '#aicb-messages{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:16px 14px;display:flex;flex-direction:column;gap:8px;min-height:210px;max-height:420px;scroll-behavior:smooth;background:var(--ck-sunk);}',
    /* Smooth scrolling and a streaming reply are incompatible: append
       assigns scrollTop on every delta, and each assignment RESTARTS the
       smooth animation from wherever the last one had reached. It never
       arrives, which is the stutter visible during a long reply. The
       class is on while isTyping and comes off in settle. */
    '#aicb-messages.ck-jump{scroll-behavior:auto;}',
    '#aicb-messages::-webkit-scrollbar{width:5px;}',
    '#aicb-messages::-webkit-scrollbar-track{background:transparent;}',
    '#aicb-messages::-webkit-scrollbar-thumb{background:var(--ck-scroll);border-radius:4px;}',
    /* Firefox has no ::-webkit-scrollbar; without this it paints the OS
       scrollbar, which follows the VISITOR's system theme rather than
       the bot's — a light bar down a panel the tenant set to dark. */
    '#aicb-messages{scrollbar-width:thin;scrollbar-color:var(--ck-scroll) transparent;}',

    /* Bubbles */
    '.ck-msg{max-width:82%;padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.6;word-break:break-word;animation:ck-pop .2s cubic-bezier(.2,.7,.3,1);}',
    '@keyframes ck-pop{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}',
    '.ck-msg.bot{background:var(--ck-surface);color:var(--ck-ink);border:1px solid var(--ck-line);border-bottom-left-radius:5px;align-self:flex-start;}',
    '.ck-msg.user{background:var(--ck-color);color:var(--ck-on-color);border-bottom-right-radius:5px;align-self:flex-end;font-weight:500;}',
    '.ck-msg.error{background:var(--ck-err-bg);color:var(--ck-err-ink);border:1px solid var(--ck-err-line);align-self:flex-start;font-size:13px;white-space:pre-line;}',

    /* Markdown output */
    '.ck-msg p{margin:0;}',
    '.ck-msg p + p,.ck-msg p + ul,.ck-msg p + ol,.ck-msg ul + p,.ck-msg ol + p,.ck-msg pre + p,.ck-msg pre + ul,.ck-msg pre + ol{margin-top:8px;}',
    '.ck-msg ul,.ck-msg ol{margin:0;padding-left:19px;}',
    '.ck-msg li{margin:2px 0;}',
    '.ck-msg strong{font-weight:680;}',
    '.ck-msg em{font-style:italic;}',
    '.ck-msg code{background:var(--ck-code);padding:1px 5px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;}',
    /* Fenced blocks. Scrolls sideways rather than wrapping: a wrapped
       command line is a command line that no longer runs when pasted. */
    '.ck-msg pre{background:var(--ck-code);border-radius:8px;padding:9px 11px;margin-top:8px;overflow-x:auto;}',
    '.ck-msg pre code{background:none;padding:0;border-radius:0;white-space:pre;display:block;font-size:.86em;line-height:1.5;}',
    /* NOT --ck-code: a user bubble is painted in the tenant colour, which
       is neither of the two surfaces those tokens are tuned against and
       can be any lightness at all. A mid-grey at 28% is the one tint that
       stays visible on a navy bubble and on a pale-yellow one. */
    '.ck-msg.user code,.ck-msg.user pre{background:rgba(127,127,127,.28);}',
    '.ck-msg a{color:inherit;text-decoration:underline;text-underline-offset:2px;}',
    '.ck-msg.bot a{color:var(--ck-color-ink);}',
    /* Citation line. Quiet by design: it is provenance, not content, and
       it must not compete with the answer it sits under. */
    '.ck-cite{margin-top:7px;padding-top:6px;border-top:1px solid var(--ck-line);font-size:11px;line-height:1.35;color:var(--ck-faint);overflow-wrap:anywhere;}',

    /* Typing */
    '#aicb-typing{display:none;align-self:flex-start;background:var(--ck-surface);border:1px solid var(--ck-line);border-radius:14px;border-bottom-left-radius:5px;padding:12px 14px;gap:4px;align-items:center;}',
    '#aicb-typing.visible{display:flex;}',
    '.ck-dot{width:6px;height:6px;border-radius:50%;background:var(--ck-dots);animation:ck-bounce 1.4s infinite ease-in-out;}',
    '.ck-dot:nth-child(2){animation-delay:.16s;}',
    '.ck-dot:nth-child(3){animation-delay:.32s;}',
    '@keyframes ck-bounce{0%,60%,100%{transform:translateY(0);}30%{transform:translateY(-5px);}}',

    /* Chips — quiet neutrals that sit under the greeting inside the
       transcript, instead of a coloured rail pinned to the base. */
    '#aicb-chips{display:flex;flex-wrap:wrap;gap:6px;align-self:flex-start;max-width:100%;margin-top:2px;}',
    '.ck-chip{background:var(--ck-surface);border:1px solid var(--ck-line);color:var(--ck-muted);border-radius:9px;padding:7px 11px;font-size:12.5px;font-weight:560;cursor:pointer;transition:border-color .15s,color .15s;text-align:left;font-family:inherit;line-height:1.35;}',
    '.ck-chip:hover{border-color:var(--ck-color-ink);color:var(--ck-ink);}',
    '.ck-chip:focus-visible{outline:2px solid var(--ck-color-ink);outline-offset:2px;}',

    /* Profile card — the business as things a visitor can press. It sits
       in the transcript under the greeting for the same reason the chips
       do: it belongs to the opening turn rather than being furniture
       bolted to the panel, and it is allowed to scroll away once a real
       conversation starts. */
    '#aicb-card{align-self:stretch;background:var(--ck-surface);border:1px solid var(--ck-line);border-radius:12px;padding:10px 11px;display:flex;flex-direction:column;gap:8px;}',
    '.ck-card-name{font-size:12.5px;font-weight:640;color:var(--ck-ink);letter-spacing:-.01em;line-height:1.3;}',
    '.ck-acts{display:flex;flex-wrap:wrap;gap:6px;}',
    '.ck-act{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--ck-line);border-radius:9px;padding:6px 10px;font-size:12.5px;font-weight:560;line-height:1.3;color:var(--ck-ink);text-decoration:none;transition:border-color .15s,background .15s;}',
    '.ck-act:hover{border-color:var(--ck-color-ink);background:var(--ck-chip);}',
    '.ck-act:focus-visible{outline:2px solid var(--ck-color-ink);outline-offset:2px;}',
    /* Booking is the only filled one. Two brand-coloured buttons in a
       six-button row is a row with no primary action in it. */
    '.ck-act.primary{background:var(--ck-color);border-color:var(--ck-color);color:var(--ck-on-color);}',
    '.ck-act.primary:hover{background:var(--ck-color);filter:brightness(.94);}',
    '.ck-act svg,.ck-hicon svg,.ck-chev svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;display:block;}',
    '.ck-hicon,.ck-chev{display:flex;flex-shrink:0;}',
    '.ck-addr{display:flex;align-items:flex-start;gap:6px;font-size:12px;line-height:1.45;color:var(--ck-muted);}',
    '.ck-addr .ck-hicon{margin-top:2px;color:var(--ck-faint);}',
    '.ck-hnote{font-size:12px;line-height:1.45;color:var(--ck-muted);}',
    '.ck-hours-btn{display:flex;align-items:center;gap:6px;width:100%;background:transparent;border:none;font-family:inherit;font-size:12.5px;font-weight:560;color:var(--ck-muted);cursor:pointer;text-align:left;padding:0;}',
    '.ck-hours-btn:hover{color:var(--ck-ink);}',
    '.ck-hours-btn:focus-visible{outline:2px solid var(--ck-color-ink);outline-offset:2px;border-radius:6px;}',
    '.ck-hsum{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.ck-chev{transition:transform .18s;}',
    '.ck-hours-btn[aria-expanded="true"] .ck-chev{transform:rotate(180deg);}',
    '.ck-hours{display:none;flex-direction:column;gap:3px;padding-top:7px;border-top:1px solid var(--ck-line);}',
    '.ck-hours.open{display:flex;}',
    '.ck-hrow{display:flex;justify-content:space-between;gap:12px;font-size:12px;line-height:1.4;color:var(--ck-muted);}',
    '.ck-hrow.today{color:var(--ck-ink);font-weight:640;}',
    '.ck-hmeta{font-size:11px;line-height:1.4;color:var(--ck-faint);margin-top:3px;}',

    /* Composer */
    '#aicb-footer{border-top:1px solid var(--ck-line);padding:11px 12px;display:flex;gap:9px;align-items:flex-end;background:var(--ck-surface);flex-shrink:0;}',
    '#aicb-input{flex:1;resize:none;overflow:hidden;border:1px solid var(--ck-line);border-radius:10px;padding:10px 12px;font-size:14px;font-family:inherit;font-weight:460;color:var(--ck-ink);background:var(--ck-surface);outline:none;transition:border-color .15s,box-shadow .15s;max-height:96px;line-height:1.5;display:block;}',
    '#aicb-input::placeholder{color:var(--ck-faint);}',
    /* Two box-shadows on purpose. color-mix is Safari 16.2 / Chrome 111,
       and this file still carries an `addListener` fallback for Safari
       13 — on anything older the whole declaration is dropped and the
       focus ring disappears entirely, which is an accessibility
       regression rather than a cosmetic one. The neutral goes first and
       the tinted one overwrites it wherever it parses. */
    '#aicb-input:focus{border-color:var(--ck-color-ink);box-shadow:0 0 0 3px var(--ck-chip);box-shadow:0 0 0 3px color-mix(in srgb,var(--ck-color) 20%,transparent);}',
    '#aicb-send{width:38px;height:38px;border-radius:10px;border:none;background:var(--ck-color);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:opacity .15s,transform .15s;padding:0;font-family:inherit;}',
    '#aicb-send:hover:not(:disabled){transform:scale(1.05);}',
    '#aicb-send:active:not(:disabled){transform:scale(.96);}',
    '#aicb-send:disabled{opacity:.3;cursor:not-allowed;}',
    '#aicb-send:focus-visible{outline:2px solid var(--ck-color-ink);outline-offset:2px;}',
    '#aicb-send svg{width:16px;height:16px;fill:none;stroke:var(--ck-on-color);stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;}',

    /* Attribution */
    '#aicb-powered{text-align:center;font-size:10.5px;color:var(--ck-faint);padding:0 0 10px;background:var(--ck-surface);flex-shrink:0;letter-spacing:.01em;}',
    '#aicb-powered a{color:var(--ck-muted);text-decoration:none;font-weight:560;transition:color .15s;}',
    '#aicb-powered a:hover{color:var(--ck-ink);}',

    /* Bottom-left. One class on the wrapper, because moving the launcher
       also moves the panel it opens, the corner that panel scales from,
       and the badge that sits on it — four rules that have to agree, and
       four inline style patches that would not. */
    '.ck-w.ck-left{right:auto;left:24px;}',
    '.ck-w.ck-left #aicb-panel{right:auto;left:0;transform-origin:bottom left;}',
    '.ck-w.ck-left #aicb-badge{right:auto;left:-1px;}',

    '@media(max-width:480px){',
    '.ck-w{bottom:16px;right:16px;}',
    '#aicb-panel{width:calc(100vw - 32px);right:-16px;border-radius:14px;}',
    '.ck-w.ck-left{left:16px;right:auto;}',
    '.ck-w.ck-left #aicb-panel{left:-16px;right:auto;}',
    '#aicb-messages{min-height:260px;max-height:calc(100svh - 260px);}',
    '}',

    /* Short viewports — landscape phones, and a browser window dragged
       down to half a laptop screen. The panel ceiling above does nothing
       on its own: `min-height:210px` on the transcript is a flex floor,
       so the panel would honour its max-height by CLIPPING the composer
       off the bottom instead of shrinking the scroller. Releasing the
       floor is what makes the ceiling work. */
    '@media(max-height:700px){',
    '#aicb-messages{min-height:110px;max-height:none;}',
    '}',
    '@media(prefers-reduced-motion:reduce){',
    '.ck-w *{animation:none!important;transition:none!important;}',
    '}',
  ].join('\n');

  // ── Icons ─────────────────────────────────────────────────────
  /* No stroke/fill attributes on the inner shapes: a presentation
     attribute on a child beats the stylesheet, and the stylesheet is
     what knows the readable foreground for this tenant's colour. */
  var ICON_CHAT  = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  var ICON_BOT   = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M12 2v4M8 11V7a4 4 0 0 1 8 0v4"/><circle cx="9" cy="16" r="1" class="ck-eye"/><circle cx="15" cy="16" r="1" class="ck-eye"/></svg>';
  var ICON_SEND  = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

  /* Profile card. Same no-attributes rule as above — these inherit
     currentColor, which on the filled Book button is --ck-on-color and
     everywhere else is the surrounding text. */
  var ICON_PHONE    = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/></svg>';
  var ICON_PIN      = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
  var ICON_CALENDAR = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
  var ICON_MAIL     = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><polyline points="22 6 12 13 2 6"/></svg>';
  var ICON_WHATSAPP = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8z"/></svg>';
  var ICON_CLOCK    = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
  var ICON_CHEVRON  = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><polyline points="6 9 12 15 18 9"/></svg>';

  // ── Markdown ──────────────────────────────────────────────────
  /*
   * Renders a small, safe subset of markdown.
   *
   * SECURITY: reply text is model output, and the model may have read
   * attacker-controlled documents through RAG. So this ESCAPES FIRST
   * and only then applies transforms — no HTML from the model can ever
   * survive into the DOM. Links are additionally protocol-checked,
   * because an escaped "javascript:" would still be a live URL.
   */
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function safeUrl(url) {
    /* Only absolute http(s) and mailto. Anything else — javascript:,
       data:, vbscript: — is dropped rather than rendered. */
    return /^(https?:\/\/|mailto:)[^\s<>"']+$/i.test(url) ? url : null;
  }

  function renderInline(text) {
    return text
      /* Links first: their label may itself contain emphasis markers. */
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (m, label, href) {
        var safe = safeUrl(href);
        return safe
          ? '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + label + '</a>'
          : label;
      })
      /* Bare URLs, but not ones already inside an href we just built.
         A full stop after one ends the SENTENCE far more often than it
         belongs to the address, and "see https://x.com/page." used to
         put it inside the href - a link that 404s on its punctuation. */
      .replace(/(^|[\s(])((?:https?:\/\/)[^\s<>"']+)/g, function (m, pre, url) {
        var tail = '';
        var trimmed = url.replace(/[.,;:!?)]+$/, function (t) { tail = t; return ''; });
        var safe = safeUrl(trimmed);
        return safe
          ? pre + '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + safe + '</a>' + tail
          : m;
      })
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  }

  function renderMarkdown(raw) {
    var lines = escapeHtml(raw).split('\n');
    var html = '';
    var listType = null;   // 'ul' | 'ol' | null
    var para = [];
    var fence = null;      // lines collected inside an open ``` block

    function flushPara() {
      if (!para.length) return;
      html += '<p>' + renderInline(para.join('<br>')) + '</p>';
      para = [];
    }
    function closeList() {
      if (listType) { html += '</' + listType + '>'; listType = null; }
    }
    /* The body is already escaped by the escapeHtml above and goes in
       verbatim, with no renderInline pass: nothing inside a code block
       is markdown, and a URL in a shell snippet is not a link. */
    function closeFence() {
      html += '<pre><code>' + fence.join('\n') + '</code></pre>';
      fence = null;
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var isFence = /^\s*```/.test(line);

      if (fence) {
        if (isFence) closeFence();
        else fence.push(line);
        continue;
      }
      if (isFence) {
        /* The info string ("```js") is dropped: there is no highlighter
           here, so it would render as a stray line of output above the
           block it labels. */
        flushPara(); closeList();
        fence = [];
        continue;
      }

      var bullet  = /^\s*[-*+]\s+(.*)$/.exec(line);
      var ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
      var heading = /^\s*#{1,6}\s+(.*)$/.exec(line);

      if (bullet || ordered) {
        flushPara();
        var want = bullet ? 'ul' : 'ol';
        if (listType !== want) { closeList(); html += '<' + want + '>'; listType = want; }
        html += '<li>' + renderInline((bullet || ordered)[1]) + '</li>';
      } else if (heading) {
        /* Rendered as bold rather than a real heading: an h1 inside a
           chat bubble inherits the host page's typography and looks
           broken on most sites. */
        flushPara(); closeList();
        html += '<p><strong>' + renderInline(heading[1]) + '</strong></p>';
      } else if (line.trim() === '') {
        flushPara(); closeList();
      } else {
        closeList();
        para.push(line);
      }
    }
    /* An unterminated fence is the normal state MID-STREAM: the opening
       ``` arrives many deltas before the closing one. Render what has
       landed rather than hiding the block until it completes. */
    if (fence) closeFence();
    flushPara(); closeList();
    return html;
  }

  // ── DOM helper ────────────────────────────────────────────────
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'className')    node.className    = attrs[k];
      else if (k === 'innerHTML')   node.innerHTML    = attrs[k];
      else if (k === 'textContent') node.textContent  = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    if (children) children.forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  // ── Build DOM ─────────────────────────────────────────────────
  /*
   * The host element's geometry, set INLINE and !important.
   *
   * It is the one node a host page can still select, and a `:host` rule
   * would not defend it: on a tie, :host declarations lose to the
   * document's own by definition, so a page-wide `div{position:static}`
   * or a `z-index:1` would strand the widget with nothing behind it.
   *
   * Zero-sized on purpose — this is an anchor, not a box. Everything
   * visible is `.ck-w` inside the shadow root, positioned against the
   * viewport. transform/filter/perspective/contain are pinned to their
   * no-op values because each one of them would silently make THIS
   * element the containing block for that fixed-position wrapper, which
   * is a corner offset measured from a 0x0 box in the top-left.
   */
  var HOST_STYLE = [
    ['position', 'fixed'], ['top', '0'], ['left', '0'],
    ['width', '0'], ['height', '0'],
    ['margin', '0'], ['padding', '0'], ['border', '0'],
    ['display', 'block'], ['overflow', 'visible'], ['float', 'none'],
    ['transform', 'none'], ['filter', 'none'], ['perspective', 'none'],
    ['contain', 'none'], ['opacity', '1'], ['visibility', 'visible'],
    ['z-index', '2147483647'],
  ];

  /* @font-face does not cross a shadow boundary in ANY browser: a face
     declared only inside the shadow root is never fetched, and the panel
     falls back to the system stack with nothing in the console to say
     so. So the face — and only the face — is injected into the document.
     A rule with no selector cannot touch the host page. */
  var fontInjected = false;
  function injectFont() {
    var head = document.head || document.getElementsByTagName('head')[0];
    if (fontInjected || !head) return;
    fontInjected = true;
    head.appendChild(el('style', { id: 'aicb-font', innerHTML: FONT_CSS }));
  }

  function buildDOM() {
    var style = el('style', { innerHTML: CSS });

    var bubbleIcon  = el('span', { id: 'aicb-bubble-icon',  innerHTML: ICON_CHAT  });
    var bubbleClose = el('span', { id: 'aicb-bubble-close', innerHTML: ICON_CLOSE });
    /* aria-hidden, and empty until something is actually unread. The
       count used to be a hardcoded '1' that never moved; it is now real,
       and it is spoken through the launcher's own aria-label rather than
       from here, because a button's label overrides its contents and a
       number nested inside one is silent. */
    var badge  = el('div',    { id: 'aicb-badge', 'aria-hidden': 'true' });
    var bubble = el('button', { id: 'aicb-bubble', 'aria-label': 'Open chat', 'aria-expanded': 'false' },
      [bubbleIcon, bubbleClose, badge]);

    var avatar     = el('div',  { id: 'aicb-avatar',      innerHTML: ICON_BOT });
    var botName    = el('div',  { id: 'aicb-bot-name',    textContent: config.name });
    var statusDot  = el('span', { id: 'aicb-status-dot'  });
    var statusTxt  = el('span', { textContent: 'Online · Typically replies instantly' });
    var status     = el('div',  { id: 'aicb-status'       }, [statusDot, statusTxt]);
    var headerText = el('div',  { id: 'aicb-header-text'  }, [botName, status]);
    /* The launcher already toggles, but people look for a close control
       inside the panel they are reading, not behind it. */
    var closeBtn   = el('button', { id: 'aicb-close', 'aria-label': 'Close chat', innerHTML: ICON_CLOSE });
    var header     = el('div',  { id: 'aicb-header'       }, [avatar, headerText, closeBtn]);

    /* The dots are decoration; the fact that the assistant is composing
       is not, and it had no accessible name at all. role="status" on the
       container announces it, aria-hidden on each dot keeps three empty
       divs out of the tree. */
    var dot1    = el('div', { className: 'ck-dot', 'aria-hidden': 'true' });
    var dot2    = el('div', { className: 'ck-dot', 'aria-hidden': 'true' });
    var dot3    = el('div', { className: 'ck-dot', 'aria-hidden': 'true' });
    var typing  = el('div', { id: 'aicb-typing', role: 'status', 'aria-label': 'Assistant is typing' },
      [dot1, dot2, dot3]);
    var messages = el('div', { id: 'aicb-messages', role: 'log', 'aria-live': 'polite' }, [typing]);

    /* Created detached: renderChips places it in the transcript, under
       the greeting, so the suggestions read as part of the conversation
       rather than a toolbar bolted to the bottom of the panel. */
    var chips   = el('div',      { id: 'aicb-chips' });
    var input   = el('textarea', { id: 'aicb-input', placeholder: 'Type a message…', rows: '1', 'aria-label': 'Message',
      // Mirrors LIMITS.chatMessage in src/config.ts, which is the real
      // control — this only spares a visitor typing past a limit the
      // endpoint is going to reject anyway.
      maxlength: '2000' });
    var sendBtn = el('button',   { id: 'aicb-send',  'aria-label': 'Send', innerHTML: ICON_SEND });
    var footer  = el('div', { id: 'aicb-footer' }, [input, sendBtn]);
    var powered = el('div', { id: 'aicb-powered',
      innerHTML: 'Powered by <a href="https://conversekit.io" target="_blank" rel="noopener">ConverseKit</a>' });

    /* No aria-modal. It tells a screen reader to ignore the rest of the
       page, and nothing here traps focus, the host page stays fully
       usable behind the panel, and Escape closes it — the attribute
       described a widget this is not. A focus trap is NOT the other way
       to make it true: trapping focus inside a persistent site widget
       makes the rest of the page unreachable for as long as it is open,
       which is worse than the non-modal dialog this actually is. */
    var panel = el('div', { id: 'aicb-panel', role: 'dialog', 'aria-label': 'Chat assistant' },
      [header, messages, footer, powered]);

    /* One wrapper, holding every class the layout switches on — dark,
       left, open. It sits inside the shadow root, which is what makes
       those classes untouchable, and it is where the --ck-* tokens and
       the inherited-property firewall are declared. */
    var wrap = el('div', { className: 'ck-w' }, [panel, bubble]);

    var root = el('div', { id: 'aicb-root' });
    HOST_STYLE.forEach(function (p) { root.style.setProperty(p[0], p[1], 'important'); });
    injectFont();

    /* mode:'open' rather than 'closed': a closed root hides the tree from
       the tenant's own devtools scripting for no security gain — the page
       already runs in the same realm as this file. */
    var shadow = root.attachShadow ? root.attachShadow({ mode: 'open' }) : root;
    shadow.appendChild(style);
    shadow.appendChild(wrap);

    return { root, shadow, wrap, panel, bubble, badge, messages, typing, chips, input, sendBtn, botName, closeBtn, avatar };
  }

  /** Focus inside a shadow root reads as the HOST from the document's
      point of view; the real node is on the root's own activeElement. */
  function activeNode(dom) {
    var inner = dom.root.shadowRoot && dom.root.shadowRoot.activeElement;
    return inner || document.activeElement;
  }

  /* Swap the built-in mark for the tenant's logo — in the HEADER, and
     nowhere else. The launcher keeps the same generic chat glyph on
     every bot on the platform: it is a control, and a visitor reads a
     56px disc in the corner of a page as "chat", not as a brand. Cropped
     into that circle a wordmark reads as a stray avatar instead, and the
     one affordance the widget has stops looking like a button. The logo
     belongs inside the panel, beside the name, where the visitor is
     already looking at the conversation it labels.

     Applied after /health answers, so the SVG is what shows while that
     request is in flight — and stays if it fails. `onerror` restores it
     too: a logo that 404s or is blocked by a corporate proxy must leave
     a bot looking generic, never looking broken. */
  function applyLogo(dom) {
    if (!config.logoUrl || !dom.avatar) return;

    var img = el('img', { src: config.logoUrl, alt: '', 'aria-hidden': 'true' });
    img.addEventListener('error', function () { dom.avatar.innerHTML = ICON_BOT; });
    dom.avatar.innerHTML = '';
    dom.avatar.appendChild(img);
  }

  // ── Messages ──────────────────────────────────────────────────
  function nearBottom(box) {
    return box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  }

  function appendMessage(dom, text, role) {
    var div  = el('div', { className: 'ck-msg ' + role });
    /* Only bot replies are markdown. Visitor text and our own error
       copy are inserted as text, never parsed. */
    if (role === 'bot') div.innerHTML = renderMarkdown(text);
    else div.textContent = text;
    dom.messages.insertBefore(div, dom.typing);
    dom.messages.scrollTop = dom.messages.scrollHeight;
    return div;
  }

  /* "Source: Pricing 2026" under a reply that used retrieval.

     textContent, never innerHTML, and deliberately not routed through
     renderMarkdown either. A document title is whatever a tenant typed
     — or, for an uploaded file, whatever the FILENAME was — so it is
     untrusted text that happens to arrive over a trusted channel. The
     one job here is to display it verbatim. */
  /* POSITIONAL, not a set: titles[n - 1] is the source behind the "[n]"
     the model wrote in its reply. The two numbering schemes used to be
     unrelated — the prompt numbered excerpts in rank order while this
     list showed deduplicated titles in database order — so a reply
     saying "according to [2]" pointed at a source list where nothing
     was 2. See docs/rag-hardening.md, B6.

     Repeats are expected and are not a bug: several excerpts often come
     from one document. They are grouped so the row reads "[1,3] Pricing"
     rather than naming the same file twice, which keeps the markers
     intact while staying short enough for a chat bubble. */
  /* Returns the row it appended, or null. beginBotMessage holds onto it:
     the streamed bubble re-renders its own innerHTML, and a citation
     line appended before that last render would be wiped by it. */
  function appendCitations(node, titles) {
    if (!node || !titles || !titles.length) return null;

    var groups = [];
    var byTitle = {};
    for (var i = 0; i < titles.length; i++) {
      var title = titles[i];
      /* A document that vanished between the answer and the lookup. Its
         marker is dropped rather than shown as an empty source, and the
         remaining numbers keep the values the model used. */
      if (!title) continue;
      var key = '#' + title;
      if (!byTitle[key]) {
        byTitle[key] = { title: title, marks: [] };
        groups.push(byTitle[key]);
      }
      byTitle[key].marks.push(i + 1);
    }
    if (!groups.length) return null;

    var shown = groups.slice(0, 3).map(function (g) {
      return '[' + g.marks.join(',') + '] ' + g.title;
    });

    var row = el('div', { className: 'ck-cite' });
    row.textContent = (groups.length === 1 ? 'Source: ' : 'Sources: ') + shown.join(' · ');
    node.appendChild(row);
    return row;
  }

  /* Characters in a delta that can change how text ALREADY on screen
     parses. The markdown markers, plus ':' and '/' — those two begin a
     bare URL, and "visit https:" followed by "//x.com" has to linkify as
     one link rather than as the prefix that was already painted. */
  var UNSAFE_DELTA = /[*`\[\]#\n:/]/;

  /** The text node a plain delta can be appended to, or null if the
      bubble does not currently end in one. A trailing <a> (a bare URL
      still being typed) or a list is exactly the shape that must NOT be
      extended blindly, and both fail this check. */
  function tailTextNode(div) {
    var block = div.lastChild;
    if (!block || block.nodeName !== 'P') return null;
    var node = block.lastChild;
    return (node && node.nodeType === 3) ? node : null;
  }

  /* Empty bot bubble that text is streamed into. Returns a handle so
     deltas can be appended without rebuilding the node. */
  function beginBotMessage(dom) {
    /* aria-live="off" WHILE IT FILLS. #aicb-messages is a polite live
       region and this bubble's contents change on every delta, so
       without this a screen reader re-reads the reply from the top once
       per token — fifty to a hundred times a message. done() lifts it,
       and the render that follows is then the single mutation the region
       announces. */
    var div = el('div', { className: 'ck-msg bot', 'aria-live': 'off' });
    dom.messages.insertBefore(div, dom.typing);

    var raw = '';
    var rendered = '';    // the markup innerHTML holds, kept in step below
    var citeRow = null;

    function render() {
      rendered = renderMarkdown(raw);
      div.innerHTML = rendered;
      if (citeRow) div.appendChild(citeRow);
    }

    return {
      /*
       * The full re-render is O(n²) over a reply and tears the bubble's
       * DOM down on every token. Two costs beyond the arithmetic: a
       * selection made mid-stream is destroyed, so nothing can be copied
       * out of a reply until it finishes, and a link in an
       * already-rendered part is replaced under the cursor mid-click.
       *
       * So a delta that cannot change how anything already painted
       * PARSES goes straight onto the trailing text node instead. Most
       * deltas from every provider in src/providers/ are plain prose,
       * which makes that the common path and an O(1) one.
       *
       * The guards are the proof, not caution: no significant character
       * in the chunk, the bubble ends in a paragraph's own text (see
       * tailTextNode), and raw does not end in a newline — otherwise the
       * chunk is at the head of a fresh line, where "- " opens a list
       * and this would append it into the previous paragraph instead.
       */
      append: function (text) {
        var stick = nearBottom(dom.messages);
        var tail = (raw && raw.charAt(raw.length - 1) !== '\n' && !UNSAFE_DELTA.test(text))
          ? tailTextNode(div) : null;
        raw += text;

        if (tail && rendered.slice(-4) === '</p>') {
          tail.appendData(text);
          /* Kept in step by construction: the appended text lands inside
             the final paragraph, so the markup a full render would have
             produced is the old string with the escaped chunk spliced in
             before its closing tag. done() compares, and re-renders only
             if this ever drifts. */
          rendered = rendered.slice(0, -4) + escapeHtml(text) + '</p>';
        } else {
          render();
        }

        if (stick) dom.messages.scrollTop = dom.messages.scrollHeight;
      },
      isEmpty: function () { return raw === ''; },
      cite: function (titles) {
        citeRow = appendCitations(div, titles);
        if (nearBottom(dom.messages)) dom.messages.scrollTop = dom.messages.scrollHeight;
      },
      /* End of stream. The attribute comes off BEFORE the render, so the
         one mutation left is the finished reply landing inside a polite
         live region — announced once, which is the whole point of A3.
         The render itself is skipped when the incremental appends
         already produced exactly what a full pass would, which is the
         common case and is what lets a selection survive to the end. */
      done: function () {
        div.removeAttribute('aria-live');
        if (renderMarkdown(raw) !== rendered) render();
      },
      remove:  function () {
        if (div.parentNode) dom.messages.removeChild(div);
      },
    };
  }

  // ── Chips ─────────────────────────────────────────────────────
  /* Fallback only. These used to be the ONLY chips available, and they
     were dental-specific — every bot on the platform asked its visitors
     about insurance and booking appointments, whatever the business
     actually was. Per-bot chips now arrive from /health; this set is
     the vertical-neutral default when a bot has not set its own. */
  var DEFAULT_CHIPS = [
    'What services do you offer?',
    'What are your opening hours?',
    'How can I contact you?',
  ];

  function renderChips(dom, doSend) {
    /* Array.isArray, not truthiness-and-length: an EMPTY array is a
       tenant who deliberately cleared their suggestions, and falling
       back to the defaults there hands them back three questions they
       just deleted. Only `null` — the key absent from /health — means
       "never set one", which is what the defaults are for. */
    var chips = Array.isArray(config.suggestions) ? config.suggestions.slice(0, 6) : DEFAULT_CHIPS;
    if (!chips.length) return;

    chips.forEach(function (label) {
      var chip = el('button', { className: 'ck-chip', textContent: label });
      chip.addEventListener('click', function () {
        dom.chips.style.display = 'none';
        doSend(label);
      });
      dom.chips.appendChild(chip);
    });
    dom.messages.insertBefore(dom.chips, dom.typing);
  }

  // ── Profile card ──────────────────────────────────────────────
  /*
   * The business, rendered as things a visitor can PRESS.
   *
   * /health has carried a `profile` object since supabase/015 — address,
   * map link, phone, WhatsApp, email, booking link, and a weekly hours
   * grid — and nothing consumed it, so the only way a visitor got a
   * phone number was to ask the model to retype one out of its prompt.
   * It usually did. "Usually" is the whole problem: a tel: link built
   * from the column cannot drop a digit, and a booking button cannot
   * send anyone to a URL that never existed.
   *
   * Display only. Nothing here is sent to the model, so pressing Call
   * costs no tokens, needs no network, and cannot fail.
   */
  var DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  var DAY_LABEL = {
    mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
    fri: 'Friday', sat: 'Saturday', sun: 'Sunday'
  };
  /* getDay() is Sunday-based; the profile's keys are not. Mirrors
     DAY_BY_INDEX in src/profile.ts, and for the same reason. */
  var DAY_BY_INDEX = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  /* A tenant-authored string about to become a live href. The channel is
     trusted — it is their own dashboard — but "trusted source" has never
     been a reason to skip a scheme check, and the dashboard is not the
     only thing that can write that column. Same rule safeUrl applies to
     model output, plus tel:, which only this card needs. */
  function safeHref(url) {
    var s = String(url == null ? '' : url).trim();
    return /^(https?:\/\/|mailto:|tel:)[^\s<>"']+$/i.test(s) ? s : null;
  }

  /* The profile stores a phone as a human types it — "+44 20 7946 0958".
     A dialler wants the digits and the plus, and nothing else. */
  function telHref(phone) {
    var d = String(phone == null ? '' : phone).replace(/[^\d+]/g, '');
    return /^\+?\d{5,}$/.test(d) ? 'tel:' + d : null;
  }

  /* wa.me takes an international number, no punctuation, no leading +.
     Under six digits is a typo rather than a country code. */
  function waHref(num) {
    var d = String(num == null ? '' : num).replace(/\D/g, '');
    return d.length >= 6 ? 'https://wa.me/' + d : null;
  }

  function mailHref(addr) {
    var s = String(addr == null ? '' : addr).trim();
    return /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(s) ? 'mailto:' + s : null;
  }

  /* Today in the BUSINESS's timezone, not the visitor's: a shop in Lagos
     is open on its own Tuesday, whatever day it is where the visitor is
     sitting. Falls back to the visitor's local day when the profile
     carries no zone, or carries one this browser does not know. */
  function todayKey(tz) {
    var now = new Date();
    if (tz) {
      try {
        var short = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(now);
        var key = short.slice(0, 3).toLowerCase();
        if (DAY_LABEL[key]) return key;
      } catch (e) { /* not a zone this browser knows */ }
    }
    return DAY_BY_INDEX[now.getDay()];
  }

  function actionLink(href, label, icon, primary) {
    var a = el('a', { className: 'ck-act' + (primary ? ' primary' : ''), href: href, innerHTML: icon },
      [el('span', { textContent: label })]);
    /* http(s) leaves the page and must not hand the new tab an opener.
       tel: and mailto: hand off to an app without navigating, so a
       _blank on those only leaves a dead tab behind on desktop. */
    if (/^https?:/i.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
    return a;
  }

  /* Collapsed to today's line, expanding to the week. Seven rows is most
     of a chat panel, and the day a visitor is asking about is nearly
     always this one — so today is both the summary and the bold row. */
  function hoursNodes(hours) {
    var regular = (hours.regular && typeof hours.regular === 'object') ? hours.regular : null;
    var notes   = typeof hours.notes === 'string' ? hours.notes : '';
    var tz      = typeof hours.timezone === 'string' ? hours.timezone : '';

    /* A free-text note with no weekly grid behind it is one line, not a
       disclosure: expanding it would only show the summary again. */
    if (!regular) {
      return notes ? [el('div', { className: 'ck-hnote', textContent: notes })] : [];
    }

    var today = todayKey(tz);
    var grid  = el('div', { className: 'ck-hours' });

    DAY_ORDER.forEach(function (day) {
      var spans = regular[day];
      /* A closed day is ABSENT from the payload rather than empty — see
         profilePublicCard, which only emits days with intervals. */
      var open  = (Array.isArray(spans) && spans.length) ? spans.join(', ') : 'Closed';
      grid.appendChild(el('div', { className: 'ck-hrow' + (day === today ? ' today' : '') }, [
        el('span', { textContent: DAY_LABEL[day] }),
        el('span', { textContent: open })
      ]));
    });

    /* Both textContent: a tenant's own free text and their zone string
       are the same class of thing appendCitations handles — untrusted
       content arriving over a trusted channel, to be shown verbatim. */
    if (notes) grid.appendChild(el('div', { className: 'ck-hmeta', textContent: notes }));
    if (tz)    grid.appendChild(el('div', { className: 'ck-hmeta', textContent: 'Times shown in ' + tz }));

    var todaySpans = regular[today];
    var summary = (Array.isArray(todaySpans) && todaySpans.length)
      ? 'Open today · ' + todaySpans.join(', ')
      : 'Closed today';

    var toggle = el('button', { className: 'ck-hours-btn', type: 'button', 'aria-expanded': 'false' }, [
      el('span', { className: 'ck-hicon', innerHTML: ICON_CLOCK }),
      el('span', { className: 'ck-hsum', textContent: summary }),
      el('span', { className: 'ck-chev', innerHTML: ICON_CHEVRON })
    ]);
    toggle.addEventListener('click', function () {
      var open = grid.classList.toggle('open');
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    return [toggle, grid];
  }

  function renderProfileCard(dom) {
    var p = config.profile;
    if (!p || typeof p !== 'object') return;

    var acts = el('div', { className: 'ck-acts' });
    var add  = function (href, label, icon, primary) {
      if (href) acts.appendChild(actionLink(href, label, icon, primary));
    };

    /* Booking first and filled: it is the one action with a conversion
       behind it. The server already resolved lead_config.booking_url
       over the profile's copy, so this is whatever the tenant last set. */
    add(safeHref(p.booking), 'Book', ICON_CALENDAR, true);
    add(telHref(p.phone),    'Call',        ICON_PHONE);
    add(waHref(p.whatsapp),  'WhatsApp',    ICON_WHATSAPP);
    add(mailHref(p.email),   'Email',       ICON_MAIL);
    add(safeHref(p.mapUrl),  'Directions',  ICON_PIN);

    var rows = [];
    if (acts.childNodes.length) rows.push(acts);

    /* The address becomes text only when there is no map link to press.
       Showing both is the same fact twice, and the pressable one wins. */
    if (!safeHref(p.mapUrl) && typeof p.address === 'string' && p.address) {
      rows.push(el('div', { className: 'ck-addr' }, [
        el('span', { className: 'ck-hicon', innerHTML: ICON_PIN }),
        el('span', { textContent: p.address })
      ]));
    }

    if (p.hours && typeof p.hours === 'object') {
      hoursNodes(p.hours).forEach(function (n) { rows.push(n); });
    }

    /* A profile can be filled in and still leave nothing for this card —
       policies and services are facts the model uses that no button can
       express. No empty box in that case. */
    if (!rows.length) return;

    if (config.businessName && config.businessName !== config.name) {
      rows.unshift(el('div', { className: 'ck-card-name', textContent: config.businessName }));
    }

    dom.messages.insertBefore(el('div', { id: 'aicb-card' }, rows), dom.typing);
  }

  // ── API ───────────────────────────────────────────────────────
  /*
   * A status the SERVER chose, carried as an Error so it travels the
   * same .catch chain a dropped connection does — and can be told apart
   * from one at the far end.
   *
   * That distinction is the whole point. `err.status` is present only
   * when the server answered; a transport failure leaves it undefined.
   * Every retry decision below turns on it, because replaying a request
   * the server has already refused just spends it again.
   */
  function httpError(res) {
    return res.json()
      .catch(function () { return {}; })
      .then(function (body) {
        var err = new Error(body.error || ('HTTP ' + res.status));
        err.status = res.status;
        return Promise.reject(err);
      });
  }

  function fetchConfig(cb) {
    fetch(API_BASE + '/v1/bots/' + botId + '/health')
      /* r.ok, not just r.json(). A 404 answers with a JSON body that
         parses perfectly, so without this the widget read `{error:...}`,
         found no `name` on it, kept every default, and mounted a chat
         panel that greeted the visitor as "Assistant" and then failed on
         every single message. Fail here, where it can still be seen. */
      .then(function (r) { return r.ok ? r.json() : httpError(r); })
      .then(function (d) {
        if (d.name)         config.name         = d.name;
        if (d.businessName) config.businessName = d.businessName;
        if (d.contact)      config.contact      = d.contact;
        if (d.primaryColor) config.primaryColor = d.primaryColor;
        if (Array.isArray(d.suggestions)) config.suggestions = d.suggestions;
        /* supabase/015. Same additive contract as `widget` below: absent
           for every bot without a Business Profile, and the card simply
           does not render. */
        if (d.profile && typeof d.profile === 'object') config.profile = d.profile;

        /* Bot Configuration. Every field is checked for presence rather
           than merged wholesale: /health sends only what a tenant set,
           and an absent key has to mean "keep the default above" — not
           "set it to undefined". A widget older than a field ignores it,
           which is what lets a tenant's self-hosted copy keep working. */
        var w = d.widget;
        if (w && typeof w === 'object') {
          if (w.position === 'bottom-left' || w.position === 'bottom-right') config.position = w.position;
          if (w.theme === 'light' || w.theme === 'dark' || w.theme === 'auto') config.theme = w.theme;
          if (typeof w.logoUrl === 'string')  config.logoUrl  = w.logoUrl;
          if (typeof w.greeting === 'string') config.greeting = w.greeting;
          if (typeof w.greetingDelayMs === 'number' && w.greetingDelayMs > 0) {
            /* Clamped here as well as server-side: this value becomes a
               setTimeout, and a widget must not be able to be configured
               into never greeting anyone. */
            config.greetingDelayMs = Math.min(w.greetingDelayMs, 10000);
          }
          if (w.showTyping === false)   config.showTyping    = false;
          if (w.showCitations === true) config.showCitations = true;
        }
        cb(null);
      })
      .catch(cb);
  }

  function payload(msg) {
    var body = { botId: botId, message: msg };
    if (sessionId) body.sessionId = sessionId;
    return JSON.stringify(body);
  }

  /* Buffered fallback — one request, one reply. */
  function callChat(msg, onReply, onDone, onError) {
    fetch(API_BASE + '/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload(msg),
    })
      .then(function (r) { return r.ok ? r.json() : httpError(r); })
      .then(function (d) {
        rememberSession(d.sessionId);
        onReply(d.reply || '', d.citations);
        onDone();
      })
      .catch(onError);
  }

  var canStream = typeof TextDecoder !== 'undefined' &&
                  typeof ReadableStream !== 'undefined';

  /*
   * SSE over POST — EventSource can't send a body, so the response
   * stream is read manually. onError receives a flag saying whether
   * any text had already been shown: if not, the caller can silently
   * retry on the buffered endpoint.
   */
  function callChatStream(msg, onDelta, onCitations, onDone, onError) {
    var started = false;

    fetch(API_BASE + '/v1/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: payload(msg),
    })
      .then(function (res) {
        /* Split, because these fail differently: a status is the
           server's answer and must reach the caller with it attached,
           while a missing body on a 200 is a transport problem the
           buffered endpoint may well survive. */
        if (!res.ok)   return httpError(res);
        if (!res.body) throw new Error('no readable stream');

        var reader  = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer  = '';
        var evName  = '';
        var dataBuf = [];

        function dispatch() {
          if (!dataBuf.length) return;
          var raw = dataBuf.join('\n');
          evName = evName || 'message';
          dataBuf = [];

          var parsed;
          try { parsed = JSON.parse(raw); } catch (e) { evName = ''; return; }

          if (evName === 'delta' && parsed.text) {
            started = true;
            onDelta(parsed.text);
          } else if (evName === 'done') {
            rememberSession(parsed.sessionId);
            /* Known before the first token, but only meaningful once
               there is a reply to attach them to. */
            if (parsed.citations) onCitations(parsed.citations);
          } else if (evName === 'error') {
            /* The server sends a `kind` alongside — an overloaded vendor
               and a rejected API key read identically to a visitor, but
               only one of them is worth waking the tenant up for, so it
               is carried through to the console. */
            var streamErr = new Error(parsed.error || 'stream error');
            streamErr.kind = parsed.kind || 'unknown';
            throw streamErr;
          }
          evName = '';
        }

        function pump() {
          return reader.read().then(function (r) {
            if (r.done) { dispatch(); onDone(); return; }

            buffer += decoder.decode(r.value, { stream: true });

            var nl;
            while ((nl = buffer.indexOf('\n')) !== -1) {
              var line = buffer.slice(0, nl);
              buffer   = buffer.slice(nl + 1);
              if (line.charAt(line.length - 1) === '\r') line = line.slice(0, -1);

              if (line === '')            { dispatch(); continue; }
              if (line.charAt(0) === ':') { continue; }

              var colon = line.indexOf(':');
              var field = colon === -1 ? line : line.slice(0, colon);
              var val   = colon === -1 ? ''   : line.slice(colon + 1);
              if (val.charAt(0) === ' ') val = val.slice(1);

              if (field === 'event')     evName = val;
              else if (field === 'data') dataBuf.push(val);
            }
            return pump();
          });
        }

        return pump();
      })
      .catch(function (err) { onError(err, started); });
  }

  // ── Init ──────────────────────────────────────────────────────
  /** The tenant's line, or the one every bot opened with before there
      was a setting for it. */
  function greetingText() {
    return config.greeting ||
      'Hi there! 👋 I\'m ' + config.name + ', your virtual assistant. How can I help you today?';
  }

  function applyPosition(scope) {
    if (config.position === 'bottom-left') scope.classList.add('ck-left');
    else scope.classList.remove('ck-left');
  }

  function init() {
    var dom = buildDOM();
    document.body.appendChild(dom.root);
    /* Every one of these takes the WRAPPER, not the host: the classes
       they toggle and the custom properties they set have to live inside
       the shadow root, where the host page cannot reach them. */
    applyTheme(dom.wrap);
    applyPosition(dom.wrap);

    watchSystemTheme(dom.wrap);

    /* Set the moment the visitor sends anything, and read by the
       delayed greeting to decide whether it is still wanted. */
    var hasSpoken = false;

    fetchConfig(function (err) {
      /* A 404 is definitive: no bot has this id. A panel that greets and
         then fails on every message is worse than no panel, and the
         person who needs to know is whoever pasted the tag — so unmount
         and say so in the console.

         A transport failure is NOT definitive and must not unmount: the
         Worker may be briefly unreachable, and the defaults above are a
         working widget that will send fine once it is back. */
      if (err && err.status === 404) {
        console.error('[ConverseKit] No bot with id "' + botId + '" — widget not mounted.');
        if (dom.root.parentNode) dom.root.parentNode.removeChild(dom.root);
        return;
      }

      if (!err) {
        applyTheme(dom.wrap);          // recomputes --ck-color-ink for the surface
        applyPosition(dom.wrap);
        applyLogo(dom);
        dom.botName.textContent = config.name;
      }

      /* The greeting waits, the chips wait with it. Showing suggestions
         before the message they answer reads as a menu appearing out of
         nowhere, and a visitor who clicks one during the gap would send
         a question the bot has not said hello to yet.

         A visitor can also get in first — the delay goes up to ten
         seconds, which is long enough to open the panel and type. Then
         the greeting is simply dropped: arriving underneath a question
         it does not answer is worse than not arriving. */
      var greet = function () {
        if (hasSpoken) return;
        appendMessage(dom, greetingText(), 'bot');
        /* Card above chips: the card is what the business IS, the chips
           are what to ask it. Both belong to the opening turn. */
        renderProfileCard(dom);
        renderChips(dom, doSend);
        dom.messages.scrollTop = dom.messages.scrollHeight;
      };
      if (config.greetingDelayMs > 0) setTimeout(greet, config.greetingDelayMs);
      else greet();
    });

    /* Replies that landed while the panel was shut. The badge used to
       read a hardcoded '1' forever; this is the real number, and it is
       announced through the launcher's aria-label because a button's
       label overrides anything nested inside it. */
    var unread = 0;
    function showUnread() {
      dom.badge.textContent = unread > 9 ? '9+' : String(unread);
      if (unread > 0) dom.badge.classList.add('visible');
      else dom.badge.classList.remove('visible');
      dom.bubble.setAttribute('aria-label', unread === 0
        ? 'Open chat'
        : 'Open chat, ' + unread + (unread === 1 ? ' unread message' : ' unread messages'));
    }

    /*
     * Mobile keyboard. iOS Safari does not shrink the layout viewport
     * when the keyboard opens, so on some page configurations the
     * composer simply slides underneath it and the visitor types into
     * something they cannot see. visualViewport is the only API that
     * reports the inset; it is absent on older Android WebViews, where
     * this does nothing at all and nothing breaks.
     *
     * The base offset is READ from the stylesheet rather than assumed:
     * it is 24px on desktop and 16px under the 480px query, and pinning
     * either number here would put the panel in the wrong place on the
     * other one. It is re-measured whenever the keyboard goes away.
     */
    var viewport = window.visualViewport || null;
    var baseBottom = null;

    function onViewport() {
      if (!isOpen || !viewport) return;
      var inset = Math.round(window.innerHeight - (viewport.height + viewport.offsetTop));
      /* A threshold, not a truthiness check: a collapsing URL bar moves
         this by a few pixels and is not a keyboard. */
      if (inset <= 40) {
        dom.wrap.style.bottom = '';
        baseBottom = null;
        return;
      }
      if (baseBottom === null) baseBottom = parseFloat(getComputedStyle(dom.wrap).bottom) || 0;
      dom.wrap.style.bottom = (baseBottom + inset) + 'px';
    }

    function trackViewport() {
      if (!viewport) return;
      viewport.addEventListener('resize', onViewport);
      viewport.addEventListener('scroll', onViewport);
      onViewport();
    }
    function releaseViewport() {
      if (!viewport) return;
      viewport.removeEventListener('resize', onViewport);
      viewport.removeEventListener('scroll', onViewport);
      dom.wrap.style.bottom = '';
      baseBottom = null;
    }

    function openPanel() {
      isOpen = true;
      dom.panel.classList.add('open');
      dom.wrap.classList.add('is-open');
      dom.bubble.setAttribute('aria-expanded', 'true');
      unread = 0;
      showUnread();
      trackViewport();
      setTimeout(function () { dom.input.focus(); }, 250);
    }
    function closePanel() {
      /* Where focus is has to be read BEFORE the panel is hidden. A
         closed panel is visibility:hidden now, and a browser drops focus
         from a hidden element to <body> — the visitor's place in the tab
         order is simply gone. Handing it back to the launcher restores
         it; doing so unconditionally would instead YANK focus out of
         whatever the visitor was doing when a host page closes the panel
         from its own button through window.ConverseKit.close(). */
      var returnFocus = dom.panel.contains(activeNode(dom));

      isOpen = false;
      dom.panel.classList.remove('open');
      dom.wrap.classList.remove('is-open');
      dom.bubble.setAttribute('aria-expanded', 'false');
      releaseViewport();

      if (returnFocus) dom.bubble.focus();
    }

    dom.bubble.addEventListener('click', function () { isOpen ? closePanel() : openPanel(); });
    dom.closeBtn.addEventListener('click', closePanel);
    /* Still reaches the document from inside the shadow root: keydown is
       composed, so it retargets at the boundary but keeps bubbling. */
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen) closePanel(); });

    /* Public API. Deliberately tiny — this is a commitment to every site
       that has already pasted the tag. It exists because opening the chat
       from the host page's own "Chat with us" button is the one thing
       everybody asks for, and a closure over openPanel made it impossible. */
    window.ConverseKit = {
      open: openPanel,
      close: closePanel,
      toggle: function () { isOpen ? closePanel() : openPanel(); },
      isOpen: function () { return isOpen; },
      botId: botId,
      version: WIDGET_VERSION
    };

    /* FIX #1b — auto-resize without showing the drag handle */
    dom.input.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 96) + 'px';
      dom.sendBtn.disabled = this.value.trim() === '' || isTyping;
    });
    dom.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!dom.sendBtn.disabled) doSend(dom.input.value.trim());
      }
    });
    dom.sendBtn.addEventListener('click', function () {
      var t = dom.input.value.trim();
      if (t) doSend(t);
    });
    dom.sendBtn.disabled = true;

    function doSend(text) {
      if (!text || isTyping) return;
      hasSpoken = true;
      dom.chips.style.display = 'none';
      dom.input.value = '';
      dom.input.style.height = 'auto';
      dom.sendBtn.disabled = true;
      appendMessage(dom, text, 'user');
      isTyping = true;
      /* Only the dots are optional. isTyping still guards re-entry, and
         every remove('visible') below stays unconditional — turning the
         setting off mid-conversation must not strand a visible one. */
      if (config.showTyping) dom.typing.classList.add('visible');
      /* scroll-behavior:smooth off for the duration. append() assigns
         scrollTop on every delta and each assignment restarts the smooth
         animation from wherever the last one got to, so it never arrives
         — that is the stutter visible during a long reply. */
      dom.messages.classList.add('ck-jump');
      dom.messages.scrollTop = dom.messages.scrollHeight;

      var bubble = null;

      function settle() {
        dom.typing.classList.remove('visible');
        dom.messages.classList.remove('ck-jump');
        isTyping = false;
        /* Lifts the streaming bubble's aria-live="off" and reconciles its
           markup, so the finished reply is announced exactly once. */
        if (bubble) bubble.done();
        dom.sendBtn.disabled = dom.input.value.trim() === '';
        if (!isOpen) { unread++; showUnread(); }
      }

      /* First delta replaces the typing dots with a live bubble. */
      function onDelta(chunk) {
        if (!bubble) {
          dom.typing.classList.remove('visible');
          bubble = beginBotMessage(dom);
        }
        bubble.append(chunk);
      }

      /* 429 is the ONE status whose server copy is written for a visitor
         and actionable by one: they sent too many messages and waiting
         fixes it. Every other failure — a bot id that does not exist, an
         origin missing from the allow list, a vendor outage — is the
         site owner's, and naming it in the transcript tells the visitor
         nothing they can act on. Those get the fallback contact route,
         and the real reason goes to the console for whoever pasted the
         tag, which is the only person who can do anything about it. */
      function showError(err) {
        if (bubble && bubble.isEmpty()) { bubble.remove(); bubble = null; }

        var msg;
        if (err && err.status === 429) {
          msg = err.message || 'Too many messages — please slow down.';
        } else {
          if (err) {
            console.error('[ConverseKit] chat failed' +
              (err.status ? ' (HTTP ' + err.status + ')' : '') +
              (err.kind ? ' [' + err.kind + ']' : '') + ': ' + err.message);
          }
          msg = 'I\'m having a moment — please reach us directly.';
          if (config.contact) msg += '\n📞 ' + config.contact;
        }

        appendMessage(dom, msg, 'error');
        settle();
      }

      function onCitations(titles) {
        if (!config.showCitations || !bubble) return;
        bubble.cite(titles);
      }

      function bufferedSend() {
        callChat(text,
          function (reply, titles) {
            dom.typing.classList.remove('visible');
            var node = appendMessage(dom, reply, 'bot');
            if (config.showCitations && titles && titles.length) appendCitations(node, titles);
          },
          settle,
          showError
        );
      }

      if (!canStream) { bufferedSend(); return; }

      callChatStream(text, onDelta, onCitations, settle, function (err, started) {
        /* Text is already on screen. A retry would render the reply a
           second time underneath the half-finished first one. */
        if (started) {
          console.warn('[ConverseKit] stream interrupted:', err);
          settle();
          return;
        }

        /* A 4xx is the server's considered answer, not a transport
           failure — a rate limit, a locked origin, an unknown bot. The
           buffered endpoint runs the same preflight and will say the
           same thing, so replaying it only spends a second request; and
           against CHAT_LIMITER the retry is itself another message off
           the visitor's allowance, which is how a rate-limited visitor
           used to get told "I'm having a moment" instead of being told
           they were rate-limited. Only a transport failure or a 5xx is
           worth falling back for. */
        if (err && err.status >= 400 && err.status < 500) { showError(err); return; }

        // Nothing rendered yet — the visitor never saw the failure, so
        // retry quietly on the buffered endpoint.
        bufferedSend();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();


