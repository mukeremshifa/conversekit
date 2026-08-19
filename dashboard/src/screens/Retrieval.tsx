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
// ----------------------------------------------------------------
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { endpoints, type Bot, type RagConfig } from '@/lib/api';
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Field, Input, Switch,
} from '@/components/ui';
import { Header } from '@/screens/Providers';

/** Mirrors ragConfigFor in src/rag/ingest.ts. */
const DEFAULTS: Required<RagConfig> = {
  enabled: true,
  top_k: 5,
  min_similarity: 0.3,
  chunk_size: 800,
  chunk_overlap: 120,
  context_chars: 6000,
  priority_boost: 0.05,
  lexical_fallback: true,
};

export function Retrieval({
  bot, onSaved, embedded = false,
}: {
  bot: Bot;
  onSaved: (b: Bot) => void;
  /** Rendered inside the Knowledge screen, which owns the page header. */
  embedded?: boolean;
}) {
  const [cfg, setCfg] = useState<Required<RagConfig>>({ ...DEFAULTS, ...(bot.rag_config ?? {}) });
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
            <Field label="Minimum similarity" hint="0–1">
              <Input
                type="number" step="0.05" min={0} max={1}
                value={cfg.min_similarity}
                onChange={(e) => set({ min_similarity: Number(e.target.value) })}
              />
            </Field>
          </div>
          <p className="text-xs text-muted leading-relaxed">
            Raise the threshold if the bot cites irrelevant passages; lower it if it says
            &ldquo;I don&rsquo;t know&rdquo; about things you know are indexed.
          </p>
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
