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

[`apps/api/src/leads.ts`](../apps/api/src/leads.ts) strips this marker from the visible reply (the
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
| `conversations` | The full transcript, both sides | **Pruned at 180 days** |
| `leads` | Name, email, and whatever else the visitor volunteered | Kept until erased or deleted |
| `retrieval_log` | The visitor's question, verbatim, plus what retrieval did with it | **Pruned at 90 days** |
| `usage_log` | Token counts per provider call. Vendor, model, integers — no text, no key material | **Pruned at 400 days** |

All four cascade on `ON DELETE CASCADE` from `bots`, so deleting a bot removes
everything it ever recorded.

### Per-visitor erasure

The bot is no longer the smallest unit a tenant can act on. `007_erasure.sql`
adds two things the bot-level cascade could not express:

```
POST   /v1/admin/bots/:id/erase   { "session_id": "..." }  -> { messages, leads }
DELETE /v1/admin/leads/:leadId                             -> 204
```

The **session id is the unit of erasure**, because it is the only handle that
spans both tables: the widget issues one signed id per visitor, and both the
transcript rows and any lead extracted from that conversation carry it.
Deleting the lead alone would leave every word the visitor typed in
`conversations`, which is the failure mode this exists to prevent.

The erase route loads the bot through the **user** client first, and that call
*is* the authorization — `getBotForAdmin` runs under RLS, so a bot outside the
caller's org returns null and the request stops before the service-role RPC is
reached with an id off a request body. `erase_session` itself raises on a blank
session id rather than reporting zero rows, so a malformed request cannot look
like an erasure that simply found nothing.

**`retrieval_log` is not touched by erasure.** It stores the query text but
carries no `session_id` to match on, so there is nothing to erase *by*. Its own
90-day window is shorter than the transcript window above and removes it sooner
either way. This is stated rather than quietly skipped: an erasure that missed a
table without saying so would be a false claim to the person who asked.

### Why `leads` is not on a timer

`conversations` gets a window; `leads` does not, and the asymmetry is
deliberate. A transcript is a by-product of answering a question. A lead is the
*output of the product* — the thing the tenant is paying for, and a record they
are entitled to keep. A tenant who exported it to CSV last week has it outside
this database anyway, so a timer here would delete their copy of a record while
achieving nothing for the visitor.

Leads leave by an act rather than by elapsed time: the erase route above, or a
tenant deleting one from the dashboard under the RLS policy 007 adds. Tenants
get `delete` on both tables and still no `update` — a tenant editing what a
visitor said, or the email they gave, would destroy the record's value as
evidence of what actually happened.

### Why `conversations` is kept for 180 days

Longer than `retrieval_log`'s 90 because a tenant looking into a complaint about
what their bot told a customer needs the conversation to still exist, and a
90-day window loses that faster than disputes surface. Shorter than
`usage_log`'s 400 because this is what visitors typed, and the reasoning below
about privacy commitments applies to it more strongly than to any other table
here.

`prune_conversations(p_days integer default 180)` clamps into `[7, 365]` inside
the function body, for the same reason `prune_retrieval_log` does and with more
at stake: the caller is a scheduled handler holding a service-role key, and the
clamp is what stops a bug in that handler from truncating every transcript on
the platform. It runs on its own cron expression (`5 4 * * *`) with its own
branch and its own try/catch, so a Supabase hiccup during one prune cannot cost
another its run.

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
[`017_usage.sql`](../supabase/006_usage.sql) clamps into **`[30, 800]`** inside
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
function in [`012_retrieval.sql`](../supabase/005_retrieval.sql). A Cron Trigger
(`17 3 * * *`, see [`wrangler.toml`](../apps/api/wrangler.jsonc)) calls it once a day with
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
