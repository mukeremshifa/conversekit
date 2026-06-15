/*!
 * ConverseKit Chat Widget v0.3.0
 * Drop-in AI chatbot for any website.
 * Usage: <script src="widget.js" data-bot-id="YOUR_BOT_ID" defer></script>
 */
(function () {
  'use strict';

  // ─────────────────────────────────────────────────────────────
  // 0. CONFIG
  // ─────────────────────────────────────────────────────────────
  var API_BASE = 'https://conversekit.mukeremshifa.workers.dev';

  // ─────────────────────────────────────────────────────────────
  // 1. BOOTSTRAP
  // ─────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────
  // 2. STATE
  // ─────────────────────────────────────────────────────────────
  var config = {
    name: 'Assistant',
    contact: null,
    primaryColor: '#2563eb',
  };
  var isOpen    = false;
  var isTyping  = false;
  var msgCount  = 0; // track messages sent this session

  // ─────────────────────────────────────────────────────────────
  // 3. STYLES
  // ─────────────────────────────────────────────────────────────
  var CSS = [
    /* Reset */
    '#aicb-root *,#aicb-root *::before,#aicb-root *::after{box-sizing:border-box;margin:0;padding:0;}',

    /* Root */
    '#aicb-root{position:fixed;bottom:24px;right:24px;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;font-size:15px;line-height:1.5;}',

    /* ── Bubble ── */
    '#aicb-bubble{width:60px;height:60px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;background:var(--ck-color);box-shadow:0 4px 20px rgba(0,0,0,.22);transition:transform .2s ease,box-shadow .2s ease;outline:none;position:relative;}',
    '#aicb-bubble:hover{transform:scale(1.07);box-shadow:0 6px 28px rgba(0,0,0,.28);}',
    '#aicb-bubble:focus-visible{outline:3px solid var(--ck-color);outline-offset:3px;}',
    '#aicb-bubble-icon{transition:opacity .15s,transform .15s;}',
    '#aicb-bubble-icon svg{width:28px;height:28px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;display:block;}',
    '#aicb-bubble-close{position:absolute;opacity:0;transform:scale(.7) rotate(-90deg);transition:opacity .15s,transform .15s;}',
    '#aicb-bubble-close svg{width:22px;height:22px;display:block;stroke:#fff;stroke-width:2.5;stroke-linecap:round;}',
    '#aicb-root.is-open #aicb-bubble-icon{opacity:0;transform:scale(.7) rotate(90deg);}',
    '#aicb-root.is-open #aicb-bubble-close{opacity:1;transform:scale(1) rotate(0deg);}',

    /* Badge */
    '#aicb-badge{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;border-radius:10px;background:#ef4444;color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 4px;opacity:0;transform:scale(0);transition:opacity .2s,transform .2s;border:2px solid #fff;}',
    '#aicb-badge.visible{opacity:1;transform:scale(1);}',

    /* ── Panel ── */
    '#aicb-panel{position:absolute;bottom:72px;right:0;width:370px;max-width:calc(100vw - 32px);background:#fff;border-radius:20px;box-shadow:0 12px 48px rgba(0,0,0,.16);display:flex;flex-direction:column;overflow:hidden;transform-origin:bottom right;transition:opacity .25s cubic-bezier(.4,0,.2,1),transform .25s cubic-bezier(.4,0,.2,1);opacity:0;transform:scale(.9) translateY(16px);pointer-events:none;}',
    '#aicb-panel.open{opacity:1;transform:scale(1) translateY(0);pointer-events:all;}',

    /* Header */
    '#aicb-header{background:var(--ck-color);padding:16px 18px;display:flex;align-items:center;gap:12px;color:#fff;flex-shrink:0;}',
    '#aicb-avatar{width:38px;height:38px;border-radius:50%;background:rgba(255,255,255,.2);display:flex;align-items:center;justify-content:center;flex-shrink:0;}',
    '#aicb-avatar svg{width:20px;height:20px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}',
    '#aicb-header-text{flex:1;min-width:0;}',
    '#aicb-bot-name{font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.01em;}',
    '#aicb-status{font-size:11px;opacity:.85;display:flex;align-items:center;gap:5px;margin-top:1px;}',
    '#aicb-status-dot{width:7px;height:7px;border-radius:50%;background:#4ade80;display:inline-block;flex-shrink:0;box-shadow:0 0 0 2px rgba(74,222,128,.3);}',

    /* Messages area */
    '#aicb-messages{flex:1;overflow-y:auto;padding:16px 16px 8px;display:flex;flex-direction:column;gap:8px;min-height:300px;max-height:380px;scroll-behavior:smooth;background:#f9fafb;}',
    '#aicb-messages::-webkit-scrollbar{width:4px;}',
    '#aicb-messages::-webkit-scrollbar-track{background:transparent;}',
    '#aicb-messages::-webkit-scrollbar-thumb{background:#d1d5db;border-radius:4px;}',

    /* Message bubbles */
    '.ck-msg{max-width:85%;padding:10px 14px;border-radius:18px;font-size:14px;line-height:1.6;word-break:break-word;animation:ck-pop .2s cubic-bezier(.4,0,.2,1);}',
    '@keyframes ck-pop{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:none;}}',
    '.ck-msg.bot{background:#fff;color:#111827;border-bottom-left-radius:5px;align-self:flex-start;box-shadow:0 1px 4px rgba(0,0,0,.08);}',
    '.ck-msg.user{background:var(--ck-color);color:#fff;border-bottom-right-radius:5px;align-self:flex-end;}',
    '.ck-msg.error{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;align-self:flex-start;font-size:13px;}',

    /* Timestamp */
    '.ck-time{font-size:10px;color:#9ca3af;margin-top:2px;align-self:flex-end;padding:0 2px;}',
    '.ck-time.left{align-self:flex-start;}',

    /* Typing indicator */
    '#aicb-typing{display:none;align-self:flex-start;background:#fff;border-radius:18px;border-bottom-left-radius:5px;padding:12px 16px;gap:5px;align-items:center;box-shadow:0 1px 4px rgba(0,0,0,.08);}',
    '#aicb-typing.visible{display:flex;}',
    '.ck-dot{width:7px;height:7px;border-radius:50%;background:#d1d5db;animation:ck-bounce 1.4s infinite ease-in-out;}',
    '.ck-dot:nth-child(2){animation-delay:.16s;}',
    '.ck-dot:nth-child(3){animation-delay:.32s;}',
    '@keyframes ck-bounce{0%,60%,100%{transform:translateY(0);}30%{transform:translateY(-5px);}}',

    /* Suggestion chips */
    '#aicb-chips{padding:6px 12px 10px;display:flex;flex-wrap:wrap;gap:6px;background:#f9fafb;flex-shrink:0;}',
    '.ck-chip{background:#fff;border:1.5px solid var(--ck-color);color:var(--ck-color);border-radius:20px;padding:5px 12px;font-size:12px;font-weight:500;cursor:pointer;transition:background .15s,color .15s;white-space:nowrap;font-family:inherit;line-height:1.4;}',
    '.ck-chip:hover{background:var(--ck-color);color:#fff;}',

    /* Input area */
    '#aicb-footer{border-top:1px solid #e5e7eb;padding:10px 12px;display:flex;gap:8px;align-items:flex-end;background:#fff;flex-shrink:0;}',
    '#aicb-input{flex:1;resize:none;border:1.5px solid #e5e7eb;border-radius:12px;padding:9px 12px;font-size:14px;font-family:inherit;color:#111827;background:#fff;outline:none;transition:border-color .15s,box-shadow .15s;max-height:96px;overflow-y:auto;line-height:1.5;}',
    '#aicb-input::placeholder{color:#9ca3af;}',
    '#aicb-input:focus{border-color:var(--ck-color);box-shadow:0 0 0 3px color-mix(in srgb,var(--ck-color) 15%,transparent);}',
    '#aicb-send{width:40px;height:40px;border-radius:12px;border:none;background:var(--ck-color);cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:opacity .15s,transform .15s;margin-bottom:1px;}',
    '#aicb-send:hover:not(:disabled){opacity:.88;transform:scale(1.06);}',
    '#aicb-send:active:not(:disabled){transform:scale(.96);}',
    '#aicb-send:disabled{opacity:.35;cursor:not-allowed;}',
    '#aicb-send svg{width:17px;height:17px;fill:none;stroke:#fff;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;}',

    /* Powered-by */
    '#aicb-powered{text-align:center;font-size:10px;color:#c4c9d4;padding:5px 0 9px;letter-spacing:.02em;background:#fff;flex-shrink:0;}',
    '#aicb-powered a{color:inherit;text-decoration:none;transition:color .15s;}',
    '#aicb-powered a:hover{color:#9ca3af;}',

    /* Mobile */
    '@media(max-width:480px){',
    '#aicb-root{bottom:16px;right:16px;}',
    '#aicb-panel{width:calc(100vw - 32px);right:-16px;border-radius:16px;}',
    '#aicb-messages{min-height:260px;max-height:calc(100svh - 280px);}',
    '}',
  ].join('\n');

  // ─────────────────────────────────────────────────────────────
  // 4. ICONS
  // ─────────────────────────────────────────────────────────────
  var ICON_CHAT  = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none" d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_CLOSE = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><line x1="18" y1="6" x2="6" y2="18" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><line x1="6" y1="6" x2="18" y2="18" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg>';
  var ICON_BOT   = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M12 2v4M8 11V7a4 4 0 0 1 8 0v4"/><circle cx="9" cy="16" r="1" fill="#fff" stroke="none"/><circle cx="15" cy="16" r="1" fill="#fff" stroke="none"/></svg>';
  var ICON_SEND  = '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';

  // ─────────────────────────────────────────────────────────────
  // 5. DOM HELPERS
  // ─────────────────────────────────────────────────────────────
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'className')   node.className   = attrs[k];
      else if (k === 'innerHTML')  node.innerHTML  = attrs[k];
      else if (k === 'textContent') node.textContent = attrs[k];
      else node.setAttribute(k, attrs[k]);
    });
    if (children) children.forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function timeStr() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // ─────────────────────────────────────────────────────────────
  // 6. BUILD DOM
  // ─────────────────────────────────────────────────────────────
  function buildDOM() {
    var style  = el('style', { innerHTML: CSS });

    /* Bubble */
    var bubbleIcon  = el('span', { id: 'aicb-bubble-icon',  innerHTML: ICON_CHAT });
    var bubbleClose = el('span', { id: 'aicb-bubble-close', innerHTML: ICON_CLOSE });
    var badge  = el('div', { id: 'aicb-badge', textContent: '1' });
    var bubble = el('button', { id: 'aicb-bubble', 'aria-label': 'Open chat', 'aria-expanded': 'false' }, [bubbleIcon, bubbleClose, badge]);

    /* Header */
    var avatar     = el('div',  { id: 'aicb-avatar', innerHTML: ICON_BOT });
    var botName    = el('div',  { id: 'aicb-bot-name', textContent: config.name });
    var statusDot  = el('span', { id: 'aicb-status-dot' });
    var statusTxt  = el('span', { textContent: 'Online · Typically replies instantly' });
    var status     = el('div',  { id: 'aicb-status' }, [statusDot, statusTxt]);
    var headerText = el('div',  { id: 'aicb-header-text' }, [botName, status]);
    var header     = el('div',  { id: 'aicb-header' }, [avatar, headerText]);

    /* Messages */
    var dot1    = el('div', { className: 'ck-dot' });
    var dot2    = el('div', { className: 'ck-dot' });
    var dot3    = el('div', { className: 'ck-dot' });
    var typing  = el('div', { id: 'aicb-typing' }, [dot1, dot2, dot3]);
    var messages = el('div', { id: 'aicb-messages', role: 'log', 'aria-live': 'polite' }, [typing]);

    /* Suggestion chips — shown after greeting, hidden after first send */
    var chips = el('div', { id: 'aicb-chips' });

    /* Footer */
    var input   = el('textarea', { id: 'aicb-input', placeholder: 'Type a message…', rows: '1', 'aria-label': 'Message' });
    var sendBtn = el('button',   { id: 'aicb-send', 'aria-label': 'Send', innerHTML: ICON_SEND });
    var footer  = el('div', { id: 'aicb-footer' }, [input, sendBtn]);

    /* Powered by */
    var powered = el('div', { id: 'aicb-powered', innerHTML: 'Powered by <a href="https://conversekit.io" target="_blank" rel="noopener">ConverseKit</a>' });

    /* Panel */
    var panel = el('div', {
      id: 'aicb-panel',
      role: 'dialog',
      'aria-label': 'Chat assistant',
      'aria-modal': 'true',
    }, [header, messages, chips, footer, powered]);

    /* Root */
    var root = el('div', { id: 'aicb-root' }, [style, panel, bubble]);

    return { root, panel, bubble, badge, messages, typing, chips, input, sendBtn, botName };
  }

  // ─────────────────────────────────────────────────────────────
  // 7. MESSAGE RENDERING
  // ─────────────────────────────────────────────────────────────
  function appendMessage(dom, text, role) {
    var div  = el('div', { className: 'ck-msg ' + role });
    div.textContent = text;

    var time = el('div', { className: 'ck-time' + (role === 'bot' ? ' left' : ''), textContent: timeStr() });

    dom.messages.insertBefore(div,  dom.typing);
    dom.messages.insertBefore(time, dom.typing);
    dom.messages.scrollTop = dom.messages.scrollHeight;
    return div;
  }

  // ─────────────────────────────────────────────────────────────
  // 8. SUGGESTION CHIPS
  // ─────────────────────────────────────────────────────────────
  var DEFAULT_CHIPS = [
    'What services do you offer?',
    'What are your opening hours?',
    'Do you accept insurance?',
    'I\'d like to book an appointment',
  ];

  function renderChips(dom, doSend) {
    dom.chips.innerHTML = '';
    DEFAULT_CHIPS.forEach(function (label) {
      var chip = el('button', { className: 'ck-chip', textContent: label });
      chip.addEventListener('click', function () {
        hideChips(dom);
        doSend(label);
      });
      dom.chips.appendChild(chip);
    });
  }

  function hideChips(dom) {
    dom.chips.style.display = 'none';
  }

  // ─────────────────────────────────────────────────────────────
  // 9. API
  // ─────────────────────────────────────────────────────────────
  function fetchConfig(onDone) {
    fetch(API_BASE + '/v1/bots/' + botId + '/health')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.name)         config.name         = d.name;
        if (d.contact)      config.contact      = d.contact;
        if (d.primaryColor) config.primaryColor = d.primaryColor;
        onDone(null);
      })
      .catch(function (e) { onDone(e); });
  }

  function callChat(message, onReply, onDone, onError) {
    fetch(API_BASE + '/v1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ botId: botId, message: message, sessionId: sessionId }),
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) { onReply(d.reply || ''); onDone(); })
      .catch(function (e) { onError(e); });
  }

  // ─────────────────────────────────────────────────────────────
  // 10. CONTROLLER
  // ─────────────────────────────────────────────────────────────
  function applyColor(root, color) {
    root.style.setProperty('--ck-color', color);
  }

  function init() {
    var dom = buildDOM();
    document.body.appendChild(dom.root);
    applyColor(dom.root, config.primaryColor);

    /* ── Load config → theme + greeting ── */
    fetchConfig(function (err) {
      if (!err) {
        applyColor(dom.root, config.primaryColor);
        dom.botName.textContent = config.name;
      }
      var greeting = 'Hi there! 👋 I\'m ' + config.name + ', your virtual assistant. How can I help you today?';
      appendMessage(dom, greeting, 'bot');
      renderChips(dom, doSend);
    });

    /* ── Open / close ── */
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

    dom.bubble.addEventListener('click', function () {
      isOpen ? closePanel() : openPanel();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen) closePanel();
    });

    /* ── Input ── */
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
      var text = dom.input.value.trim();
      if (text) doSend(text);
    });

    dom.sendBtn.disabled = true;

    /* ── Send ── */
    function doSend(text) {
      if (!text || isTyping) return;
      msgCount++;

      /* Hide chips after first real message */
      hideChips(dom);

      /* Clear input */
      dom.input.value = '';
      dom.input.style.height = 'auto';
      dom.sendBtn.disabled = true;

      appendMessage(dom, text, 'user');

      isTyping = true;
      dom.typing.classList.add('visible');
      dom.messages.scrollTop = dom.messages.scrollHeight;

      callChat(
        text,
        function (reply) {
          dom.typing.classList.remove('visible');
          appendMessage(dom, reply, 'bot');
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
          var fallback = 'I\'m having a moment — please reach us directly.';
          if (config.contact) fallback += '\n📞 ' + config.contact;
          appendMessage(dom, fallback, 'error');
          if (!isOpen) dom.badge.classList.add('visible');
        }
      );
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 11. MOUNT
  // ─────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
