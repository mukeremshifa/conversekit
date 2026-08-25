-- ================================================================
-- ConverseKit — transcripts and leads
--
-- Both are written ONLY by the Worker on the public chat path, which
-- uses the service role and bypasses RLS entirely. Authenticated users
-- therefore get read-only access: a tenant reads their own
-- conversations and leads, and cannot write either.
--
-- Referencing `bots` from these policies is not recursive — the bots
-- policies never mention conversations or leads.
-- ================================================================


-- ----------------------------------------------------------------
-- conversations — every message, user and assistant
-- ----------------------------------------------------------------
create table if not exists conversations (
  id             uuid        primary key default gen_random_uuid(),
  bot_id         uuid        not null references bots(id) on delete cascade,
  -- Issued and signed by the server (src/session.ts). The widget never
  -- invents one: a client-generated id could be guessed or replayed to
  -- read another visitor's transcript.
  session_id     text        not null,
  role           text        not null check (role in ('user', 'assistant')),
  content        text        not null,

  -- Assistant rows only. TRUE when the bot had a corpus and retrieval
  -- retrieved nothing; NULL means not recorded.
  --
  -- The escalation rule needs to know how many questions in a row the
  -- bot could not answer, and "could not answer" has to be a fact
  -- rather than a guess. There is no confidence score from the model,
  -- and matching phrases like "I don't know" is worse than useless
  -- here: the system prompt tells the bot to reply in the visitor's
  -- language, so an English regex scores zero on every Turkish
  -- conversation. Retrieval IS deterministic, is already computed on
  -- every turn, and used to be thrown away.
  --
  -- NULL rather than false for a bot with escalation switched off:
  -- "not recorded" and "had context" are different facts, and only
  -- true is ever counted.
  retrieval_miss boolean,

  created_at     timestamptz not null default now()
);

comment on column conversations.retrieval_miss is
  'Assistant rows only: true when the bot had a corpus and retrieval retrieved nothing. NULL = not recorded.';

-- Per-session history, which is what the chat path reads on every turn.
create index if not exists idx_conversations_bot_session
  on conversations(bot_id, session_id, created_at);

-- The dashboard's transcript list orders by exactly this.
create index if not exists idx_conversations_bot_created
  on conversations(bot_id, created_at desc);

-- No index on retrieval_miss on purpose. Counting misses reads the tail
-- of ONE session's rows, which idx_conversations_bot_session already
-- serves; a partial index would add write cost to every chat turn to
-- speed up a query that is already an index scan over a few dozen rows.


-- ----------------------------------------------------------------
-- leads — captured contact details
--
-- Scalar columns rather than a jsonb bag, which is the opposite of the
-- choice `bots` makes for its settings, and for the opposite reason:
-- unlike a settings blob, every one of these is read by the dashboard
-- table, the CSV export and eventually a filter. A jsonb `extra` would
-- make all three reach into a document for a value that is always
-- present and always a string.
-- ----------------------------------------------------------------
create table if not exists leads (
  id            uuid        primary key default gen_random_uuid(),
  bot_id        uuid        not null references bots(id) on delete cascade,
  session_id    text        not null,

  -- name and email are NOT configurable, unlike phone/company/inquiry
  -- in lead_config.fields. They are the pair src/leads.ts requires
  -- before it will save anything, and that check is the only thing
  -- standing between the model and a table of half-filled rows. Making
  -- them optional means making that guard optional.
  name          text        not null,
  email         text        not null check (email like '%@%'),
  phone         text,
  company       text,
  inquiry       text,

  -- Written by the Worker from lead_config.tag, never by the model: a
  -- model-supplied label is free text the tenant cannot rely on for
  -- filtering, which defeats the point of having one.
  tag           text,

  -- WHAT THIS COLUMN DOES AND DOES NOT MEAN.
  --
  -- true records that THE BOT WAS CONFIGURED TO ASK FOR CONSENT at the
  -- moment this lead was captured. It is not evidence that a visitor
  -- ticked a box, because there is no box: widget.js is a streaming
  -- chat surface with no structured-input primitive, and the consent is
  -- spoken into the conversation instead.
  --
  -- Written only when lead_config.consent_text is set. NULL otherwise,
  -- so "this bot never asked" stays distinguishable from a false that
  -- would imply someone was asked and declined.
  --
  -- Spelled out on the column rather than in a commit message because
  -- in two years somebody will find it while answering a compliance
  -- question, and the honest answer needs to be attached to the column.
  consent_given boolean,

  created_at    timestamptz not null default now()
);

comment on column leads.tag is
  'Server-applied label from bots.lead_config.tag at capture time. NULL = untagged.';
comment on column leads.consent_given is
  'true = the bot was instructed to ask for consent at capture time. NOT proof a visitor accepted — there is no checkbox. NULL = not asked.';

-- The dashboard reads one bot's leads newest-first. `tag` is filtered
-- client-side over at most 100 rows and gets no index of its own: an
-- index on a column with a handful of distinct values would cost every
-- insert and save nothing.
create index if not exists idx_leads_bot_id on leads(bot_id, created_at desc);


-- ----------------------------------------------------------------
-- RLS and grants
-- ----------------------------------------------------------------
alter table conversations enable row level security;
alter table leads         enable row level security;

drop policy if exists conv_select  on conversations;
drop policy if exists leads_select on leads;

create policy conv_select on conversations
  for select to authenticated
  using (bot_id in (
    select id from bots where org_id in (select public.user_org_ids())
  ));

create policy leads_select on leads
  for select to authenticated
  using (bot_id in (
    select id from bots where org_id in (select public.user_org_ids())
  ));

revoke all on conversations, leads from anon;
grant select on conversations to authenticated;
grant select on leads         to authenticated;
grant all    on conversations, leads to service_role;
