// ----------------------------------------------------------------
// Supabase helpers using raw fetch — no SDK dependency.
// The @supabase/supabase-js client pulls in Node.js streams which
// can cause issues in the Cloudflare Workers runtime.
// PostgREST's REST API is simple enough to call directly.
// ----------------------------------------------------------------
import type { Env, Bot, ConversationRow, Lead, BotUpdatePayload } from './types';
import type { ExtractedLead } from './leads';

function headers(env: Env): Record<string, string> {
  return {
    'apikey':        env.SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`,
    'Content-Type':  'application/json',
    'Prefer':        'return=representation',
  };
}

function url(env: Env, path: string): string {
  return `${env.SUPABASE_URL}/rest/v1${path}`;
}

async function pgFetch<T>(env: Env, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url(env, path), {
    ...init,
    headers: { ...headers(env), ...(init.headers as Record<string, string> ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase ${init.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }
  // 204 No Content
  if (res.status === 204) return [] as unknown as T;
  return res.json() as Promise<T>;
}

// ----------------------------------------------------------------
// Bots
// ----------------------------------------------------------------
export async function getBotById(env: Env, botId: string): Promise<Bot | null> {
  const rows = await pgFetch<Bot[]>(env,
    `/bots?select=*&id=eq.${encodeURIComponent(botId)}&limit=1`
  );
  return rows[0] ?? null;
}

export async function updateBot(env: Env, botId: string, payload: BotUpdatePayload): Promise<Bot> {
  const rows = await pgFetch<Bot[]>(env,
    `/bots?id=eq.${encodeURIComponent(botId)}`,
    { method: 'PATCH', body: JSON.stringify(payload) }
  );
  if (!rows[0]) throw new Error('Bot not found after update');
  return rows[0];
}

// ----------------------------------------------------------------
// Conversations
// ----------------------------------------------------------------
export async function getSessionHistory(
  env: Env,
  botId: string,
  sessionId: string
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const rows = await pgFetch<ConversationRow[]>(env,
    `/conversations?select=role,content&bot_id=eq.${encodeURIComponent(botId)}&session_id=eq.${encodeURIComponent(sessionId)}&order=created_at.asc&limit=20`
  );
  return rows;
}

export async function logMessage(
  env: Env,
  row: Omit<ConversationRow, 'id' | 'created_at'>
): Promise<void> {
  await pgFetch<unknown>(env, '/conversations',
    { method: 'POST', body: JSON.stringify(row),
      headers: { 'Prefer': 'return=minimal' } }
  );
}

export async function getConversations(
  env: Env,
  botId: string,
  limit = 100
): Promise<ConversationRow[]> {
  return pgFetch<ConversationRow[]>(env,
    `/conversations?select=*&bot_id=eq.${encodeURIComponent(botId)}&order=created_at.desc&limit=${limit}`
  );
}

// ----------------------------------------------------------------
// Leads
// ----------------------------------------------------------------
export async function saveLead(
  env: Env,
  botId: string,
  sessionId: string,
  lead: ExtractedLead
): Promise<void> {
  await pgFetch<unknown>(env, '/leads',
    { method: 'POST',
      body: JSON.stringify({
        bot_id:     botId,
        session_id: sessionId,
        name:       lead.name,
        email:      lead.email,
        phone:      lead.phone,
        inquiry:    lead.inquiry,
      }),
      headers: { 'Prefer': 'return=minimal' },
    }
  );
}

export async function getLeads(env: Env, botId: string, limit = 100): Promise<Lead[]> {
  return pgFetch<Lead[]>(env,
    `/leads?select=*&bot_id=eq.${encodeURIComponent(botId)}&order=created_at.desc&limit=${limit}`
  );
}
