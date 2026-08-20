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
import type {
  StatMessageRow, StatLeadRow, StatDocRow, RetrievalLogRow, UsageLogRow,
} from './supabase';
// The only non-type import in this file, and it stays pure: resolvePrice
// is a pure function over a config table and needs no Env, so buildUsage
// can price a report without the aggregate becoming testable only
// against a live provider.
import { resolvePrice, type Price } from './providers/catalog';

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
    /**
     * Visitor messages in the same window, from the messages table.
     * Null when the caller did not supply them — this report is pure
     * over the rows it is handed, and a denominator it was not given is
     * unknown rather than zero.
     */
    turns: number | null;
    /**
     * Turns that were answered WITHOUT a search, as a 0–1 rate.
     *
     * MEASURED AS A DIFFERENCE, not counted directly, and the reason is
     * worth stating because it bounds what the number means.
     * retrievalLogRow logs nothing for a skipped turn — deliberately,
     * since a greeting recorded as `matched: false` would inflate the
     * miss rate — so a routed skip leaves no row anywhere to count.
     * What CAN be counted is visitor turns minus turns that produced a
     * log row, which is every turn that did not search for any reason:
     * the router, the codepoint floor, retrieval switched off, a
     * drifted index, or a bot with no corpus at all.
     *
     * So read it as "turns answered without a search", which is the
     * number a tenant actually wants, and NOT as "turns the router
     * skipped". Switching the router on should move it; if the miss
     * rate moves with it, a skip rule is too aggressive.
     */
    noSearchRate: number | null;
  };
  /** Misses only, grouped and ranked. The list a tenant acts on. */
  questions: MissQuestion[];
  /** What actually answered. `missed` is the complement of the others,
   *  so the four sum to `totals.queries`.
   *
   *  `hybrid` (013) is its own count rather than folded into `vector`:
   *  a fused turn was answered by both channels at once, and reporting
   *  it as either would misdescribe what ran. A bot on the default mode
   *  never records one.
   *
   *  `faqDirect` (016) likewise, and it is the one worth watching:
   *  those turns cost no embedding call at all, so a tenant tuning
   *  `faq_shortcut_threshold` is reading this number against the miss
   *  rate to find where it stops helping and starts answering the wrong
   *  question. */
  channels: {
    vector: number; lexical: number; hybrid: number; faqDirect: number; missed: number;
  };
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
  /**
   * Message rows over at least the same window, for the no-search rate.
   *
   * Passed as ROWS rather than as a count so the window is applied here
   * — once, by the same day-key membership test the retrieval rows go
   * through. A count computed by the caller against its own `since`
   * would be a denominator measured over a slightly different span from
   * its numerator, which is the sort of quiet skew that makes a
   * percentage untrustworthy without ever looking wrong.
   *
   * Optional: the report is complete without it, and a caller that has
   * not fetched them gets nulls rather than a fabricated denominator.
   */
  messages?: StatMessageRow[];
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

  const turns = opts.messages
    ? opts.messages.filter((m) => m.role === 'user' && inWindow.has(dayKey(m.created_at))).length
    : null;

  const questions = new Map<string, MissQuestion>();
  const hitScores: number[] = [];
  let queries = 0;
  let misses = 0;
  let vector = 0;
  let lexical = 0;
  let hybrid = 0;
  let faqDirect = 0;
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
      else if (r.channel === 'faq-direct') faqDirect++;
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
    totals: {
      queries, misses,
      missRate: queries ? misses / queries : null,
      turns,
      // Clamped at zero rather than allowed to go negative. The two
      // numbers come from two tables with independent retention, so a
      // pruned messages table against a fuller retrieval log can
      // legitimately produce more queries than turns — and "-4% of
      // turns skipped a search" is a worse answer than 0%.
      noSearchRate: turns ? Math.max(0, turns - queries) / turns : null,
    },
    questions: [...questions.values()]
      .sort((a, b) => b.count - a.count || b.lastAsked.localeCompare(a.lastAsked))
      .slice(0, limit),
    channels: { vector, lexical, hybrid, faqDirect, missed: misses },
    scores: { hitMedian: median(hitScores), missMax, floor },
    truncated: rows.length >= cap,
  };
}

// ── Usage metering (017) ──────────────────────────────────────────
//
// Third aggregate in this file, and here for the same two reasons the
// miss report is: it reuses the day bucketing above, so the usage chart
// and the messages chart cannot drift a day apart; and it inherits the
// offline test harness, which is the only place an aggregate on this
// platform actually gets checked.
//
// Pure over rows the caller fetched, same as the other two. The only
// import that is not a type is resolvePrice, which is pure config over
// a pure function and needs no Env.

/**
 * A ROUGH PROXY FOR A TOKEN COUNT. Not a tokenizer, and not billable.
 *
 * Codepoints rather than UTF-16 units — `[...text].length`, the same
 * correctness the short-query gate already applies — divided by four.
 * That ratio is calibrated for Latin script and it INFLATES for
 * Amharic and CJK, where a codepoint is closer to a whole token than
 * to a quarter of one; it reads low for dense code and long URLs.
 *
 * It exists because on the platform's own default stack — Gemini chat
 * plus Workers AI embeddings — the embedding vendor reports no usage
 * at all, and a meter that shows a blank there is a meter nobody
 * opens. A free-tier tenant gets a SHAPE. Every row it produces is
 * stamped `source: 'estimated'`, and the aggregate reports that share
 * beside the total rather than blending the two, so nobody bills from
 * one by accident.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil([...text].length / 4);
}

/**
 * Fill a usage row's token fields from what the vendor reported, or
 * from the estimator when it reported nothing.
 *
 * ONE FUNCTION, ONE HOME, used by both chat routes, the preview route
 * and both ingest paths — the alternative is `chars / 4` inlined in
 * five places and corrected in three of them.
 *
 * BOTH counts null is the trigger, not either. A vendor that returns
 * an input count and no output count has still REPORTED, and quietly
 * filling its silence with an estimate would put a guessed number
 * under a `reported` label, which is the one thing the source column
 * exists to prevent. Partial reports keep their nulls.
 *
 * `output` absent means there was no output side at all (an embedding
 * call), so the estimated output stays null rather than becoming zero:
 * zero output tokens and no output concept are different facts.
 */
export function usageTokens(
  usage: { inputTokens: number | null; outputTokens: number | null },
  text: { input: string; output?: string },
): { input_tokens: number | null; output_tokens: number | null; source: 'reported' | 'estimated' } {
  if (usage.inputTokens !== null || usage.outputTokens !== null) {
    return {
      input_tokens:  usage.inputTokens,
      output_tokens: usage.outputTokens,
      source: 'reported',
    };
  }
  return {
    input_tokens:  estimateTokens(text.input),
    output_tokens: text.output === undefined ? null : estimateTokens(text.output),
    source: 'estimated',
  };
}

/** One grouping — by vendor, by model or by kind. The same shape for
 *  all three, so the UI needs one row renderer and this file needs one
 *  accumulator. */
export interface UsageGroup {
  /** The grouping value: a vendor id, a model name, or a kind. */
  key: string;
  /** Only set on the by-model grouping, where a bare model name is
   *  ambiguous — several vendors serve bge-base-en-v1.5, at different
   *  prices. */
  vendor?: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Indicative spend for this group, or null when nothing in it
   *  resolved a price. Never zero-by-default: a local model measured
   *  at zero and an endpoint nobody knows the price of are different
   *  answers. */
  cost: number | null;
}

export interface UsageDayPoint {
  date: string;        // YYYY-MM-DD
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  calls: number;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  calls: number;
  /** D2: the SPLIT, never a single blended total. */
  reportedTokens: number;
  estimatedTokens: number;
  reportedCalls: number;
  estimatedCalls: number;
  /** Calls that failed and were charged for anyway. Worth reading next
   *  to the total when it is non-zero: it is what a misconfigured
   *  vendor costs while somebody retries against it. */
  errorCalls: number;
}

export interface UsageCost {
  amount: number;
  currency: 'USD';
  pricedCalls: number;
  /** Calls whose vendor has no rate anyone on this side of the
   *  connection can know — a custom endpoint, an OpenRouter model.
   *  Their tokens are in the totals and their money is not in
   *  `amount`, and saying so is the difference between an incomplete
   *  figure and a wrong one. */
  unpricedCalls: number;
  /** The OLDEST `pricedAt` among the rates actually used, so the UI can
   *  say how stale the arithmetic is. */
  pricedAt: string | null;
}

export interface UsageReport {
  range: { days: number; from: string; to: string };
  totals: UsageTotals;
  /**
   * Share of TOKENS — not of calls — that came from the estimator,
   * 0–1. Null when nothing was recorded at all, on the same reasoning
   * as missRate: a share over no denominator is unknown rather than
   * zero, and rendering it as 0% would claim every number on the
   * screen was confirmed by a vendor.
   *
   * Tokens rather than calls, because that is what the sentence beside
   * it says. One ingest of a large document outweighs a hundred chat
   * turns, so "3% of calls" and "70% of tokens" are routinely both
   * true and only the second is an honest headline.
   */
  estimatedShare: number | null;
  /** Null when NOTHING resolved a price, which is a different
   *  statement from a spend of zero. */
  cost: UsageCost | null;
  byVendor: UsageGroup[];
  byModel: UsageGroup[];
  byKind: UsageGroup[];
  series: UsageDayPoint[];
  /** True when the row cap was hit, so the UI can say the numbers are
   *  partial rather than presenting them as complete. */
  truncated: boolean;
}

/**
 * Indicative cost of one call, in USD.
 *
 * An embedding call is priced on its input alone — there is no output
 * side — and falls back to the input rate when the vendor publishes no
 * separate embedding number, because input the vendor read is exactly
 * what an embedding call is.
 */
function costOf(row: UsageLogRow, price: Price): number {
  const input = row.input_tokens ?? 0;
  const output = row.output_tokens ?? 0;
  if (row.kind === 'embed') {
    return (input * (price.embedPer1M ?? price.inputPer1M)) / 1_000_000;
  }
  return (input * price.inputPer1M + output * price.outputPer1M) / 1_000_000;
}

/** Accumulate one row into a keyed group, creating it on first sight. */
function addTo(
  groups: Map<string, UsageGroup>,
  key: string,
  row: UsageLogRow,
  cost: number | null,
  vendor?: string,
): void {
  let g = groups.get(key);
  if (!g) {
    g = { key, vendor, calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: null };
    groups.set(key, g);
  }
  g.calls++;
  g.inputTokens  += row.input_tokens ?? 0;
  g.outputTokens += row.output_tokens ?? 0;
  g.totalTokens  += (row.input_tokens ?? 0) + (row.output_tokens ?? 0);
  // null plus a number is a number; null plus nothing stays null. A
  // group of entirely unpriced calls must not report a spend of zero.
  if (cost !== null) g.cost = (g.cost ?? 0) + cost;
}

const ranked = (groups: Map<string, UsageGroup>): UsageGroup[] =>
  [...groups.values()].sort((a, b) => b.totalTokens - a.totalTokens || a.key.localeCompare(b.key));

export function buildUsage(opts: {
  days: number;
  now?: Date;
  rows: UsageLogRow[];
  cap: number;
}): UsageReport {
  const { days, rows, cap } = opts;
  const now = opts.now ?? new Date();

  // Same window arithmetic as buildStats and buildMissReport, and
  // deliberately the same day-key membership test rather than a string
  // comparison on the timestamps: PostgREST renders `created_at` with a
  // numeric offset and microsecond precision, which does not order
  // lexicographically against an ISO string built here.
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const from = new Date(todayUtc.getTime() - (days - 1) * 86_400_000);

  // Every date in the window, so a quiet day renders as zero rather
  // than closing the chart up.
  const buckets = new Map<string, UsageDayPoint>();
  for (let i = 0; i < days; i++) {
    const key = new Date(from.getTime() + i * 86_400_000).toISOString().slice(0, 10);
    buckets.set(key, { date: key, inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 });
  }

  const byVendor = new Map<string, UsageGroup>();
  const byModel  = new Map<string, UsageGroup>();
  const byKind   = new Map<string, UsageGroup>();

  let inputTokens = 0;
  let outputTokens = 0;
  let calls = 0;
  let reportedTokens = 0;
  let estimatedTokens = 0;
  let reportedCalls = 0;
  let estimatedCalls = 0;
  let errorCalls = 0;

  let amount = 0;
  let pricedCalls = 0;
  let unpricedCalls = 0;
  let pricedAt: string | null = null;

  for (const r of rows) {
    const bucket = buckets.get(dayKey(r.created_at));
    if (!bucket) continue;   // outside the window

    const input  = r.input_tokens ?? 0;
    const output = r.output_tokens ?? 0;
    const total  = input + output;

    calls++;
    inputTokens  += input;
    outputTokens += output;
    if (r.outcome === 'error') errorCalls++;

    // Anything that is not the literal 'reported' counts as estimated,
    // which is an allow-list rather than a deny-list on purpose: a row
    // written by a future Worker with a source this build has never
    // heard of must not be presented as vendor-confirmed.
    if (r.source === 'reported') { reportedCalls++; reportedTokens += total; }
    else { estimatedCalls++; estimatedTokens += total; }

    bucket.calls++;
    bucket.inputTokens  += input;
    bucket.outputTokens += output;
    bucket.totalTokens  += total;

    const { price } = resolvePrice({ vendor: r.vendor, model: r.model });
    let cost: number | null = null;
    if (price) {
      cost = costOf(r, price);
      amount += cost;
      pricedCalls++;
      // The OLDEST rate in play: the honest claim about a blended
      // figure is how stale its stalest input is.
      if (pricedAt === null || price.pricedAt < pricedAt) pricedAt = price.pricedAt;
    } else {
      unpricedCalls++;
    }

    addTo(byVendor, r.vendor, r, cost);
    addTo(byModel,  r.model,  r, cost, r.vendor);
    addTo(byKind,   r.kind,   r, cost);
  }

  const totalTokens = inputTokens + outputTokens;

  return {
    range: { days, from: from.toISOString(), to: now.toISOString() },
    totals: {
      inputTokens, outputTokens, totalTokens, calls,
      reportedTokens, estimatedTokens, reportedCalls, estimatedCalls,
      errorCalls,
    },
    estimatedShare: totalTokens ? estimatedTokens / totalTokens : null,
    // Null when NOTHING resolved a price. A spend of zero — every call
    // on a local model — is a measurement, and comes back as an amount
    // of 0 with pricedCalls above zero.
    cost: pricedCalls === 0 ? null : { amount, currency: 'USD', pricedCalls, unpricedCalls, pricedAt },
    byVendor: ranked(byVendor),
    byModel:  ranked(byModel),
    byKind:   ranked(byKind),
    series: [...buckets.values()],
    truncated: rows.length >= cap,
  };
}
