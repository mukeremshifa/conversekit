// ----------------------------------------------------------------
// "What would this retrieve?"
//
// The chunk inspector answers *what is indexed*. This answers *what
// comes back*, which is the question anyone actually has when a bot
// answers badly — and until now the only way to find out was to read
// the Worker's logs.
//
// It runs the real retrieval path, fallback and all, rather than a
// reimplementation of it: a preview that is only approximately what
// production does is worse than none, because it is trusted.
//
// It is also what makes the knowledge cutover safe. A tenant can ask
// their five most common questions here and see them land BEFORE
// flipping the flag that stops pasting the FAQ into every prompt.
// ----------------------------------------------------------------
import { useState } from 'react';
import { toast } from 'sonner';
import { Search, Sparkles, Type } from 'lucide-react';
import { endpoints, type Bot, type RetrievePreview as Result } from '@/lib/api';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Input, Muted,
} from '@/components/ui';

export function RetrievePreview({ bot }: { bot: Bot }) {
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function run() {
    const q = query.trim();
    if (!q) { toast.error('Type a question first'); return; }
    setBusy(true);
    try {
      setResult(await endpoints.retrievePreview(bot.id, q));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not run that search');
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>What would this retrieve?</CardTitle>
          <CardDescription>
            Ask something a visitor would ask. This runs the same search the bot runs, with this
            bot&rsquo;s current settings — nothing is sent to the AI model and no conversation is
            recorded.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
            placeholder="Do you accept insurance?"
            aria-label="Test query"
          />
          <Button onClick={run} disabled={busy}>
            <Search className="h-3.5 w-3.5" /> {busy ? 'Searching…' : 'Search'}
          </Button>
        </div>

        {result && <Outcome result={result} />}
      </CardContent>
    </Card>
  );
}

function Outcome({ result }: { result: Result }) {
  if (result.skipped === 'disabled') {
    return (
      <Muted className="mt-4 text-sm">
        Retrieval is switched off for this bot, so nothing is searched. Turn it on below.
      </Muted>
    );
  }
  if (result.skipped === 'empty-query') {
    return <Muted className="mt-4 text-sm">Too short to search — try a whole question.</Muted>;
  }
  if (result.error) {
    return <p className="mt-4 text-sm text-danger">Search failed: {result.error}</p>;
  }

  if (result.chunks.length === 0) {
    return (
      <div className="mt-4 space-y-2">
        <p className="text-sm font-medium">Nothing came back.</p>
        <Muted className="text-sm">
          The bot would answer from its own business details alone and say it does not know.
          Either nothing indexed covers this, or the minimum similarity of{' '}
          {result.settings.min_similarity} is too high for how it is worded.
        </Muted>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>
          {result.chunks.length} passage{result.chunks.length === 1 ? '' : 's'} · found by
        </span>
        {result.channel === 'lexical' ? (
          <Badge tone="wait"><Type className="mr-1 h-3 w-3" /> keyword fallback</Badge>
        ) : (
          <Badge tone="ok"><Sparkles className="mr-1 h-3 w-3" /> meaning</Badge>
        )}
        <span>· {result.context.length} characters of {result.settings.context_chars} budget</span>
      </div>

      {result.channel === 'lexical' && (
        <Muted className="text-xs leading-relaxed">
          Nothing was close enough by meaning, so this fell back to matching words against your FAQ.
          That rescue only covers FAQ items — the same question against a document would have found
          nothing.
        </Muted>
      )}

      <div className="divide-y divide-border">
        {result.chunks.map((chunk, i) => (
          <div key={chunk.id} className="flex gap-3 py-3">
            <span className="w-6 shrink-0 pt-0.5 text-xs font-bold text-muted">{i + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="font-medium text-ink">{chunk.document_title ?? 'Untitled source'}</span>
                {chunk.kind === 'faq' && <Badge tone="ok">FAQ</Badge>}
                {chunk.priority > 0 && <Badge tone="wait">boosted</Badge>}
                {/* Labelled by channel rather than rescaled: a cosine
                    similarity and a text rank are not the same
                    measurement, and a shared "score" column would be a
                    lie that reads like one. */}
                <span className="tabular-nums">
                  {chunk.channel === 'lexical' ? 'rank' : 'similarity'} {chunk.score.toFixed(3)}
                </span>
              </div>
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">
                {chunk.content}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
