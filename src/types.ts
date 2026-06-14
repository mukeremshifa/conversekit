// ----------------------------------------------------------------
// Cloudflare Worker environment bindings (secrets from .dev.vars)
// ----------------------------------------------------------------
export interface Env {
  GEMINI_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  ADMIN_SECRET: string;
}

// ----------------------------------------------------------------
// Supabase row shapes
// ----------------------------------------------------------------
export interface Bot {
  id: string;
  name: string;
  business_name: string;
  // contact / location kept for backwards compat with existing rows
  hours: string | null;
  location: string | null;
  contact: string | null;
  services: string | null;
  custom_instructions: string | null;
  primary_color: string;
  allowed_origin: string;
  created_at: string;
  // Phase 1 knowledge base fields
  business_description: string | null;
  faq: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  address: string | null;
}

export interface Lead {
  id: string;
  bot_id: string;
  session_id: string;
  name: string;
  email: string;
  phone: string | null;
  inquiry: string | null;
  created_at: string;
}

export interface ConversationRow {
  id: string;
  bot_id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

// ----------------------------------------------------------------
// Request / response shapes
// ----------------------------------------------------------------
export interface ChatRequest {
  botId: string;
  message: string;
  sessionId: string;
}

export interface ChatResponse {
  reply: string;
  sessionId: string;
}

export interface BotUpdatePayload {
  name?: string;
  business_name?: string;
  business_description?: string;
  services?: string;
  faq?: string;
  hours?: string;
  address?: string;
  contact_email?: string;
  contact_phone?: string;
  primary_color?: string;
  allowed_origin?: string;
  custom_instructions?: string;
}
