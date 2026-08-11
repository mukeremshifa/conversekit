// ----------------------------------------------------------------
// Retrieval settings — the RAG knobs that had no UI until now.
//
// Four knobs, deliberately. "Configurable RAG" expands without limit
// (rerankers, hybrid search, query rewriting) and every knob is a
// support surface; these are the ones that actually change answers.
// ----------------------------------------------------------------
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { endpoints, type Bot, type RagConfig } from '@/lib/api';
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Field, Input, Switch,
} from '@/components/ui';
import { Header } from '@/screens/Providers';

const DEFAULTS: Required<RagConfig> = {
  enabled: true,
  top_k: 5,
  min_similarity: 0.3,
  chunk_size: 800,
  chunk_overlap: 120,
};

export function Retrieval({ bot, onSaved }: { bot: Bot; onSaved: (b: Bot) => void }) {
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

  return (
    <>
      <Header
        title="Retrieval"
        subtitle="How the bot searches your knowledge sources before answering."
        action={<Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>}
      />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Enabled</CardTitle>
            <CardDescription>
              When off, the bot answers only from its Knowledge Base fields and ignores every indexed source.
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
