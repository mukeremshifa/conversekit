# supabase/

The schema, as seven files that apply in order to an empty database.

```
001_tenancy.sql        extensions, organizations, memberships, the RLS
                       helpers every policy in the schema calls, the
                       org-recovery RPC, and the anon lockout
002_bots.sql           bots (every column), the signup trigger that
                       provisions org + membership + bot, and the
                       org_id derivation the other tables depend on
003_conversations.sql  transcripts and leads — service-role write,
                       tenant read
004_knowledge.sql      documents, chunks, faq_items; the storage cap
                       and the chunk counter
005_retrieval.sql      match_faq_items, match_chunks,
                       match_chunks_lexical, retrieval_log
006_usage.sql          usage_log and its retention function
007_erasure.sql        prune_conversations, erase_session, and the
                       tenant delete policies 003 left out
```

Apply them with `npm run db:migrate`, never by hand. Every migration
this project shipped before [`scripts/migrate.mjs`](../scripts/migrate.mjs)
existed was pasted into the SQL editor, which is how a Worker once went
out ahead of the schema it needed and broke bot creation.

## Rules

- **Every file is re-runnable.** `if not exists`, `create or replace`,
  `drop policy ... if exists` before create. The runner records a file
  as applied only after it succeeds, so a failure halfway through a set
  is fixed by running again.
- **Schema before Worker, always.** A Worker calling an RPC that does
  not exist fails outright; a schema ahead of its Worker is unread.
- **Never edit an applied file.** The runner checksums them and refuses.
  Write the difference as `007_…`.
- **`npm run db:reset -- --yes` destroys everything** in `public` plus
  every auth user, then reapplies from scratch. There is no undo and no
  point-in-time recovery on this project's plan.

## Where the old numbers went

These six replace the seventeen that built the schema one feature at a
time between `001_init` and `017_usage`. Nothing was dropped that the
Worker reads — see the header of `001_tenancy.sql` for what was.

Code comments and the changelog still cite the file that introduced a
thing, because that is a true statement about when it arrived. This is
where those names resolve to:

| Was | Is now |
|---|---|
| `001_init.sql` | `002_bots.sql`, `003_conversations.sql` |
| `002_phase1.sql` | `002_bots.sql`, `003_conversations.sql` |
| `003_tenancy.sql` | `001_tenancy.sql` |
| `004_provider_config.sql` | `002_bots.sql` |
| `005_rag.sql` | `004_knowledge.sql` |
| `006_client_ready.sql` | `002_bots.sql` |
| `007_org_recovery.sql` | `001_tenancy.sql` |
| `008_files.sql` | `004_knowledge.sql` |
| `009_bot_configuration.sql` | `002_bots.sql` |
| `010_lead_capture.sql` | `002_bots.sql`, `003_conversations.sql` |
| `011_knowledge.sql` | `004_knowledge.sql`, `005_retrieval.sql` |
| `012_retrieval.sql` | `005_retrieval.sql` |
| `013_hybrid.sql` | `005_retrieval.sql` |
| `014_single_bot.sql` | `002_bots.sql` |
| `015_business_profile.sql` | `002_bots.sql` |
| `016_faq_search.sql` | `005_retrieval.sql` |
| `017_usage.sql` | `006_usage.sql` |

The originals are in git history, at `976cb80` and earlier.
