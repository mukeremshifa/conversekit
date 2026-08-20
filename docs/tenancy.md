# Tenancy, auth and leads

How organizations are isolated, how the origin lock works, how leads are
captured, and what visitor-typed text this platform keeps.

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

## Data retention

Three tables hold text a visitor typed. They are listed together here because
the answer differs per table, and "the conversation is stored anyway" is not a
reason to stop thinking about the others. `usage_log` is listed with them for
the opposite reason: it holds *no* visitor text at all, and that is exactly why
its window is so much longer.

| Table | What it holds | Retention |
|---|---|---|
| `conversations` | The full transcript, both sides | Kept until the bot is deleted |
| `leads` | Name, email, and whatever else the visitor volunteered | Kept until the bot is deleted |
| `retrieval_log` | The visitor's question, verbatim, plus what retrieval did with it | **Pruned at 90 days** |
| `usage_log` | Token counts per provider call. Vendor, model, integers — no text, no key material | **Pruned at 400 days** |

All four cascade on `ON DELETE CASCADE` from `bots`, so deleting a bot removes
everything it ever recorded. There is no per-visitor erasure endpoint yet; the
unit a tenant can act on is the bot.

### Why `usage_log` is kept for 400 days and not 90

The 90-day window on `retrieval_log` is a privacy commitment: that table exists
to keep what visitors typed, so the shortest window that still makes the report
useful is the right one. `usage_log` is the opposite kind of table. It holds
`kind`, `vendor`, `model`, four integers and a timestamp — no query, no reply,
no `session_id` for ingest or preview rows, and **no key material ever**, which
matters because `provider_config` may hold a BYOK key and this table is read by
browsers.

So the question is not "how little can we keep" but "how much does the tenant
need". Spend is a year-over-year question — *this March against last March* —
and 400 days is the shortest window that answers it. Applying the stricter
window here would force a privacy rule onto data that has no privacy exposure,
and throw away the platform's own billing history four times a year for nothing.

`prune_usage_log(p_days integer default 400)` in
[`017_usage.sql`](../supabase/017_usage.sql) clamps into **`[30, 800]`** inside
its own body, on exactly the reasoning below — wider bounds than
`prune_retrieval_log`, same placement and the same reason for it. It runs on its
**own cron expression** (`41 3 * * *`), with its own branch in the scheduled
handler, so a failure pruning one table cannot take down the other.

### Why `retrieval_log` stores the query verbatim

It is the first table on this platform whose *purpose* is keeping what visitors
typed, rather than keeping it as a side effect of holding a conversation. That
deserves a stated reason rather than a shrug.

The whole value of the table is the report **"here are the questions your bot
could not answer"** — the list a tenant reads to decide what to write next. A
normalised or hashed query cannot be read back, and a report of question
*shapes* tells nobody what to write. Storing anything less would be storing it
for no benefit, which is the worse trade.

What it does **not** hold: no IP address, no user agent, no reply. `session_id`
is the same signed, opaque id the transcript uses, and is null for dashboard
preview traffic. So the row is strictly narrower than the `conversations` row
that already exists for the same turn.

### Retention is enforced in the database, not the Worker

`prune_retrieval_log(p_days integer default 90)` is a `security definer`
function in [`012_retrieval.sql`](../supabase/012_retrieval.sql). A Cron Trigger
(`17 3 * * *`, see [`wrangler.toml`](../wrangler.toml)) calls it once a day with
90 and logs the number of rows removed.

**The function clamps `p_days` into `[7, 365]` inside its own body**, and that
placement is the point. The Worker holds a service-role key, and this is the one
table on the platform where a wrong number deletes tenant data outright — so the
Worker is not trusted with the number at all. A bug in the scheduled handler, or
a stray manual call, cannot ask for a zero-day purge:

```sql
select prune_retrieval_log(0);   -- prunes at 7 days, not 0
select prune_retrieval_log(7);   -- returns the row count
```

### Who can read it

RLS on `retrieval_log` mirrors **`chunks`**, not `documents`: select for members
of the owning org, and **no tenant write policy at all**. It is derived data
written by the service role, and a tenant forging their own miss report is not a
state worth allowing. `org_id` is set by the same
`set_org_from_bot_row()` trigger every other tenant-scoped table uses, so it can
never be supplied by a caller.

---
