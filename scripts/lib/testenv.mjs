/**
 * Disposable test tenancy.
 *
 * THE RULE THIS ENFORCES: a test user must never be granted membership
 * in an organization it did not create. This project lost a database
 * because ad-hoc test scripts added throwaway users to a *real* org so
 * they could exercise a real bot — and a later cleanup that deleted
 * "this user's org" therefore deleted the real one, cascading away
 * every bot, conversation, lead and document under it.
 *
 * So: each test gets its own user, its own org (via the signup
 * trigger), and its own bots. Teardown removes only ids it recorded —
 * it never walks outward from a user to whatever org they belong to.
 *
 * To exercise a REAL bot, do not graft membership. Use the dashboard
 * Playground, or POST /v1/admin/bots/:id/preview as its actual owner.
 */
const PREFIX = 'ck-test';

export function createHarness({ supabaseUrl, anonKey, serviceKey, workerUrl }) {
  const svc = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
  const created = { users: [], orgs: [] };

  async function retry(fn, label, attempts = 4) {
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); }
      catch (err) {
        if (i === attempts - 1) throw new Error(`${label}: ${err.message}`);
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
      }
    }
  }

  const rest = (path, init = {}) => retry(async () => {
    const r = await fetch(`${supabaseUrl}/rest/v1${path}`, { headers: svc, ...init });
    const t = await r.text();
    if (!r.ok) throw new Error(`${r.status} ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  }, `REST ${path}`);

  /** A fresh user, its own trigger-provisioned org, and a token. */
  async function newTenant(label = 'a') {
    const email = `${PREFIX}-${label}-${Date.now()}@conversekit.test`;
    const password = `Pw-${Date.now()}-Aa1!`;

    const user = await retry(async () => {
      const r = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
        method: 'POST', headers: svc,
        body: JSON.stringify({ email, password, email_confirm: true }),
      });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
      return r.json();
    }, 'create user');
    created.users.push(user.id);

    const token = await retry(async () => {
      const r = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: { apikey: anonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
      return (await r.json()).access_token;
    }, 'sign in');

    const rows = await rest(`/memberships?select=org_id&user_id=eq.${user.id}`);
    const orgId = rows?.[0]?.org_id;
    if (!orgId) throw new Error('signup trigger did not provision an org');
    created.orgs.push(orgId);

    return { email, userId: user.id, orgId, token };
  }

  async function call(path, { token, method = 'GET', body } = {}) {
    const r = await fetch(`${workerUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const t = await r.text();
    let json = null;
    try { json = t ? JSON.parse(t) : null; } catch { /* non-JSON error body */ }
    return { status: r.status, json, text: t };
  }

  /** Removes only ids this harness recorded. Never traverses outward. */
  async function teardown() {
    const problems = [];
    for (const orgId of created.orgs) {
      try { await rest(`/organizations?id=eq.${orgId}`, { method: 'DELETE' }); }
      catch (e) { problems.push(`org ${orgId} (${e.message})`); }
    }
    for (const userId of created.users) {
      try {
        await retry(async () => {
          const r = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, { method: 'DELETE', headers: svc });
          if (!r.ok) throw new Error(String(r.status));
        }, 'delete user');
      } catch (e) { problems.push(`user ${userId} (${e.message})`); }
    }
    if (problems.length) console.log(`  CLEANUP INCOMPLETE — remove manually: ${problems.join(', ')}`);
    created.users.length = 0;
    created.orgs.length = 0;
  }

  return { newTenant, call, rest, teardown };
}
