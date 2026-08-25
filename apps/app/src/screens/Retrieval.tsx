// ----------------------------------------------------------------
// Retrieval — how the bot finds an answer, and whether it did.
//
// Its own nav entry rather than a tab of the Knowledge Base, because it
// is a different question: the Knowledge Base is what the bot knows,
// this is the search over it.
//
// Four parts, in the order someone debugging a bad answer needs them:
// the numbers that say whether anything is wrong, the questions real
// visitors asked and missed, what a query of your own retrieves, and
// the settings that govern all of it.
//
// The settings are the RAG knobs, and they are deliberately few.
// "Configurable RAG" expands without limit (rerankers, hybrid search,
// query rewriting) and every knob is a support surface; these are the
// ones that actually change answers. Three of them default to today's
// behaviour rather than to the better-sounding one, because hybrid
// search can quietly stop the bot ever saying "I don't know",
// re-ranking costs a model call on the visitor's hot path, and the
// router changes which messages search at all. None of those is a
// setting the platform should make on a tenant's behalf.
//
// Grouped and sized like Bot Configuration since the redesign, and
// sharing its Section/SettingRow/SaveBar primitives rather than a
// private copy of them. The per-section save is the same pattern too,
// and for a sharper reason here: rag_config is one jsonb column the API
// replaces wholesale, so every save has to send the whole object, built
// from the last saved values with only its own section overlaid.
// ----------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Gauge, ListChecks, RefreshCw, SearchX, Zap } from 'lucide-react';
import {
  ApiError, endpoints,
  type Bot, type EffectiveRetrieval, type MissReport as Report, type RagConfig,
} from '@/lib/api';
import {
  Button, Card, CardContent, Input, Rows, SaveBar, Section, Select, SelectContent,
  SelectItem, SelectTrigger, SelectValue, SettingRow, Stat, StatSkeleton, Switch,
} from '@/components/ui';
import { Header } from '@/screens/Providers';
import { MissReport } from '@/screens/knowledge/MissReport';
import { RetrievePreview } from '@/screens/knowledge/RetrievePreview';

const RANGES = [7, 30, 90];

/**
 * Mirrors ragConfigFor in src/rag/ingest.ts — with one deliberate hole.
 *
 * `min_similarity` IS NOT HERE, and that is the point. There is no
 * platform default any more: the floor is resolved from the embedding
 * model that will actually run the query, so the number this screen
 * used to present as "the default, 0.3" was wrong for every bot on the
 * platform embedder, whose measured floor is twice that. Presenting a
 * stale constant as a default is the same class of lie the whole B1
 * change exists to remove.
 *
 * What the field shows instead is the EFFECTIVE floor and where it came
 * from, fetched from the bot's own retrieval preview.
 */
const DEFAULTS: Omit<Required<RagConfig>, 'min_similarity'> = {
  enabled: true,
  top_k: 5,
  chunk_size: 800,
  chunk_overlap: 120,
  context_chars: 6000,
  priority_boost: 0.05,
  lexical_fallback: true,
  retrieval_mode: 'fallback',
  rerank: false,
  router: 'off',
  faq_shortcut_threshold: 0,
};

export function Retrieval({
  bot, onSaved, onAddFaq,
}: {
  bot: Bot;
  onSaved: (b: Bot) => void;
  /** Hand a missed question to the FAQ editor on the Knowledge Base,
   *  prefilled. Crosses screens now that this is one of its own. */
  onAddFaq: (question: string) => void;
}) {
  /** What actually governed the last preview search. Lifted out of
   *  RetrievePreview so the settings below can show the floor in force
   *  rather than a constant that is wrong for every bot on the platform
   *  embedder. */
  const [effective, setEffective] = useState<EffectiveRetrieval | null>(null);

  // The report is fetched here rather than inside the list, because its
  // totals are the cards at the top of the page and its questions are
  // the list further down. One fetch, one range control, two readers.
  const [days, setDays] = useState(30);
  const [report, setReport] = useState<Report | null>(null);
  /** Set when the endpoint is unavailable rather than empty. The two
   *  look identical in a bare list and mean opposite things. */
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const load = useCallback(async () => {
    setReport(null);
    setUnavailable(null);
    try {
      setReport(await endpoints.missReport(bot.id, days));
    } catch (err) {
      // 501 is "migration 012 has not been applied", which is a
      // deployment state and not something to shout at a tenant about.
      if (err instanceof ApiError && err.status === 501) {
        setUnavailable(err.message);
        return;
      }
      toast.error(err instanceof Error ? err.message : 'Could not load the retrieval report');
    }
  }, [bot.id, days]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="space-y-10">
      <Header
        title="Retrieval"
        subtitle="How your bot searches your knowledge base before it answers, and what it could not find."
        action={
          <div className="flex items-center gap-2">
            <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
              <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {RANGES.map((d) => <SelectItem key={d} value={String(d)}>Last {d} days</SelectItem>)}
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        }
      />

      <Headline report={report} unavailable={unavailable} />

      <Section
        title="Questions your bot could not answer"
        description="Real questions from visitors where nothing in your knowledge base was close enough to use. Write an answer for the ones worth answering, and remove the rest."
      >
        <MissReport
          bot={bot}
          report={report}
          unavailable={unavailable}
          onAddFaq={onAddFaq}
          onChanged={() => void load()}
        />
      </Section>

      <Section
        title="Test a search"
        description="Ask something a visitor would ask and see exactly what the bot would find. Nothing is sent to the AI model and no conversation is recorded."
      >
        <RetrievePreview bot={bot} onEffective={setEffective} />
      </Section>

      <RetrievalSettings bot={bot} onSaved={onSaved} effective={effective} />
    </div>
  );
}

// ── The numbers ───────────────────────────────────────────────────

/**
 * The three figures that say whether any of the settings below need
 * touching, as cards rather than as the run-on line of small print they
 * used to be.
 *
 * The miss rate on its own is not actionable: some misses are visitors
 * asking about the weather. What makes it readable is the pair beside
 * it. A typical match sitting just above the floor means the floor is
 * doing the rejecting; a wide gap means the misses are genuinely
 * off-topic and no amount of tuning will help.
 */
function Headline({ report, unavailable }: { report: Report | null; unavailable: string | null }) {
  if (unavailable) return null;

  if (report === null) {
    // Stat's own shape, so the four tiles do not grow a row taller when
    // the numbers arrive.
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">
        {[0, 1, 2, 3].map((i) => <StatSkeleton key={i} />)}
      </div>
    );
  }

  const { totals, scores, questions } = report;
  const rate = totals.missRate === null ? null : Math.round(totals.missRate * 100);
  const noSearch = totals.noSearchRate === null || totals.noSearchRate === undefined
    ? null
    : Math.round(totals.noSearchRate * 100);

  return (
    <div className="ck-stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Stat
        icon={SearchX}
        label="Found nothing"
        value={rate === null ? 'n/a' : `${rate}%`}
        tone={rate === null ? undefined : rate > 40 ? 'bad' : rate > 15 ? 'warn' : 'ok'}
        hint={`${totals.misses.toLocaleString()} of ${totals.queries.toLocaleString()} searches came back empty`}
      />
      <Stat
        icon={Zap}
        label="No search needed"
        value={noSearch === null ? 'n/a' : `${noSearch}%`}
        hint="Messages the bot answered without looking anything up"
      />
      <Stat
        icon={Gauge}
        label="Typical match"
        value={scores.hitMedian === null ? 'n/a' : scores.hitMedian.toFixed(2)}
        hint={scores.floor === null
          ? 'How closely a found passage matched the question'
          : `The minimum this bot accepts is ${scores.floor}`}
      />
      <Stat
        icon={ListChecks}
        label="To answer"
        value={questions.length.toLocaleString()}
        hint="Different questions worth an answer, listed below"
      />
    </div>
  );
}

// ── Settings ──────────────────────────────────────────────────────

/** `min_similarity` absent means "no override" — the resolved floor
 *  applies. Every other key always has a value. */
type Draft = Omit<Required<RagConfig>, 'min_similarity'> & { min_similarity?: number };

/**
 * Which setting each section owns.
 *
 * Load bearing, not documentation. rag_config is one jsonb column the
 * API replaces wholesale, so a save has to send every key in it.
 * Sending them straight from the working draft would quietly save a
 * neighbouring section's unsaved edits too, so a save builds its payload
 * from the last saved values with only its own keys overlaid.
 */
const OWNED = {
  search: ['enabled', 'top_k', 'min_similarity', 'retrieval_mode', 'rerank', 'router', 'context_chars'],
  faq:    ['priority_boost', 'faq_shortcut_threshold', 'lexical_fallback'],
  index:  ['chunk_size', 'chunk_overlap'],
} satisfies Record<string, (keyof Draft)[]>;

type SectionId = keyof typeof OWNED;

function RetrievalSettings({
  bot, onSaved, effective,
}: {
  bot: Bot;
  onSaved: (b: Bot) => void;
  /**
   * What actually governed the last search this bot ran, from the
   * preview card above. Null until someone runs one.
   *
   * Passed in rather than fetched, because the only way to learn the
   * effective floor is to resolve the embedder and ask it — the preview
   * has already paid for that, and doing it again on mount would spend
   * an embedding call per page view to render one number.
   */
  effective: EffectiveRetrieval | null;
}) {
  const [cfg, setCfg] = useState<Draft>({ ...DEFAULTS, ...(bot.rag_config ?? {}) });
  /** The last saved values. Sections diff against this to know whether
   *  they are dirty, and build their payloads from it. */
  const [saved, setSaved] = useState<Draft>({ ...DEFAULTS, ...(bot.rag_config ?? {}) });
  const [busy, setBusy] = useState<SectionId | null>(null);

  // Keyed on the bot id, NOT on the config object. A save replaces the
  // bot prop, and resetting here would throw away every other section's
  // unsaved edits; the section that saved has already synced `saved`
  // itself.
  useEffect(() => {
    setCfg({ ...DEFAULTS, ...(bot.rag_config ?? {}) });
    setSaved({ ...DEFAULTS, ...(bot.rag_config ?? {}) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  const set = (patch: Partial<Draft>) => setCfg((c) => ({ ...c, ...patch }));

  const isDirty = (id: SectionId) =>
    (OWNED[id] as (keyof Draft)[]).some((k) => JSON.stringify(cfg[k]) !== JSON.stringify(saved[k]));

  async function save(id: SectionId) {
    // Last saved values, with only this section's keys overlaid.
    const merged = { ...saved } as Draft;
    for (const k of OWNED[id] as (keyof Draft)[]) {
      (merged as Record<string, unknown>)[k] = cfg[k];
    }

    setBusy(id);
    try {
      const updated = await endpoints.updateBot(bot.id, { rag_config: merged });
      onSaved(updated);
      setSaved(merged);
      toast.success('Saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <Section
        title="Search"
        description="Applied to every message. Changes take effect right away."
      >
        <Card>
          <CardContent className="pb-0">
            <Rows>
              <SettingRow
                label="Search your knowledge base"
                description="When this is off, the bot answers from your business details and instructions alone and never looks at an indexed source."
              >
                <Switch
                  checked={cfg.enabled}
                  onCheckedChange={(v) => set({ enabled: v })}
                  aria-label="Search the knowledge base"
                />
              </SettingRow>

              <SettingRow
                label="Passages retrieved"
                description="How many pieces of your knowledge base one answer may draw on. Between 1 and 20."
              >
                <Input
                  type="number" min={1} max={20}
                  value={cfg.top_k}
                  onChange={(e) => set({ top_k: Number(e.target.value) })}
                />
              </SettingRow>

              <SettingRow
                label="Minimum match strength"
                align="start"
                description={
                  <>
                    How close a passage has to be before the bot will use it, from 0 to 1. Raise it
                    if the bot quotes material that is beside the point; lower it if it says it does
                    not know about something you have added.{' '}
                    <FloorNote effective={effective} overridden={cfg.min_similarity !== undefined} />
                  </>
                }
              >
                <Input
                  type="number" step="0.05" min={0} max={1}
                  // Empty means "no override", which is a real state and
                  // not the same as 0 — 0 is a floor that accepts
                  // everything, and it used to be unreachable because the
                  // field could never be cleared.
                  value={cfg.min_similarity ?? ''}
                  placeholder={effective ? String(effective.min_similarity) : 'model default'}
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    set({ min_similarity: raw === '' ? undefined : Number(raw) });
                  }}
                />
              </SettingRow>

              <SettingRow
                label="Search method"
                align="start"
                description={
                  <>
                    Searching by meaning catches paraphrases. Searching by keyword catches names,
                    codes and part numbers that meaning reads straight past.
                    {cfg.retrieval_mode === 'hybrid' && (
                      <> Running both every time almost always finds something, so the bot will
                        rarely conclude it has no answer. If you rely on the &ldquo;can&rsquo;t
                        answer&rdquo; message or on handing a visitor to a person after repeated
                        misses, check the figures above after a day.</>
                    )}
                  </>
                }
              >
                <Select
                  value={cfg.retrieval_mode}
                  onValueChange={(v) => set({ retrieval_mode: v as Draft['retrieval_mode'] })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="fallback">Meaning, then keywords if nothing lands</SelectItem>
                    <SelectItem value="hybrid">Both every time, combined</SelectItem>
                    <SelectItem value="vector">Meaning only</SelectItem>
                  </SelectContent>
                </Select>
              </SettingRow>

              <SettingRow
                label="Second pass ranking"
                description="Reads the question and each passage together and puts them back in order. More accurate, and it adds a noticeable pause to every reply."
              >
                <Switch
                  checked={cfg.rerank}
                  onCheckedChange={(v) => set({ rerank: v })}
                  aria-label="Second pass ranking"
                />
              </SettingRow>

              <SettingRow
                label="Skip pointless searches"
                description="Messages like “thanks” or a phone number typed on its own are not questions, so they are answered without a search. Whole messages only: “thanks, but what are your hours?” still searches."
              >
                <Switch
                  checked={cfg.router === 'on'}
                  onCheckedChange={(v) => set({ router: v ? 'on' : 'off' })}
                  aria-label="Skip pointless searches"
                />
              </SettingRow>

              <SettingRow
                label="Text budget"
                description="The most text, in characters, that one answer may take from your knowledge base, so a long passage cannot crowd out the conversation itself."
              >
                <Input
                  type="number" min={1000} max={40000} step={500}
                  value={cfg.context_chars}
                  onChange={(e) => set({ context_chars: Number(e.target.value) })}
                />
              </SettingRow>
            </Rows>
          </CardContent>
          <SaveBar busy={busy === 'search'} dirty={isDirty('search')} onSave={() => void save('search')} />
        </Card>
      </Section>

      <Section
        title="Your FAQ"
        description="Searching by meaning is usually right and occasionally unlucky. These three make sure the answers you wrote by hand are not left to chance."
      >
        <Card>
          <CardContent className="pb-0">
            <Rows>
              <SettingRow
                label="FAQ boost"
                description="Added to an FAQ item's match strength so it wins a close call, from 0 to 0.5. It cannot lift an item past the minimum above, so an FAQ answer that is beside the point stays out."
              >
                <Input
                  type="number" step="0.01" min={0} max={0.5}
                  value={cfg.priority_boost}
                  onChange={(e) => set({ priority_boost: Number(e.target.value) })}
                />
              </SettingRow>

              <SettingRow
                label="Answer straight from your FAQ"
                description="How close a visitor's wording has to be before the bot replies with your answer and skips the search, from 0 to 0.95. Set 0 to switch it off, or start at 0.5. Raise it if visitors get the wrong FAQ answer; lower it if answers you wrote are being ignored."
              >
                <Input
                  type="number" step="0.05" min={0} max={0.95}
                  value={cfg.faq_shortcut_threshold}
                  onChange={(e) => set({ faq_shortcut_threshold: Number(e.target.value) })}
                />
              </SettingRow>

              <SettingRow
                label="Keyword fallback"
                description="When nothing is close enough by meaning, match words against your FAQ before giving up. It runs only on that miss, so it costs nothing on a normal message, and it covers FAQ items rather than documents."
              >
                <Switch
                  checked={cfg.lexical_fallback}
                  onCheckedChange={(v) => set({ lexical_fallback: v })}
                  aria-label="Keyword fallback"
                />
              </SettingRow>
            </Rows>
          </CardContent>
          <SaveBar busy={busy === 'faq'} dirty={isDirty('faq')} onSave={() => void save('faq')} />
        </Card>
      </Section>

      <Section
        title="Indexing"
        description="Applied when a source is indexed. Existing sources keep their current pieces until you re-index them."
      >
        <Card>
          <CardContent className="pb-0">
            <Rows>
              <SettingRow
                label="Piece size"
                description="How much text goes into one indexed piece, in characters. Between 200 and 4000."
              >
                <Input
                  type="number" min={200} max={4000} step={50}
                  value={cfg.chunk_size}
                  onChange={(e) => set({ chunk_size: Number(e.target.value) })}
                />
              </SettingRow>

              <SettingRow
                label="Overlap"
                description="How much of each piece repeats into the next, so a fact that spans the join stays findable from either side. Capped at half the piece size."
              >
                <Input
                  type="number" min={0} max={1000} step={10}
                  value={cfg.chunk_overlap}
                  onChange={(e) => set({ chunk_overlap: Number(e.target.value) })}
                />
              </SettingRow>
            </Rows>
          </CardContent>
          <SaveBar busy={busy === 'index'} dirty={isDirty('index')} onSave={() => void save('index')} />
        </Card>
      </Section>
    </>
  );
}

/**
 * What the similarity floor actually is, and where it came from.
 *
 * This screen used to declare 0.3 as "the default". It was not: the
 * floor is resolved from the embedding model that runs the query, and
 * for the platform's own embedder the measured value is twice that — a
 * number below which two unrelated businesses' documents still score,
 * so the floor could never reject anything. Three shipped features are
 * gated on it rejecting, and all three were silently dead.
 *
 * A default a tenant reads and reasons about has to be the number that
 * runs. So this reports the resolved one and names the case worth acting
 * on: `default`, meaning nobody has measured this model and the value is
 * a guess.
 */
function FloorNote({
  effective, overridden,
}: {
  effective: EffectiveRetrieval | null;
  overridden: boolean;
}) {
  if (!effective) {
    return (
      <span>
        Leave it blank to use the figure calibrated for this bot&rsquo;s embedding model. Run a
        search above to see the one in force.
      </span>
    );
  }

  if (overridden) {
    return (
      <span>
        Currently <strong className="text-ink tabular-nums">{effective.min_similarity}</strong>, set
        by you. Leave it blank to go back to the figure calibrated for this bot&rsquo;s embedding
        model.
      </span>
    );
  }

  return (
    <span>
      Currently <strong className="text-ink tabular-nums">{effective.min_similarity}</strong>
      {effective.floor_source === 'model'
        ? <>, calibrated for <code>{effective.embedding_model}</code>.</>
        : <>, a fallback, because nothing on this deployment has measured{' '}
            <code>{effective.embedding_model}</code> yet. Treat it as a starting point rather than a
            recommendation.</>}
    </span>
  );
}
