/* ================================================================
   ConverseKit Admin JS
   Pure vanilla — no framework, no build step.
   ================================================================ */
(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────
  var API = 'http://localhost:8787';

  // ── State ─────────────────────────────────────────────────────
  var BOT_ID = '';
  var SECRET = '';
  var botData = {};

  // ── Helpers ───────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }

  function api(method, path, body) {
    return fetch(API + path, {
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'x-admin-secret': SECRET,
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) {
      if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || r.statusText); });
      return r.json();
    });
  }

  function toast(msg, type) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (type ? ' ' + type : '');
    t.style.display = 'block';
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.style.display = 'none'; }, 3000);
  }

  function fmt(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function esc(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Tab switching ─────────────────────────────────────────────
  document.querySelectorAll('.nav-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var tab = btn.getAttribute('data-tab');
      document.querySelectorAll('.nav-btn').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
      btn.classList.add('active');
      $('tab-' + tab).classList.add('active');
      if (tab === 'leads')         loadLeads();
      if (tab === 'conversations') loadConvos();
    });
  });

  // ── Login ─────────────────────────────────────────────────────
  $('btn-login').addEventListener('click', function () {
    var id  = $('inp-bot-id').value.trim();
    var sec = $('inp-secret').value.trim();
    if (!id || !sec) { showLoginError('Both fields are required.'); return; }

    $('btn-login').disabled = true;
    $('btn-login').textContent = 'Checking…';

    fetch(API + '/admin/bots/' + id, {
      headers: { 'x-admin-secret': sec },
    })
      .then(function (r) {
        if (!r.ok) throw new Error('Invalid credentials or bot not found.');
        return r.json();
      })
      .then(function (data) {
        BOT_ID  = id;
        SECRET  = sec;
        botData = data;
        $('login-screen').style.display = 'none';
        $('dashboard').style.display    = 'flex';
        populateSettings(data);
        populateKnowledge(data);
        populateInstall(id);
      })
      .catch(function (err) {
        showLoginError(err.message);
        $('btn-login').disabled    = false;
        $('btn-login').textContent = 'Sign in';
      });
  });

  $('inp-secret').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('btn-login').click();
  });

  function showLoginError(msg) {
    var el = $('login-error');
    el.textContent = msg;
    el.style.display = 'block';
  }

  $('btn-logout').addEventListener('click', function () {
    BOT_ID = ''; SECRET = ''; botData = {};
    $('dashboard').style.display    = 'none';
    $('login-screen').style.display = 'flex';
    $('inp-secret').value = '';
    $('login-error').style.display = 'none';
    $('btn-login').disabled = false;
    $('btn-login').textContent = 'Sign in';
  });

  // ── Settings tab ──────────────────────────────────────────────
  function populateSettings(d) {
    $('s-name').value     = d.name           || '';
    $('s-biz-name').value = d.business_name  || '';
    $('s-origin').value   = d.allowed_origin || '';
    $('s-phone').value    = d.contact_phone  || d.contact || '';
    $('s-email').value    = d.contact_email  || '';
    $('s-address').value  = d.address        || d.location || '';
    $('s-hours').value    = d.hours          || '';

    var color = d.primary_color || '#2563eb';
    $('s-color-picker').value = color;
    $('s-color-hex').value    = color;
    applyColorPreview(color);
  }

  function applyColorPreview(color) {
    $('preview-bubble').style.color = color;
  }

  $('s-color-picker').addEventListener('input', function () {
    $('s-color-hex').value = this.value;
    applyColorPreview(this.value);
  });

  $('s-color-hex').addEventListener('input', function () {
    var v = this.value;
    if (/^#[0-9a-fA-F]{6}$/.test(v)) {
      $('s-color-picker').value = v;
      applyColorPreview(v);
    }
  });

  $('save-settings').addEventListener('click', function () {
    var payload = {
      name:          $('s-name').value.trim(),
      business_name: $('s-biz-name').value.trim(),
      allowed_origin:$('s-origin').value.trim(),
      contact_phone: $('s-phone').value.trim(),
      contact_email: $('s-email').value.trim(),
      address:       $('s-address').value.trim(),
      hours:         $('s-hours').value.trim(),
      primary_color: $('s-color-hex').value.trim() || $('s-color-picker').value,
    };
    api('PUT', '/admin/bots/' + BOT_ID, payload)
      .then(function (d) { botData = d; toast('Settings saved ✓', 'success'); populateInstall(BOT_ID); })
      .catch(function (e) { toast(e.message, 'error'); });
  });

  // ── Knowledge Base tab ────────────────────────────────────────
  function populateKnowledge(d) {
    $('k-description').value = d.business_description || '';
    $('k-services').value    = d.services             || '';
    $('k-faq').value         = d.faq                  || '';
    $('k-custom').value      = d.custom_instructions  || '';
  }

  $('save-knowledge').addEventListener('click', function () {
    var payload = {
      business_description: $('k-description').value.trim(),
      services:             $('k-services').value.trim(),
      faq:                  $('k-faq').value.trim(),
      custom_instructions:  $('k-custom').value.trim(),
    };
    api('PUT', '/admin/bots/' + BOT_ID, payload)
      .then(function (d) { botData = d; toast('Knowledge base saved ✓', 'success'); })
      .catch(function (e) { toast(e.message, 'error'); });
  });

  // ── Leads tab ─────────────────────────────────────────────────
  function loadLeads() {
    $('leads-loading').style.display    = 'block';
    $('leads-table-wrap').style.display = 'none';
    $('leads-empty').style.display      = 'none';

    api('GET', '/admin/bots/' + BOT_ID + '/leads')
      .then(function (data) {
        $('leads-loading').style.display = 'none';
        var leads = data.leads || [];
        if (!leads.length) {
          $('leads-empty').style.display = 'block';
          return;
        }
        var tbody = $('leads-tbody');
        tbody.innerHTML = leads.map(function (l) {
          return '<tr>' +
            '<td>' + esc(fmt(l.created_at)) + '</td>' +
            '<td>' + esc(l.name)            + '</td>' +
            '<td><a href="mailto:' + esc(l.email) + '">' + esc(l.email) + '</a></td>' +
            '<td>' + esc(l.phone   || '—') + '</td>' +
            '<td title="' + esc(l.inquiry || '') + '">' + esc(l.inquiry || '—') + '</td>' +
            '</tr>';
        }).join('');
        $('leads-table-wrap').style.display = 'block';
      })
      .catch(function (e) {
        $('leads-loading').textContent = 'Error: ' + e.message;
      });
  }

  $('refresh-leads').addEventListener('click', loadLeads);

  // ── Conversations tab ─────────────────────────────────────────
  function loadConvos() {
    $('convos-loading').style.display = 'block';
    $('convo-list').innerHTML         = '';
    $('convos-empty').style.display   = 'none';

    api('GET', '/admin/bots/' + BOT_ID + '/conversations')
      .then(function (data) {
        $('convos-loading').style.display = 'none';
        var convos = data.conversations || [];
        if (!convos.length) {
          $('convos-empty').style.display = 'block';
          return;
        }

        // Group by session_id (messages come newest-first; reverse for display)
        var sessions = {};
        var order    = [];
        convos.slice().reverse().forEach(function (m) {
          if (!sessions[m.session_id]) {
            sessions[m.session_id] = [];
            order.push(m.session_id);
          }
          sessions[m.session_id].push(m);
        });

        var list = $('convo-list');
        order.forEach(function (sid) {
          var msgs = sessions[sid];
          var divider = document.createElement('div');
          divider.className = 'session-divider';
          divider.textContent = 'Session · ' + sid.slice(0, 16) + '…';
          list.appendChild(divider);

          msgs.forEach(function (m) {
            var meta = document.createElement('div');
            meta.className = 'convo-meta' + (m.role === 'user' ? ' right' : '');
            meta.textContent = m.role === 'user' ? 'Visitor · ' + fmt(m.created_at)
                                                  : 'Bot · ' + fmt(m.created_at);
            var bubble = document.createElement('div');
            bubble.className = 'convo-msg ' + (m.role === 'user' ? 'user' : 'assistant');
            bubble.textContent = m.content;
            list.appendChild(meta);
            list.appendChild(bubble);
          });
        });
      })
      .catch(function (e) {
        $('convos-loading').textContent = 'Error: ' + e.message;
      });
  }

  $('refresh-convos').addEventListener('click', loadConvos);

  // ── Install tab ───────────────────────────────────────────────
  function populateInstall(botId) {
    var tag = '<script\n  src="' + API + '/widget.js"\n  data-bot-id="' + botId + '"\n  defer>\n<\/script>';
    $('install-code').textContent = tag;
  }

  $('btn-copy').addEventListener('click', function () {
    var text = $('install-code').textContent;
    navigator.clipboard.writeText(text)
      .then(function () { toast('Copied to clipboard ✓', 'success'); })
      .catch(function () {
        // Fallback for non-HTTPS
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast('Copied ✓', 'success');
      });
  });

})();
