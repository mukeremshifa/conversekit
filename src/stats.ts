// ----------------------------------------------------------------
// Overview aggregates.
//
// Pure functions over rows the caller has already fetched, so they can
// be unit-tested without a database — which matters, because an
// off-by-one in the day bucketing is invisible in the UI until someone
// notices the chart is a day out.
//
// Days are bucketed in UTC. A per-tenant timezone would be more correct
// for a business reading its own numbers, but there is nowhere to store
// one yet; when there is, only `dayKey` changes.
// ----------------------------------------------------------------
import type { StatMessageRow, StatLeadRow, StatDocRow } from './supabase';

export interface DayPoint {
  date: string;        // YYYY-MM-DD
  visitor: number;     // messages sent by the visitor
  assistant: number;   // replies
  sessions: number;    // conversations that had their first message that day
  leads: number;
}

export interface Totals {
  sessions: number;
  messages: number;
  visitorMessages: number;
  assistantMessages: number;
  leads: number;
  /** Leads per session, 0–1. Null when there are no sessions to divide by. */
  conversionRate: number | null;
  /** Mean visitor turns per session — a proxy for engagement depth. */
  turnsPerSession: number | null;
  documents: number;
  documentsReady: number;
  documentsFailed: number;
  documentsPending: number;
  chunks: number;
}

export interface Question { text: string; count: number }

export interface Stats {
  range: { days: number; from: string; to: string };
  totals: Totals;
  /** Same shape as `totals`, for the immediately preceding window. */
  previous: Pick<Totals, 'sessions' | 'messages' | 'leads'>;
  series: DayPoint[];
  topQuestions: Question[];
  /** True when a row cap was hit, so the UI can say the numbers are partial. */
  truncated: { messages: boolean; leads: boolean };
}

export function dayKey(iso: string): string {
  return iso.slice(0, 10);
}

/** Every date in the window, so gaps render as zero rather than closing up. */
function emptySeries(from: Date, days: number): Map<string, DayPoint> {
  const out = new Map<string, DayPoint>();
  for (let i = 0; i < days; i++) {
    const d = new Date(from.getTime() + i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    out.set(key, { date: key, visitor: 0, assistant: 0, sessions: 0, leads: 0 });
  }
  return out;
}

/** Normalise a question for counting: case, surrounding punctuation and
 *  whitespace are noise when grouping "What are your hours?" variants. */
function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?!.,]+$/, '');
}

export function buildStats(opts: {
  days: number;
  now?: Date;
  messages: StatMessageRow[];
  leads: StatLeadRow[];
  documents: StatDocRow[];
  caps: { messages: number; leads: number };
}): Stats {
  const { days, messages, leads, documents, caps } = opts;
  const now = opts.now ?? new Date();

  // The window starts at midnight UTC `days-1` days ago, so a 7-day range
  // is seven whole buckets including today rather than 6 plus a sliver.
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(todayUtc.getTime() - (days - 1) * 86_400_000);
  const fromIso = from.toISOString();

  const buckets = emptySeries(from, days);

  // A session counts on the day of its first message in the window.
  const sessionFirstSeen = new Map<string, string>();
  const currentSessions = new Set<string>();
  const priorSessions = new Set<string>();

  let visitorMessages = 0;
  let assistantMessages = 0;
  let priorMessages = 0;
  const questionCounts = new Map<string, { text: string; count: number }>();

  for (const m of messages) {
    const key = dayKey(m.created_at);
    const bucket = buckets.get(key);

    if (!bucket) {
      // Older than the window: it belongs to the comparison period.
      priorMessages++;
      priorSessions.add(m.session_id);
      continue;
    }

    if (m.role === 'user') {
      bucket.visitor++;
      visitorMessages++;
      const norm = normalise(m.content);
      if (norm.length >= 3) {
        const seen = questionCounts.get(norm);
        // Keep the first spelling seen; it reads better than the normalised form.
        if (seen) seen.count++;
        else questionCounts.set(norm, { text: m.content.trim(), count: 1 });
      }
    } else {
      bucket.assistant++;
      assistantMessages++;
    }

    currentSessions.add(m.session_id);
    const first = sessionFirstSeen.get(m.session_id);
    if (!first || key < first) sessionFirstSeen.set(m.session_id, key);
  }

  for (const key of sessionFirstSeen.values()) {
    const bucket = buckets.get(key);
    if (bucket) bucket.sessions++;
  }

  let leadCount = 0;
  let priorLeads = 0;
  for (const l of leads) {
    const bucket = buckets.get(dayKey(l.created_at));
    if (bucket) { bucket.leads++; leadCount++; }
    else priorLeads++;
  }

  const sessions = currentSessions.size;
  const chunks = documents.reduce((n, d) => n + (d.chunk_count ?? 0), 0);

  return {
    range: { days, from: fromIso, to: now.toISOString() },
    totals: {
      sessions,
      messages: visitorMessages + assistantMessages,
      visitorMessages,
      assistantMessages,
      leads: leadCount,
      conversionRate: sessions ? leadCount / sessions : null,
      turnsPerSession: sessions ? visitorMessages / sessions : null,
      documents: documents.length,
      documentsReady: documents.filter((d) => d.status === 'ready').length,
      documentsFailed: documents.filter((d) => d.status === 'failed').length,
      documentsPending: documents.filter((d) => d.status === 'pending' || d.status === 'processing').length,
      chunks,
    },
    previous: { sessions: priorSessions.size, messages: priorMessages, leads: priorLeads },
    series: [...buckets.values()],
    topQuestions: [...questionCounts.values()]
      .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
      .slice(0, 6),
    truncated: {
      messages: messages.length >= caps.messages,
      leads: leads.length >= caps.leads,
    },
  };
}
