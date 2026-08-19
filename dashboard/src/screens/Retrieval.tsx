// ----------------------------------------------------------------
// Retrieval settings — the RAG knobs that had no UI until now.
//
// Deliberately few. "Configurable RAG" expands without limit
// (rerankers, hybrid search, query rewriting) and every knob is a
// support surface; these are the ones that actually change answers.
//
// 011 added three: a character budget on what retrieval may put in the
// prompt, the FAQ boost, and the keyword fallback. Each is here rather
// than hardcoded because each is a judgement call a tenant can be
// wrong about in either direction.
//
// 013 added two more, and both default to today's behaviour rather than
// to the better-sounding one. Hybrid search changes what every message
// retrieves and can quietly stop the bot ever saying "I don't know";
// re-ranking costs a model call on the visitor's hot path. Neither is a
// setting the platform should make on a tenant's behalf.
// ----------------------------------------------------------------
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { endpoints, type Bot, type EffectiveRetrieval, type RagConfig } from '@/lib/api';
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch,
} from '@/components/ui';
import { Header } from '@/screens/Providers';

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
 * from, fetched from the bot's own retrieval preview — see
 * EffectiveFloor below.
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
};

/** `min_similarity` absent means "no override" — the resolved floor
 *  applies. Every other key always has a value. */
type Draft = Omit<Required<RagConfig>, 'min_similarity'> & { min_similarity?: number };

export function Retrieval({
  bot, onSaved, embedded = false, effective = null,
}: {
  bot: Bot;
  onSaved: (b: Bot) => void;
  /** Rendered inside the Knowledge screen, which owns the page header. */
  embedded?: boolean;
  /**
   * What actually governed the last search this bot ran, from the
   * preview card above. Null until someone runs one.
   *
   * Passed in rather than fetched, because the only way to learn the
   * effective floor is to resolve the embedder and ask it — the preview
   * has already paid for that, and doing it again on mount would spend
   * an embedding call per page view to render one number.
   */
  effective?: EffectiveRetrieval | null;
}) {
  const [cfg, setCfg] = useState<Draft>({ ...DEFAULTS, ...(bot.rag_config ?? {}) });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCfg({ ...DEFAULTS, ...(bot.rag_config ?? {}) });
  }, [bot.id, bot.rag_config]);

  async function save() {
    setBusy(true);
    try {
      const updated = await endpoints.updateBot(bot.id, { rag_config: cfg });
      onSaved(updated);
      toast.success('Retrieval settings saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const set = (patch: Partial<RagConfig>) => setCfg({ ...cfg, ...patch });

  const saveButton = (
    <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>
  );

  return (
    <>
      {embedded ? (
        <div className="flex justify-end">{saveButton}</div>
      ) : (
        <Header
          title="Retrieval"
          subtitle="How the bot searches your knowledge sources before answering."
          action={saveButton}
        />
      )}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Enabled</CardTitle>
            <CardDescription>
              When off, the bot ignores every indexed source and answers only from its own business
              details and instructions.
            </CardDescription>
          </div>
          <Switch
            checked={cfg.enabled}
            onCheckedChange={(v) => set({ enabled: v })}
            aria-label="Enable retrieval"
          />
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Search</CardTitle>
            <CardDescription>Applied on every message. Changes take effect immediately.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Passages retrieved" hint="top_k, 1–20">
              <Input
                type="number" min={1} max={20}
                value={cfg.top_k}
                onChange={(e) => set({ top_k: Number(e.target.value) })}
              />
            </Field>
            <Field
              label="Minimum similarity"
              hint={effective ? `0–1 · leave blank for ${effective.min_similarity}` : '0–1 · leave blank for the model default'}
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
                  setCfg({ ...cfg, min_similarity: raw === '' ? undefined : Number(raw) });
                }}
              />
            </Field>
          </div>
          <p className="text-xs text-muted leading-relaxed">
            Raise the threshold if the bot cites irrelevant passages; lower it if it says
            &ldquo;I don&rsquo;t know&rdquo; about things you know are indexed.
          </p>
          <EffectiveFloor effective={effective} overridden={cfg.min_similarity !== undefined} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Making sure your FAQ still lands</CardTitle>
            <CardDescription>
              Searching by meaning is usually right and occasionally unlucky. These two exist so the
              answers you wrote by hand are not left to chance.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="FAQ boost" hint="0–0.5, added to similarity when ranking">
              <Input
                type="number" step="0.01" min={0} max={0.5}
                value={cfg.priority_boost}
                onChange={(e) => set({ priority_boost: Number(e.target.value) })}
              />
            </Field>
            <Field label="Prompt budget" hint="characters, 1000–40000">
              <Input
                type="number" min={1000} max={40000} step={500}
                value={cfg.context_chars}
                onChange={(e) => set({ context_chars: Number(e.target.value) })}
              />
            </Field>
          </div>
          <p className="text-xs leading-relaxed text-muted">
            The boost breaks near-ties in favour of an FAQ answer. It cannot push a passage past the
            minimum similarity — an irrelevant FAQ item stays out however high you set it.
            The budget caps how much retrieved text may go into one message, so a long answer can
            never crowd out the conversation itself.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Keyword fallback</CardTitle>
            <CardDescription>
              When nothing at all is close enough by meaning, try matching words against your FAQ
              before giving up. It runs only on that miss, so it costs nothing on a normal message —
              and it is what catches &ldquo;do u take insurance&rdquo; against &ldquo;Do you accept
              insurance?&rdquo;. It covers FAQ items only, not documents.
            </CardDescription>
          </div>
          <Switch
            checked={cfg.lexical_fallback}
            onCheckedChange={(v) => set({ lexical_fallback: v })}
            aria-label="Keyword fallback"
          />
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>How search runs</CardTitle>
            <CardDescription>
              Two ways to find a passage: by meaning, and by the words in it. This is when each
              one runs.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <Field label="Search mode">
            <Select
              value={cfg.retrieval_mode}
              onValueChange={(v) => set({ retrieval_mode: v as Draft['retrieval_mode'] })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="fallback">Meaning, then keywords if nothing lands</SelectItem>
                <SelectItem value="hybrid">Both every time, merged</SelectItem>
                <SelectItem value="vector">Meaning only</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <p className="text-xs leading-relaxed text-muted">
            The default runs the keyword search only when nothing at all was close enough by
            meaning, and only over your FAQ. <strong className="text-ink">Both every time</strong>{' '}
            runs it over every source on every message and merges the two rankings, which finds
            names, codes and part numbers that meaning-based search reads straight past — at the
            cost of a second query per message.
          </p>
          {cfg.retrieval_mode === 'hybrid' && (
            <p className="rounded-md border border-warning/25 bg-warning/10 px-3 py-2 text-xs leading-relaxed text-ink">
              Worth knowing before you leave this on: keyword search almost always finds{' '}
              <em>something</em>, so the bot will rarely conclude it has no answer. If you rely on
              the &ldquo;can&rsquo;t answer&rdquo; message or on handing off after repeated misses,
              check the questions report after a day — a miss rate that drops to near zero means
              those have stopped firing rather than that the bot got better.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Second-pass ranking</CardTitle>
            <CardDescription>
              Read the question and each passage together, and reorder them. Slower and more
              accurate than the first pass, which compares them separately.
            </CardDescription>
          </div>
          <Switch
            checked={cfg.rerank}
            onCheckedChange={(v) => set({ rerank: v })}
            aria-label="Second-pass ranking"
          />
        </CardHeader>
        <CardContent>
          <p className="text-xs leading-relaxed text-muted">
            It costs one extra model call per message, so it shows up as latency the visitor can
            feel. It can only reorder passages that already cleared the minimum similarity — it
            never brings back one that was rejected, so it is not a substitute for lowering the
            threshold.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Chunking</CardTitle>
            <CardDescription>
              Applied when a source is indexed — existing sources keep their current chunks until you reindex them.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Chunk size" hint="characters, 200–4000">
              <Input
                type="number" min={200} max={4000} step={50}
                value={cfg.chunk_size}
                onChange={(e) => set({ chunk_size: Number(e.target.value) })}
              />
            </Field>
            <Field label="Chunk overlap" hint="characters, 0–1000">
              <Input
                type="number" min={0} max={1000} step={10}
                value={cfg.chunk_overlap}
                onChange={(e) => set({ chunk_overlap: Number(e.target.value) })}
              />
            </Field>
          </div>
          <p className="text-xs text-muted leading-relaxed">
            Overlap repeats the tail of each chunk into the next, so a fact spanning a boundary
            stays retrievable from either side. Overlap is capped at half the chunk size.
          </p>
        </CardContent>
      </Card>
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
 * runs. So this reports the resolved one and names its provenance,
 * including the case worth acting on — `default`, meaning nobody has
 * measured this model and the value is a guess.
 */
function EffectiveFloor({
  effective, overridden,
}: {
  effective: EffectiveRetrieval | null;
  overridden: boolean;
}) {
  if (!effective) {
    return (
      <p className="text-xs leading-relaxed text-muted">
        Leave this blank to use the floor calibrated for whichever embedding model this bot uses —
        different models score on different scales, so there is no one right number. Run a search in
        &ldquo;What would this retrieve?&rdquo; above to see the one in force.
      </p>
    );
  }

  return (
    <p className="text-xs leading-relaxed text-muted">
      Currently <strong className="text-ink tabular-nums">{effective.min_similarity}</strong>
      {overridden
        ? ', set by you here.'
        : effective.floor_source === 'model'
          ? <>, calibrated for <code>{effective.embedding_model}</code>.</>
          : <>
              {' '}— a fallback, because nothing on this deployment has measured{' '}
              <code>{effective.embedding_model}</code> yet. Treat it as a starting point rather than
              a recommendation.
            </>}
      {' '}Scores are not comparable between embedding models: changing the model changes what this
      number means, not just how strict it is.
    </p>
  );
}
