import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Env, Bot, ConversationRow, Lead, BotUpdatePayload } from './types';
import type { ExtractedLead } from './leads';

// ----------------------------------------------------------------
// Factory – one client per request (Workers are stateless)
// ----------------------------------------------------------------
export function makeSupabase(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
}

// ----------------------------------------------------------------
// Bots
// ----------------------------------------------------------------
export async function getBotById(
  client: SupabaseClient,
  botId: string
): Promise<Bot | null> {
  const { data, error } = await client
    .from('bots')
    .select('*')
    .eq('id', botId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return null;
    throw new Error(`Supabase getBotById: ${error.message}`);
  }
  return data as Bot;
}

export async function updateBot(
  client: SupabaseClient,
  botId: string,
  payload: BotUpdatePayload
): Promise<Bot> {
  const { data, error } = await client
    .from('bots')
    .update(payload)
    .eq('id', botId)
    .select('*')
    .single();

  if (error) throw new Error(`Supabase updateBot: ${error.message}`);
  return data as Bot;
}

// ----------------------------------------------------------------
// Conversations
// ----------------------------------------------------------------
export async function getSessionHistory(
  client: SupabaseClient,
  botId: string,
  sessionId: string
): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
  const { data, error } = await client
    .from('conversations')
    .select('role, content')
    .eq('bot_id', botId)
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })
    .limit(20);

  if (error) throw new Error(`Supabase getSessionHistory: ${error.message}`);
  return (data ?? []) as Array<{ role: 'user' | 'assistant'; content: string }>;
}

export async function logMessage(
  client: SupabaseClient,
  row: Omit<ConversationRow, 'id' | 'created_at'>
): Promise<void> {
  const { error } = await client.from('conversations').insert(row);
  if (error) throw new Error(`Supabase logMessage: ${error.message}`);
}

export async function getConversations(
  client: SupabaseClient,
  botId: string,
  limit = 100
): Promise<ConversationRow[]> {
  const { data, error } = await client
    .from('conversations')
    .select('*')
    .eq('bot_id', botId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Supabase getConversations: ${error.message}`);
  return (data ?? []) as ConversationRow[];
}

// ----------------------------------------------------------------
// Leads
// ----------------------------------------------------------------
export async function saveLead(
  client: SupabaseClient,
  botId: string,
  sessionId: string,
  lead: ExtractedLead
): Promise<void> {
  const { error } = await client.from('leads').insert({
    bot_id:     botId,
    session_id: sessionId,
    name:       lead.name,
    email:      lead.email,
    phone:      lead.phone,
    inquiry:    lead.inquiry,
  });
  if (error) throw new Error(`Supabase saveLead: ${error.message}`);
}

export async function getLeads(
  client: SupabaseClient,
  botId: string,
  limit = 100
): Promise<Lead[]> {
  const { data, error } = await client
    .from('leads')
    .select('*')
    .eq('bot_id', botId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Supabase getLeads: ${error.message}`);
  return (data ?? []) as Lead[];
}
