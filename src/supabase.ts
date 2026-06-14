import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Env, Bot, ConversationRow } from './types';

// ----------------------------------------------------------------
// Factory – call once per request (Workers are stateless per invocation)
// ----------------------------------------------------------------
export function makeSupabase(env: Env): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
  });
}

// ----------------------------------------------------------------
// Fetch a bot by primary key.
// Returns null when not found so callers can 404 cleanly.
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
    // PostgREST returns PGRST116 ("0 rows") when .single() finds nothing
    if (error.code === 'PGRST116') return null;
    throw new Error(`Supabase getBotById: ${error.message}`);
  }

  return data as Bot;
}

// ----------------------------------------------------------------
// Retrieve recent conversation history for context (last 20 turns).
// We pass this to Claude so it has memory of the session.
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

// ----------------------------------------------------------------
// Append a single message to the log.
// ----------------------------------------------------------------
export async function logMessage(
  client: SupabaseClient,
  row: Omit<ConversationRow, 'id' | 'created_at'>
): Promise<void> {
  const { error } = await client.from('conversations').insert(row);
  if (error) throw new Error(`Supabase logMessage: ${error.message}`);
}
