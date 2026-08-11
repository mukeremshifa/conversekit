/*!
 * ConverseKit Chat Widget v0.8.0
 * Drop-in AI chatbot for any website.
 * Usage: <script src="widget.js" data-bot-id="YOUR_BOT_ID" defer></script>
 *
 * Streams replies over SSE, falling back to the buffered /v1/chat
 * endpoint on any transport failure.
 *
 * Once loaded it exposes window.ConverseKit:
 *   open() close() toggle() isOpen() -> boolean
 *   botId  version
 * so a host page can drive the panel from its own button.
 */
(function () {
  'use strict';

  var API_BASE = 'https://conversekit.mukeremshifa.workers.dev';
  var WIDGET_VERSION = '0.8.0';

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
  var config   = { name: 'Assistant', contact: null, primaryColor: '#EEBA2B', suggestions: null };
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

  /** Same hue and saturation, walked darker until it clears 4.5:1 on
      the white panel. Returns the colour itself when it already does. */
  function inkVariant(hex) {
    var rgb = hexToRgb(hex);
    if (!rgb) return INK;
    if (ratio(luminance(rgb), 1) >= 4.5) return hex;
    var hsl = rgbToHsl(rgb);
    for (var l = hsl[2]; l > 0.04; l -= 0.01) {
      var candidate = hslToRgb(hsl[0], hsl[1], l);
      if (ratio(luminance(candidate), 1) >= 4.5) return toHex(candidate);
    }
    return INK;
  }

  function applyColor(root) {
    root.style.setProperty('--ck-color', config.primaryColor);
    root.style.setProperty('--ck-on-color', onColor(config.primaryColor));
    root.style.setProperty('--ck-color-ink', inkVariant(config.primaryColor));
  }

  // ── Styles ────────────────────────────────────────────────────
  var CSS = [
    /* Instrument Sans, the face the rest of ConverseKit uses. Scoped family
       name so it cannot collide with a host page's own fonts, swap so a slow
       font never delays first paint, and a full system stack behind it. */
    '@font-face{font-family:"ck-sans";src:url("' + ASSET_BASE + '/fonts/instrument-sans-latin.woff2") format("woff2");font-weight:400 700;font-style:normal;font-display:swap;}',

    '#aicb-root{--ck-ink:#0A0A0C;--ck-muted:#5B5B66;--ck-faint:#6E6E78;--ck-line:#E8E8EC;--ck-surface:#FFFFFF;--ck-sunk:#FAFAFA;--ck-chip:#F2F2F4;}',
    '#aicb-root *,#aicb-root *::before,#aicb-root *::after{box-sizing:border-box;margin:0;padding:0;}',
    '#aicb-root{position:fixed;bottom:24px;right:24px;z-index:2147483647;font-family:"ck-sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.5;font-weight:460;-webkit-font-smoothing:antialiased;}',

    /* Launcher */
    '#aicb-bubble{width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;background:var(--ck-color);box-shadow:0 6px 24px -6px rgba(10,10,12,.45);transition:transform .2s ease,box-shadow .2s ease;outline:none;position:relative;}',
    '#aicb-bubble:hover{transform:scale(1.06);box-shadow:0 10px 30px -8px rgba(10,10,12,.55);}',
    '#aicb-bubble:focus-visible{outline:3px solid var(--ck-color-ink);outline-offset:3px;}',
    '#aicb-bubble-icon{transition:opacity .15s,transform .15s;display:flex;}',
    '#aicb-bubble-icon svg{width:26px;height:26px;fill:none;stroke:var(--ck-on-color);stroke-width:2;stroke-linecap:round;stroke-linejoin:round;display:block;}',
    '#aicb-bubble-close{position:absolute;opacity:0;transform:scale(.7) rotate(-90deg);transition:opacity .15s,transform .15s;display:flex;}',
    '#aicb-bubble-close svg{width:20px;height:20px;display:block;fill:none;stroke:var(--ck-on-color);stroke-width:2.5;stroke-linecap:round;}',
    '#aicb-root.is-open #aicb-bubble-icon{opacity:0;transform:scale(.7) rotate(90deg);}',
    '#aicb-root.is-open #aicb-bubble-close{opacity:1;transform:scale(1) rotate(0);}',

    /* Unread badge */
    '#aicb-badge{position:absolute;top:-1px;right:-1px;min-width:19px;height:19px;border-radius:10px;background:#B42318;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 5px;opacity:0;transform:scale(0);transition:opacity .2s,transform .2s;border:2px solid #fff;}',
    '#aicb-badge.visible{opacity:1;transform:scale(1);}',

    /* Panel */
    '#aicb-panel{position:absolute;bottom:70px;right:0;width:380px;max-width:calc(100vw - 32px);background:var(--ck-surface);border:1px solid var(--ck-line);border-radius:16px;box-shadow:0 24px 60px -18px rgba(10,10,12,.28),0 2px 8px -2px rgba(10,10,12,.10);display:flex;flex-direction:column;overflow:hidden;transform-origin:bottom right;transition:opacity .22s cubic-bezier(.2,.7,.3,1),transform .22s cubic-bezier(.2,.7,.3,1);opacity:0;transform:scale(.96) translateY(10px);pointer-events:none;}',
    '#aicb-panel.open{opacity:1;transform:none;pointer-events:all;}',

    /* Header — neutral, so the tenant colour reads as an accent rather than
       a slab. The avatar disc and the send button carry it instead. */
    '#aicb-header{background:var(--ck-surface);border-bottom:1px solid var(--ck-line);padding:13px 12px 13px 15px;display:flex;align-items:center;gap:11px;color:var(--ck-ink);flex-shrink:0;}',
    '#aicb-avatar{width:34px;height:34px;border-radius:50%;background:var(--ck-color);display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '#aicb-avatar svg{width:18px;height:18px;fill:none;stroke:var(--ck-on-color);stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',
    '#aicb-avatar svg .ck-eye{fill:var(--ck-on-color);stroke:none;}',
    '#aicb-header-text{flex:1;min-width:0;}',
    '#aicb-bot-name{font-size:14.5px;font-weight:640;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.015em;line-height:1.3;}',
    '#aicb-status{font-size:11.5px;color:var(--ck-muted);display:flex;align-items:center;gap:5px;margin-top:1px;}',
    '#aicb-status-dot{width:6px;height:6px;border-radius:50%;background:#157347;display:inline-block;flex-shrink:0;}',
    '#aicb-close{width:30px;height:30px;border-radius:8px;border:none;background:transparent;color:var(--ck-faint);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s,color .15s;}',
    '#aicb-close:hover{background:var(--ck-chip);color:var(--ck-ink);}',
    '#aicb-close:focus-visible{outline:2px solid var(--ck-color-ink);outline-offset:1px;}',
    '#aicb-close svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;display:block;}',

    /* Transcript */
    '#aicb-messages{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:16px 14px;display:flex;flex-direction:column;gap:8px;min-height:210px;max-height:420px;scroll-behavior:smooth;background:var(--ck-sunk);}',
    '#aicb-messages::-webkit-scrollbar{width:5px;}',
    '#aicb-messages::-webkit-scrollbar-track{background:transparent;}',
    '#aicb-messages::-webkit-scrollbar-thumb{background:#D6D6DC;border-radius:4px;}',

    /* Bubbles */
    '#aicb-root .ck-msg{max-width:82%;padding:10px 13px;border-radius:14px;font-size:14px;line-height:1.6;word-break:break-word;animation:ck-pop .2s cubic-bezier(.2,.7,.3,1);}',
    '@keyframes ck-pop{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}',
    '#aicb-root .ck-msg.bot{background:var(--ck-surface);color:var(--ck-ink);border:1px solid var(--ck-line);border-bottom-left-radius:5px;align-self:flex-start;}',
    '#aicb-root .ck-msg.user{background:var(--ck-color);color:var(--ck-on-color);border-bottom-right-radius:5px;align-self:flex-end;font-weight:500;}',
    '#aicb-root .ck-msg.error{background:#FEF3F2;color:#B42318;border:1px solid #FDA29B;align-self:flex-start;font-size:13px;white-space:pre-line;}',

    /* Markdown output */
    '#aicb-root .ck-msg p{margin:0;}',
    '#aicb-root .ck-msg p + p,#aicb-root .ck-msg p + ul,#aicb-root .ck-msg p + ol,#aicb-root .ck-msg ul + p,#aicb-root .ck-msg ol + p{margin-top:8px;}',
    '#aicb-root .ck-msg ul,#aicb-root .ck-msg ol{margin:0;padding-left:19px;}',
    '#aicb-root .ck-msg li{margin:2px 0;}',
    '#aicb-root .ck-msg strong{font-weight:680;}',
    '#aicb-root .ck-msg em{font-style:italic;}',
    '#aicb-root .ck-msg code{background:rgba(10,10,12,.06);padding:1px 5px;border-radius:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.88em;}',
    '#aicb-root .ck-msg.user code{background:rgba(10,10,12,.12);}',
    '#aicb-root .ck-msg a{color:inherit;text-decoration:underline;text-underline-offset:2px;}',
    '#aicb-root .ck-msg.bot a{color:var(--ck-color-ink);}',

    /* Typing */
    '#aicb-typing{display:none;align-self:flex-start;background:var(--ck-surface);border:1px solid var(--ck-line);border-radius:14px;border-bottom-left-radius:5px;padding:12px 14px;gap:4px;align-items:center;}',
    '#aicb-typing.visible{display:flex;}',
    '#aicb-root .ck-dot{width:6px;height:6px;border-radius:50%;background:#C4C4CC;animation:ck-bounce 1.4s infinite ease-in-out;}',
    '#aicb-root .ck-dot:nth-child(2){animation-delay:.16s;}',
    '#aicb-root .ck-dot:nth-child(3){animation-delay:.32s;}',
    '@keyframes ck-bounce{0%,60%,100%{transform:translateY(0);}30%{transform:translateY(-5px);}}',

    /* Chips — quiet neutrals that sit under the greeting inside the
       transcript, instead of a coloured rail pinned to the base. */
    '#aicb-chips{display:flex;flex-wrap:wrap;gap:6px;align-self:flex-start;max-width:100%;margin-top:2px;}',
    '#aicb-root .ck-chip{background:var(--ck-surface);border:1px solid var(--ck-line);color:var(--ck-muted);border-radius:9px;padding:7px 11px;font-size:12.5px;font-weight:560;cursor:pointer;transition:border-color .15s,color .15s;text-align:left;font-family:inherit;line-height:1.35;}',
    '#aicb-root .ck-chip:hover{border-color:var(--ck-color-ink);color:var(--ck-ink);}',
    '#aicb-root .ck-chip:focus-visible{outline:2px solid var(--ck-color-ink);outline-offset:2px;}',

    /* Composer */
    '#aicb-footer{border-top:1px solid var(--ck-line);padding:11px 12px;display:flex;gap:9px;align-items:flex-end;background:var(--ck-surface);flex-shrink:0;}',
    '#aicb-input{flex:1;resize:none;overflow:hidden;border:1px solid var(--ck-line);border-radius:10px;padding:10px 12px;font-size:14px;font-family:inherit;font-weight:460;color:var(--ck-ink);background:var(--ck-surface);outline:none;transition:border-color .15s,box-shadow .15s;max-height:96px;line-height:1.5;display:block;}',
    '#aicb-input::placeholder{color:var(--ck-faint);}',
    '#aicb-input:focus{border-color:var(--ck-color-ink);box-shadow:0 0 0 3px color-mix(in srgb,var(--ck-color) 20%,transparent);}',
    '#aicb-send{width:38px;height:38px;border-radius:10px;border:none;background:var(--ck-color);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:opacity .15s,transform .15s;}',
    '#aicb-send:hover:not(:disabled){transform:scale(1.05);}',
    '#aicb-send:active:not(:disabled){transform:scale(.96);}',
    '#aicb-send:disabled{opacity:.3;cursor:not-allowed;}',
    '#aicb-send:focus-visible{outline:2px solid var(--ck-color-ink);outline-offset:2px;}',
    '#aicb-send svg{width:16px;height:16px;fill:none;stroke:var(--ck-on-color);stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;}',

    /* Attribution */
    '#aicb-powered{text-align:center;font-size:10.5px;color:var(--ck-faint);padding:0 0 10px;background:var(--ck-surface);flex-shrink:0;letter-spacing:.01em;}',
    '#aicb-powered a{color:var(--ck-muted);text-decoration:none;font-weight:560;transition:color .15s;}',
    '#aicb-powered a:hover{color:var(--ck-ink);}',

    '@media(max-width:480px){',
    '#aicb-root{bottom:16px;right:16px;}',
    '#aicb-panel{width:calc(100vw - 32px);right:-16px;border-radius:14px;}',
    '#aicb-messages{min-height:260px;max-height:calc(100svh - 260px);}',
    '}',
    '@media(prefers-reduced-motion:reduce){',
    '#aicb-root *{animation:none!important;transition:none!important;}',
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
      /* Bare URLs, but not ones already inside an href we just built. */
      .replace(/(^|[\s(])((?:https?:\/\/)[^\s<>"']+)/g, function (m, pre, url) {
        var safe = safeUrl(url);
        return safe ? pre + '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + safe + '</a>' : m;
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

    function flushPara() {
      if (!para.length) return;
      html += '<p>' + renderInline(para.join('<br>')) + '</p>';
      para = [];
    }
    function closeList() {
      if (listType) { html += '</' + listType + '>'; listType = null; }
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
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
  function buildDOM() {
    var style = el('style', { innerHTML: CSS });

    var bubbleIcon  = el('span', { id: 'aicb-bubble-icon',  innerHTML: ICON_CHAT  });
    var bubbleClose = el('span', { id: 'aicb-bubble-close', innerHTML: ICON_CLOSE });
    var badge  = el('div',    { id: 'aicb-badge', textContent: '1' });
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

    var dot1    = el('div', { className: 'ck-dot' });
    var dot2    = el('div', { className: 'ck-dot' });
    var dot3    = el('div', { className: 'ck-dot' });
    var typing  = el('div', { id: 'aicb-typing' }, [dot1, dot2, dot3]);
    var messages = el('div', { id: 'aicb-messages', role: 'log', 'aria-live': 'polite' }, [typing]);

    /* Created detached: renderChips places it in the transcript, under
       the greeting, so the suggestions read as part of the conversation
       rather than a toolbar bolted to the bottom of the panel. */
    var chips   = el('div',      { id: 'aicb-chips' });
    var input   = el('textarea', { id: 'aicb-input', placeholder: 'Type a message…', rows: '1', 'aria-label': 'Message' });
    var sendBtn = el('button',   { id: 'aicb-send',  'aria-label': 'Send', innerHTML: ICON_SEND });
    var footer  = el('div', { id: 'aicb-footer' }, [input, sendBtn]);
    var powered = el('div', { id: 'aicb-powered',
      innerHTML: 'Powered by <a href="https://conversekit.io" target="_blank" rel="noopener">ConverseKit</a>' });

    var panel = el('div', { id: 'aicb-panel', role: 'dialog', 'aria-label': 'Chat assistant', 'aria-modal': 'true' },
      [header, messages, footer, powered]);

    var root = el('div', { id: 'aicb-root' }, [style, panel, bubble]);

    return { root, panel, bubble, badge, messages, typing, chips, input, sendBtn, botName, closeBtn };
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
  }

  /* Empty bot bubble that text is streamed into. Returns a handle so
     deltas can be appended without rebuilding the node. */
  function beginBotMessage(dom) {
    var div = el('div', { className: 'ck-msg bot' });
    dom.messages.insertBefore(div, dom.typing);
    var raw = '';
    return {
      append: function (text) {
        var stick = nearBottom(dom.messages);
        raw += text;
        /* Re-render the whole bubble each delta. A marker split across
           chunks ("**bo") briefly shows literally, then resolves — the
           alternative, holding text back until the stream ends, costs
           the streaming effect entirely. */
        div.innerHTML = renderMarkdown(raw);
        if (stick) dom.messages.scrollTop = dom.messages.scrollHeight;
      },
      isEmpty: function () { return raw === ''; },
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
    var chips = (config.suggestions && config.suggestions.length)
      ? config.suggestions.slice(0, 6)
      : DEFAULT_CHIPS;
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

  // ── API ───────────────────────────────────────────────────────
  function fetchConfig(cb) {
    fetch(API_BASE + '/v1/bots/' + botId + '/health')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.name)         config.name         = d.name;
        if (d.contact)      config.contact      = d.contact;
        if (d.primaryColor) config.primaryColor = d.primaryColor;
        if (Array.isArray(d.suggestions)) config.suggestions = d.suggestions;
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
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) { rememberSession(d.sessionId); onReply(d.reply || ''); onDone(); })
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
  function callChatStream(msg, onDelta, onDone, onError) {
    var started = false;

    fetch(API_BASE + '/v1/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: payload(msg),
    })
      .then(function (res) {
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);

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
          } else if (evName === 'error') {
            throw new Error(parsed.error || 'stream error');
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
  function init() {
    var dom = buildDOM();
    document.body.appendChild(dom.root);
    applyColor(dom.root);

    fetchConfig(function (err) {
      if (!err) {
        applyColor(dom.root);
        dom.botName.textContent = config.name;
      }
      appendMessage(dom, 'Hi there! 👋 I\'m ' + config.name + ', your virtual assistant. How can I help you today?', 'bot');
      renderChips(dom, doSend);
    });

    function openPanel() {
      isOpen = true;
      dom.panel.classList.add('open');
      dom.root.classList.add('is-open');
      dom.bubble.setAttribute('aria-expanded', 'true');
      dom.badge.classList.remove('visible');
      setTimeout(function () { dom.input.focus(); }, 250);
    }
    function closePanel() {
      isOpen = false;
      dom.panel.classList.remove('open');
      dom.root.classList.remove('is-open');
      dom.bubble.setAttribute('aria-expanded', 'false');
    }

    dom.bubble.addEventListener('click', function () { isOpen ? closePanel() : openPanel(); });
    dom.closeBtn.addEventListener('click', closePanel);
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
      dom.chips.style.display = 'none';
      dom.input.value = '';
      dom.input.style.height = 'auto';
      dom.sendBtn.disabled = true;
      appendMessage(dom, text, 'user');
      isTyping = true;
      dom.typing.classList.add('visible');
      dom.messages.scrollTop = dom.messages.scrollHeight;

      var bubble = null;

      function settle() {
        dom.typing.classList.remove('visible');
        isTyping = false;
        dom.sendBtn.disabled = dom.input.value.trim() === '';
        if (!isOpen) dom.badge.classList.add('visible');
      }

      /* First delta replaces the typing dots with a live bubble. */
      function onDelta(chunk) {
        if (!bubble) {
          dom.typing.classList.remove('visible');
          bubble = beginBotMessage(dom);
        }
        bubble.append(chunk);
      }

      function showError() {
        if (bubble && bubble.isEmpty()) { bubble.remove(); bubble = null; }
        var msg = 'I\'m having a moment — please reach us directly.';
        if (config.contact) msg += '\n📞 ' + config.contact;
        appendMessage(dom, msg, 'error');
        settle();
      }

      function bufferedSend() {
        callChat(text,
          function (reply) {
            dom.typing.classList.remove('visible');
            appendMessage(dom, reply, 'bot');
          },
          settle,
          showError
        );
      }

      if (!canStream) { bufferedSend(); return; }

      callChatStream(text, onDelta, settle, function (err, started) {
        // Nothing rendered yet — the visitor never saw the failure, so
        // retry quietly on the buffered endpoint.
        if (!started) { bufferedSend(); return; }
        console.warn('[ConverseKit] stream interrupted:', err);
        settle();
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();


