// ----------------------------------------------------------------
// Cloudflare Worker environment bindings (secrets from .dev.vars)
// ----------------------------------------------------------------
export interface Env {
  ANTHROPIC_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
}

// ----------------------------------------------------------------
// Supabase row shapes
// ----------------------------------------------------------------
export interface Bot {
  id: string;
  name: string;
  business_name: string;
  hours: string | null;
  location: string | null;
  contact: string | null;
  services: string | null;
  custom_instructions: string | null;
  primary_color: string;
  allowed_origin: string;
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
