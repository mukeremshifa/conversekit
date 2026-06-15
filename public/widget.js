/*!
 * ConverseKit Chat Widget v0.2.0
 * Drop-in AI chatbot for any website.
 * Usage: <script src="widget.js" data-bot-id="YOUR_BOT_ID" defer></script>
 */
(function () {
  'use strict';

  // ──────────────────────────────────────────────────────────────
  // 0. CONFIG  — change API_BASE to your deployed Worker URL
  // ──────────────────────────────────────────────────────────────
  var API_BASE = 'https://conversekit.mukeremshifa.workers.dev';

  // ──────────────────────────────────────────────────────────────
  // 1. BOOTSTRAP — read botId, generate / restore sessionId
  // ──────────────────────────────────────────────────────────────
  var scriptTag = document.currentScript ||
    (function () {
      var scripts = document.getElementsByTagName('script');
      return scripts[scripts.length - 1];
    })();

  var botId = scriptTag && scriptTag.getAttribute('data-bot-id');
  if (!botId) {
    console.warn('[ConverseKit] No data-bot-id found on script tag. Widget will not load.');
    return;
  }

  var SESSION_KEY = 'ck_session_' + botId;
  var sessionId = sessionStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = 'ck-' + Math.random().toString(36).slice(2, 11) + '-' + Date.now();
    sessionStorage.setItem(SESSION_KEY, sessionId);
  }

  // ──────────────────────────────────────────────────────────────
  // 2. STATE
  // ──────────────────────────────────────────────────────────────
  var config = {
    name: 'Assistant',
    contact: null,
    primaryColor: '#2563eb',
  };
  var isOpen = false;
  var isTyping = false;

  // ──────────────────────────────────────────────────────────────
  // 3. STYLES — all scoped under #aicb-root
  // ──────────────────────────────────────────────────────────────
  var CSS = [
    /* Reset & root */
    '#aicb-root *,#aicb-root *::before,#aicb-root *::after{box-sizing:border-box;margin:0;padding:0;}',
    '#aicb-root{position:fixed;bottom:24px;right:24px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.5;}',

    /* Bubble button */
    '#aicb-bubble{width:56px;height:56px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.18);transition:transform .2s ease,box-shadow .2s ease;background:var(--ck-color);outline:none;}',
    '#aicb-bubble:hover{transform:scale(1.08);box-shadow:0 6px 24px rgba(0,0,0,.22);}',
    '#aicb-bubble:focus-visible{outline:3px solid var(--ck-color);outline-offset:3px;}',
    '#aicb-bubble svg{width:26px;height:26px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',

    /* Unread badge */
    '#aicb-badge{position:absolute;top:-3px;right:-3px;width:18px;height:18px;border-radius:50%;background:#ef4444;color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;opacity:0;transform:scale(0);transition:opacity .2s,transform .2s;}',
    '#aicb-badge.visible{opacity:1;transform:scale(1);}',

    /* Panel */
    '#aicb-panel{position:absolute;bottom:68px;right:0;width:360px;max-width:calc(100vw - 32px);background:#fff;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.14);display:flex;flex-direction:column;overflow:hidden;transform-origin:bottom right;transition:opacity .22s ease,transform .22s ease;opacity:0;transform:scale(.92) translateY(12px);pointer-events:none;}',
    '#aicb-panel.open{opacity:1;transform:scale(1) translateY(0);pointer-events:all;}',

    /* Header */
    '#aicb-header{background:var(--ck-color);padding:14px 16px;display:flex;align-items:center;gap:10px;color:#fff;}',
    '#aicb-avatar{width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '#aicb-avatar svg{width:18px;height:18px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',
    '#aicb-header-text{flex:1;min-width:0;}',
    '#aicb-bot-name{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
    '#aicb-status{font-size:11px;opacity:.82;display:flex;align-items:center;gap:5px;}',
    '#aicb-status-dot{width:7px;height:7px;border-radius:50%;background:#4ade80;display:inline-block;flex-shrink:0;}',
    '#aicb-close{background:none;border:none;cursor:pointer;color:#fff;opacity:.75;line-height:1;padding:4px;border-radius:6px;transition:opacity .15s;flex-shrink:0;}',
    '#aicb-close:hover{opacity:1;}',
    '#aicb-close svg{width:18px;height:18px;display:block;}',

    /* Messages */
    '#aicb-messages{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;min-height:280px;max-height:360px;scroll-behavior:smooth;}',
    '#aicb-messages::-webkit-scrollbar{width:4px;}',
    '#aicb-messages::-webkit-scrollbar-track{background:transparent;}',
    '#aicb-messages::-webkit-scrollbar-thumb{background:#d1d5db;border-radius:4px;}',

    /* Message bubbles */
    '.ck-msg{max-width:82%;padding:10px 13px;border-radius:16px;font-size:14px;line-height:1.55;word-break:break-word;animation:ck-pop .18s ease;}',
    '@keyframes ck-pop{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:none;}}',
    '.ck-msg.bot{background:#f3f4f6;color:#111827;border-bottom-left-radius:4px;align-self:flex-start;}',
    '.ck-msg.user{background:var(--ck-color);color:#fff;border-bottom-right-radius:4px;align-self:flex-end;}',
    '.ck-msg.error{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;align-self:flex-start;}',

    /* Typing indicator */
    '#aicb-typing{display:none;align-self:flex-start;background:#f3f4f6;border-radius:16px;border-bottom-left-radius:4px;padding:11px 14px;gap:5px;align-items:center;}',
    '#aicb-typing.visible{display:flex;}',
    '.ck-dot{width:7px;height:7px;border-radius:50%;background:#9ca3af;animation:ck-bounce 1.2s infinite ease-in-out;}',
    '.ck-dot:nth-child(2){animation-delay:.2s;}',
    '.ck-dot:nth-child(3){animation-delay:.4s;}',
    '@keyframes ck-bounce{0%,80%,100%{transform:scale(.7);}40%{transform:scale(1);}}',

    /* Input area */
    '#aicb-footer{border-top:1px solid #e5e7eb;padding:10px 12px;display:flex;gap:8px;align-items:flex-end;background:#fff;}',
    '#aicb-input{flex:1;resize:none;border:1.5px solid #e5e7eb;border-radius:10px;padding:9px 12px;font-size:14px;font-family:inherit;color:#111827;background:#fff;outline:none;transition:border-color .15s;max-height:96px;overflow-y:auto;line-height:1.5;}',
    '#aicb-input::placeholder{color:#9ca3af;}',
    '#aicb-input:focus{border-color:var(--ck-color);}',
    '#aicb-send{width:38px;height:38px;border-radius:10px;border:none;background:var(--ck-color);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:opacity .15s,transform .15s;margin-bottom:1px;}',
    '#aicb-send:hover:not(:disabled){opacity:.88;transform:scale(1.05);}',
    '#aicb-send:disabled{opacity:.45;cursor:not-allowed;}',
    '#aicb-send svg{width:17px;height:17px;fill:none;stroke:#fff;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;}',

    /* Powered-by */
    '#aicb-powered{text-align:center;font-size:10px;color:#9ca3af;padding:5px 0 10px;letter-spacing:.02em;}',
    '#aicb-powered a{color:inherit;text-decoration:none;}',
    '#aicb-powered a:hover{color:#6b7280;}',

    /* Mobile */
    '@media(max-width:480px){',
    '#aicb-root{bottom:16px;right:16px;}',
    '#aicb-panel{width:calc(100vw - 32px);right:-16px;}',
    '#aicb-messages{min-height:240px;max-height:calc(100vh - 260px);}',
    '}',
  ].join('\n');

  // ──────────────────────────────────────────────────────────────
  // 4. DOM BUILDER
  // ──────────────────────────────────────────────────────────────
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'className') node.className = attrs[k];
      else if (k === 'innerHTML') node.innerHTML = attrs[k];
      else if (k === 'textContent') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    if (children) children.forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  /* SVG icons as inline strings */
  var ICON_CHAT = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_BOT  = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M12 2v4M8 11V7a4 4 0 0 1 8 0v4"/><circle cx="9" cy="16" r="1" fill="#fff"/><circle cx="15" cy="16" r="1" fill="#fff"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  var ICON_SEND  = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

  function buildDOM() {
    /* Style injection */
    var style = el('style', { innerHTML: CSS });

    /* Bubble */
    var badge  = el('div',    { id: 'aicb-badge', textContent: '1' });
    var bubble = el('button', { id: 'aicb-bubble', 'aria-label': 'Open chat', innerHTML: ICON_CHAT });
    bubble.appendChild(badge);

    /* Header */
    var avatar     = el('div', { id: 'aicb-avatar',       innerHTML: ICON_BOT });
    var botName    = el('div', { id: 'aicb-bot-name',     textContent: config.name });
    var statusDot  = el('span',{ id: 'aicb-status-dot' });
    var statusTxt  = el('span',{ textContent: 'Online' });
    var status     = el('div', { id: 'aicb-status' }, [statusDot, statusTxt]);
    var headerText = el('div', { id: 'aicb-header-text' }, [botName, status]);
    var closeBtn   = el('button', { id: 'aicb-close', 'aria-label': 'Close chat', innerHTML: ICON_CLOSE });
    var header     = el('div', { id: 'aicb-header' }, [avatar, headerText, closeBtn]);

    /* Messages */
    var dot1     = el('div', { className: 'ck-dot' });
    var dot2     = el('div', { className: 'ck-dot' });
    var dot3     = el('div', { className: 'ck-dot' });
    var typing   = el('div', { id: 'aicb-typing' }, [dot1, dot2, dot3]);
    var messages = el('div', { id: 'aicb-messages' }, [typing]);

    /* Footer */
    var input    = el('textarea', { id: 'aicb-input', placeholder: 'Type a message…', rows: '1', 'aria-label': 'Message' });
    var sendBtn  = el('button',   { id: 'aicb-send', 'aria-label': 'Send', innerHTML: ICON_SEND });
    var footer   = el('div', { id: 'aicb-footer' }, [input, sendBtn]);

    /* Powered by */
    var powered = el('div', { id: 'aicb-powered', innerHTML: 'Powered by <a href="https://conversekit.io" target="_blank" rel="noopener">ConverseKit</a>' });

    /* Panel */
    var panel = el('div', { id: 'aicb-panel', role: 'dialog', 'aria-label': 'Chat with us', 'aria-modal': 'true' },
      [header, messages, footer, powered]);

    /* Root */
    var root = el('div', { id: 'aicb-root' }, [style, panel, bubble]);

    return { root, panel, bubble, badge, messages, typing, input, sendBtn, botName };
  }

  // ──────────────────────────────────────────────────────────────
  // 5. THEMING
  // ──────────────────────────────────────────────────────────────
  function applyColor(root, color) {
    root.style.setProperty('--ck-color', color);
  }

  // ──────────────────────────────────────────────────────────────
  // 6. MESSAGE RENDERING
  // ──────────────────────────────────────────────────────────────
  function appendMessage(messages, typing, text, role) {
    var div = el('div', { className: 'ck-msg ' + role, textContent: text });
    messages.insertBefore(div, typing);
    messages.scrollTop = messages.scrollHeight;
    return div;
  }

  // ──────────────────────────────────────────────────────────────
  // 7. API CALLS
  // ──────────────────────────────────────────────────────────────
  function fetchConfig(onDone) {
    fetch(API_BASE + '/v1/bots/' + botId + '/health')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.name)         config.name         = data.name;
        if (data.contact)      config.contact      = data.contact;
        if (data.primaryColor) config.primaryColor = data.primaryColor;
        onDone(null, config);
      })
      .catch(function (err) { onDone(err); });
  }

  function sendMessage(message, onChunk, onDone, onError) {
    fetch(API_BASE + '/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: botId, message: message, sessionId: sessionId }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        onChunk(data.reply || '');
        onDone();
      })
      .catch(function (err) { onError(err); });
  }

  // ──────────────────────────────────────────────────────────────
  // 8. WIDGET CONTROLLER
  // ──────────────────────────────────────────────────────────────
  function init() {
    var dom = buildDOM();
    document.body.appendChild(dom.root);
    applyColor(dom.root, config.primaryColor);

    /* ── Fetch bot config & apply theme ── */
    fetchConfig(function (err) {
      if (!err) {
        applyColor(dom.root, config.primaryColor);
        dom.botName.textContent = config.name;
      }
      /* Show greeting after config loads */
      var greeting = 'Hi! 👋 I\'m ' + config.name + '. How can I help you today?';
      appendMessage(dom.messages, dom.typing, greeting, 'bot');
    });

    /* ── Toggle panel open/close ── */
    function openPanel() {
      isOpen = true;
      dom.panel.classList.add('open');
      dom.bubble.setAttribute('aria-expanded', 'true');
      dom.badge.classList.remove('visible');
      dom.input.focus();
    }

    function closePanel() {
      isOpen = false;
      dom.panel.classList.remove('open');
      dom.bubble.setAttribute('aria-expanded', 'false');
      dom.bubble.focus();
    }

    dom.bubble.addEventListener('click', function () {
      isOpen ? closePanel() : openPanel();
    });

    document.getElementById('aicb-close').addEventListener('click', closePanel);

    /* Close on Escape key */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen) closePanel();
    });

    /* ── Auto-resize textarea ── */
    dom.input.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 96) + 'px';
      dom.sendBtn.disabled = this.value.trim() === '' || isTyping;
    });

    /* Send on Enter (Shift+Enter = newline) */
    dom.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!dom.sendBtn.disabled) doSend();
      }
    });

    dom.sendBtn.addEventListener('click', doSend);
    dom.sendBtn.disabled = true;

    /* ── Core send flow ── */
    function doSend() {
      var text = dom.input.value.trim();
      if (!text || isTyping) return;

      /* Reset input */
      dom.input.value = '';
      dom.input.style.height = 'auto';
      dom.sendBtn.disabled = true;

      /* Render user message immediately */
      appendMessage(dom.messages, dom.typing, text, 'user');

      /* Show typing indicator */
      isTyping = true;
      dom.typing.classList.add('visible');
      dom.messages.scrollTop = dom.messages.scrollHeight;

      sendMessage(
        text,
        function (reply) {
          dom.typing.classList.remove('visible');
          appendMessage(dom.messages, dom.typing, reply, 'bot');
          /* Show badge if panel is closed */
          if (!isOpen) dom.badge.classList.add('visible');
        },
        function () {
          isTyping = false;
          dom.sendBtn.disabled = dom.input.value.trim() === '';
        },
        function () {
          dom.typing.classList.remove('visible');
          isTyping = false;
          dom.sendBtn.disabled = dom.input.value.trim() === '';
          var fallback = 'I\'m having a moment — please call us directly.';
          if (config.contact) fallback += '\n📞 ' + config.contact;
          appendMessage(dom.messages, dom.typing, fallback, 'error');
          if (!isOpen) dom.badge.classList.add('visible');
        }
      );
    }
  }

  // ──────────────────────────────────────────────────────────────
  // 9. MOUNT — wait for DOM ready
  // ──────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();


