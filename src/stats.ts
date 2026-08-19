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
import type { StatMessageRow, StatLeadRow, StatDocRow, RetrievalLogRow } from './supabase';

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

// ── The miss report ───────────────────────────────────────────────
//
// "Here are the questions your visitors asked that your bot could not
// answer." Built here rather than in a module of its own for two
// reasons that are both about reuse rather than tidiness: it groups
// questions with the same `normalise` the overview already uses, so
// "What are your hours?" and "what are your hours" count once in both
// places; and it inherits the offline test harness that already bundles
// this file, which is where an aggregate like this actually gets
// checked.
//
// Pure over rows the caller fetched, same as buildStats.

export interface MissQuestion {
  /** The first spelling seen, not the normalised form — it reads better
   *  in a list someone is about to write an FAQ answer for. */
  text: string;
  count: number;
  /** ISO timestamp of the most recent time it was asked. */
  lastAsked: string;
}

export interface MissReport {
  range: { days: number; from: string; to: string };
  totals: {
    queries: number;
    misses: number;
    /** 0–1. Null when nothing was asked — a rate over no denominator is
     *  not zero, it is unknown, and rendering it as 0% would say the
     *  bot is doing well when it has done nothing at all. */
    missRate: number | null;
  };
  /** Misses only, grouped and ranked. The list a tenant acts on. */
  questions: MissQuestion[];
  /** What actually answered. `missed` is the complement of the others,
   *  so the four sum to `totals.queries`.
   *
   *  `hybrid` (013) is its own count rather than folded into `vector`:
   *  a fused turn was answered by both channels at once, and reporting
   *  it as either would misdescribe what ran. A bot on the default mode
   *  never records one. */
  channels: { vector: number; lexical: number; hybrid: number; missed: number };
  scores: {
    /** Median top score on turns the VECTOR channel answered. Cosine,
     *  so it is comparable with `floor` below and with nothing else —
     *  the lexical and hybrid channels are both excluded, because a
     *  ts_rank_cd pooled into this would corrupt the one continuous
     *  measurement the platform has. See buildMissReport. */
    hitMedian: number | null;
    /**
     * Highest score recorded on a turn that still counted as a miss.
     *
     * Usually null, and that is correct rather than broken: the floor
     * is applied inside match_chunks, so a rejected chunk never reaches
     * the Worker to be scored. A NON-null value here means chunks came
     * back and the model was still shown nothing — a rendering or
     * budget problem, not a retrieval one, and worth seeing as such.
     */
    missMax: number | null;
    /**
     * The similarity floor those scores were tested against, from the
     * most recent row that recorded one.
     *
     * Carried because `hitMedian` alone is a number with no meaning: a
     * median of 0.62 is comfortable against a floor of 0.30 and
     * marginal against 0.60. This pair is the same measurement the eval
     * sweep makes, taken continuously against real traffic instead of a
     * fixture corpus — which is the whole reason this report stores
     * scores rather than only questions.
     */
    floor: number | null;
  };
  /** True when the row cap was hit, so the UI can say so rather than
   *  presenting a partial count as complete. */
  truncated: boolean;
}

/** Middle value, averaging the two middles on an even count. */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function buildMissReport(opts: {
  days: number;
  now?: Date;
  rows: RetrievalLogRow[];
  cap: number;
  /** How many grouped questions to return. */
  limit?: number;
}): MissReport {
  const { days, rows, cap } = opts;
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 20;

  // Same window arithmetic as buildStats, and deliberately the same
  // day-key membership test rather than a string comparison on the
  // timestamps: PostgREST renders `created_at` with a numeric offset
  // and microsecond precision, which does not order lexicographically
  // against an ISO string built here.
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(todayUtc.getTime() - (days - 1) * 86_400_000);
  const inWindow = new Set<string>();
  for (let i = 0; i < days; i++) {
    inWindow.add(new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10));
  }

  const questions = new Map<string, MissQuestion>();
  const hitScores: number[] = [];
  let queries = 0;
  let misses = 0;
  let vector = 0;
  let lexical = 0;
  let hybrid = 0;
  let missMax: number | null = null;
  let floor: number | null = null;

  for (const r of rows) {
    if (!inWindow.has(dayKey(r.created_at))) continue;
    queries++;

    // Read from the newest row that has one. Rows arrive newest-first,
    // so the first sighting is the current value — and it can legitimately
    // change mid-window when a tenant edits min_similarity or switches
    // embedder, in which case the newest is the one the tenant is
    // reading the report against.
    if (floor === null && typeof r.min_similarity === 'number') floor = r.min_similarity;

    if (r.matched) {
      if (r.channel === 'lexical') lexical++;
      else if (r.channel === 'hybrid') hybrid++;
      else vector++;
      // ONLY the vector channel's scores are pooled, and this is an
      // allow-list rather than a deny-list on purpose. A ts_rank_cd is
      // not on the cosine scale, so mixing it in produces a number that
      // reads like a measurement and is not one — and under fusion the
      // top result of a 'hybrid' turn may be the lexical one, which
      // `!== 'lexical'` would have let straight through. A channel this
      // does not recognise is counted as a turn and excluded from the
      // median, which is the safe direction.
      if (r.channel === 'vector' && typeof r.top_score === 'number') hitScores.push(r.top_score);
      continue;
    }

    misses++;
    if (typeof r.top_score === 'number' && (missMax === null || r.top_score > missMax)) {
      missMax = r.top_score;
    }

    const norm = normalise(r.query);
    if (norm.length < 3) continue;
    const seen = questions.get(norm);
    if (seen) {
      seen.count++;
      // Rows come back newest-first, so the first sighting is already
      // the latest — but the caller is not required to sort, and a
      // report whose "last asked" depends on fetch order is a bug
      // waiting for someone to change the query.
      if (r.created_at > seen.lastAsked) seen.lastAsked = r.created_at;
    } else {
      questions.set(norm, { text: r.query.trim(), count: 1, lastAsked: r.created_at });
    }
  }

  return {
    range: { days, from: from.toISOString(), to: now.toISOString() },
    totals: { queries, misses, missRate: queries ? misses / queries : null },
    questions: [...questions.values()]
      .sort((a, b) => b.count - a.count || b.lastAsked.localeCompare(a.lastAsked))
      .slice(0, limit),
    channels: { vector, lexical, hybrid, missed: misses },
    scores: { hitMedian: median(hitScores), missMax, floor },
    truncated: rows.length >= cap,
  };
}
