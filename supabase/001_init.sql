-- ============================================================
-- clinica-bot  –  initial schema
-- Run this in the Supabase SQL Editor (or via supabase db push)
-- ============================================================

-- -----------------------------------------------------------------
-- bots
-- Stores one row per customer chatbot configuration.
-- -----------------------------------------------------------------
create table if not exists bots (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,                 -- e.g. "Dental Clinic Bot"
  business_name      text not null,                 -- e.g. "Smile Dental Addis"
  hours              text,                          -- e.g. "Mon-Fri 8am-6pm"
  location           text,                          -- e.g. "Bole, Addis Ababa"
  contact            text,                          -- e.g. "+251 91 234 5678"
  services           text,                          -- free-text list of services
  custom_instructions text,                         -- extra system-prompt additions
  primary_color      text not null default '#2563eb', -- hex color for future widget
  allowed_origin     text not null,                 -- e.g. "https://smiledentaladdis.com"
  created_at         timestamptz not null default now()
);

-- -----------------------------------------------------------------
-- conversations
-- Every single chat message (user + assistant) stored here.
-- -----------------------------------------------------------------
create table if not exists conversations (
  id         uuid primary key default gen_random_uuid(),
  bot_id     uuid not null references bots(id) on delete cascade,
  session_id text not null,        -- client-generated; groups a chat thread
  role       text not null check (role in ('user', 'assistant')),
  content    text not null,
  created_at timestamptz not null default now()
);

-- Index for fast per-session history lookups
create index if not exists idx_conversations_bot_session
  on conversations(bot_id, session_id, created_at);

-- -----------------------------------------------------------------
-- Seed: one demo bot so you can test immediately
-- Replace allowed_origin with wherever you run your local widget.
-- -----------------------------------------------------------------
insert into bots (
  name, business_name, hours, location, contact, services,
  custom_instructions, primary_color, allowed_origin
) values (
  'Demo Clinic Bot',
  'Demo Clinic',
  'Monday–Friday 8 AM – 6 PM, Saturday 9 AM – 1 PM',
  '123 Main Street, Addis Ababa',
  '+251 91 000 0000 | info@democlinic.com',
  'General Consultations, Dental Care, Lab Tests, Pharmacy',
  'Always be polite and empathetic. If you cannot answer, ask the user to call us.',
  '#2563eb',
  'http://localhost:3000'
)
on conflict do nothing;
