-- ================================================================
-- ConverseKit – Phase 1 migration
-- Run in Supabase SQL Editor after 001_init.sql
-- ================================================================

-- ----------------------------------------------------------------
-- Extend bots table with knowledge base fields
-- ----------------------------------------------------------------
ALTER TABLE bots
  ADD COLUMN IF NOT EXISTS business_description text,
  ADD COLUMN IF NOT EXISTS faq                  text,
  ADD COLUMN IF NOT EXISTS contact_email        text,
  ADD COLUMN IF NOT EXISTS contact_phone        text,
  ADD COLUMN IF NOT EXISTS address              text;

-- ----------------------------------------------------------------
-- Leads table
-- ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leads (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id     uuid        NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  session_id text        NOT NULL,
  name       text        NOT NULL,
  email      text        NOT NULL CHECK (email LIKE '%@%'),
  phone      text,
  inquiry    text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_leads_bot_id
  ON leads(bot_id, created_at DESC);

-- ----------------------------------------------------------------
-- Update the demo seed bot with rich knowledge base data
-- so the demo scenario works out of the box
-- ----------------------------------------------------------------
UPDATE bots
SET
  business_description = 'Demo Clinic is a modern family healthcare centre offering affordable, high-quality medical, dental, and diagnostic services. We are committed to compassionate care for every patient.',
  faq = E'Q: Do I need an appointment?\nA: Walk-ins are welcome but appointments are prioritised. Book online or call us.\n\nQ: Do you accept insurance?\nA: Yes, we work with most major insurance providers. Please bring your card.\n\nQ: How long does a general consultation take?\nA: Typically 20-30 minutes.\n\nQ: Do you offer home visits?\nA: Not currently, but we offer teleconsultation by phone or video.',
  contact_email = 'info@democlinic.com',
  contact_phone = '+251 91 000 0000',
  address = '123 Main Street, Bole, Addis Ababa',
  services = E'• General Consultations\n• Dental Care (cleaning, fillings, extractions)\n• Laboratory Tests (blood work, urinalysis, cultures)\n• Pharmacy (on-site, open 7 days)\n• Teleconsultation\n• Paediatrics\n• Ante-natal Care'
WHERE name = 'Demo Clinic Bot';
