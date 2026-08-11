# Tenancy, auth and leads

How organizations are isolated, how the origin lock works, and how leads are captured.

[← Back to the README](../README.md)

---

## Tenancy and auth

Every bot belongs to an **organization**; every user belongs to organizations
through **memberships** carrying a role (`owner` / `admin` / `viewer`). Signing
up creates your organization automatically, via a Postgres trigger.

Isolation is enforced by **Row Level Security in Postgres**, not by application
code. The Worker uses two distinct identities, and they are separated at the type
level — `getLeads(serviceDb(env), …)` is a compile error:

| Path | Caller | Identity | Enforced by |
|---|---|---|---|
| `/v1/chat`, `/v1/chat/stream`, `/v1/bots/:id/health` | anonymous visitor | `service_role` (bypasses RLS) | origin lock + `botId` |
| `/v1/admin/*` | signed-in user | that user's JWT, forwarded to PostgREST | RLS policies |

A bot in another org returns `404`, not `403` — RLS returns no rows, which is
genuinely indistinguishable from absent and avoids confirming the id exists.

---

## Lead capture

When a visitor expresses intent to book or be contacted, the system prompt
instructs the model to collect their details and append a hidden marker to the
end of its reply:

```
[[LEAD:{"name":"…","email":"…","phone":"…","inquiry":"…"}]]
```

[`src/leads.ts`](../src/leads.ts) strips this marker from the visible reply (the
visitor never sees it) and, if it contains at least a name and a valid email,
saves a row to the `leads` table. Leads show up in the admin dashboard's **Leads**
tab.

---
