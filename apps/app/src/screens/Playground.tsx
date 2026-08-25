// ----------------------------------------------------------------
// Playground
//
// Try a bot without deploying it. Until this existed there was no way
// to test one at all: /v1/chat enforces the origin lock, so you had to
// paste the embed snippet onto a site you controlled at exactly the
// right hostname just to see whether the bot answered.
//
// Turns are ephemeral — the API reads no history and persists nothing,
// so testing cannot pollute real transcripts or capture a fake lead.
// ----------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { RotateCcw, Send } from 'lucide-react';
import { endpoints, type Bot, type PreviewTurn } from '@/lib/api';
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Muted, Spinner,
} from '@/components/ui';
import { Header } from '@/screens/Providers';

interface Meta { vendor: string; model: string; usage: { inputTokens: number | null; outputTokens: number | null } }

export function Playground({ bot }: { bot: Bot }) {
  const [turns, setTurns] = useState<PreviewTurn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<Meta | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Switching bots must not carry a conversation across.
  useEffect(() => { setTurns([]); setMeta(null); }, [bot.id]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [turns, busy]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy) return;

    const history = turns;
    setTurns([...history, { role: 'user', content: message }]);
    setInput('');
    setBusy(true);

    try {
      const res = await endpoints.preview(bot.id, { message, history });
      setTurns((prev) => [...prev, { role: 'assistant', content: res.reply }]);
      setMeta({ vendor: res.vendor, model: res.model, usage: res.usage });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Preview failed';
      toast.error(msg);
      // Drop the unanswered turn so a retry does not duplicate it.
      setTurns(history);
      setInput(message);
    } finally {
      setBusy(false);
    }
  }

  const starters = bot.suggestions?.length
    ? bot.suggestions
    : ['What services do you offer?', 'What are your opening hours?', 'How can I contact you?'];

  return (
    <>
      <Header
        title="Playground"
        subtitle="Talk to this bot exactly as a visitor would — no embedding, no origin lock, nothing saved."
        action={
          <Button variant="outline" onClick={() => { setTurns([]); setMeta(null); }} disabled={!turns.length}>
            <RotateCcw className="h-3.5 w-3.5" /> Reset
          </Button>
        }
      />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{bot.name}</CardTitle>
            <CardDescription>
              {meta
                ? `Answering with ${meta.vendor} · ${meta.model}${
                    meta.usage.outputTokens ? ` · ${meta.usage.inputTokens ?? '?'}→${meta.usage.outputTokens} tokens` : ''
                  }`
                : 'Send a message to see which vendor and model answer.'}
            </CardDescription>
          </div>
        </CardHeader>

        <CardContent>
          <div className="min-h-64 space-y-3 rounded-lg border border-border bg-bg p-4">
            {turns.length === 0 && !busy && (
              <div className="space-y-3 py-6 text-center">
                <Muted className="text-sm">No messages yet. Try one of these:</Muted>
                <div className="flex flex-wrap justify-center gap-2">
                  {starters.map((s) => (
                    <Button key={s} variant="outline" size="sm" onClick={() => send(s)}>{s}</Button>
                  ))}
                </div>
              </div>
            )}

            {turns.map((t, i) => (
              <div key={i} className={t.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className={
                    t.role === 'user'
                      ? 'max-w-[80%] rounded-2xl rounded-br-sm bg-fg/8 px-3.5 py-2 text-[13px] leading-relaxed text-fg'
                      : 'max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-bl-sm border border-border bg-surface px-3.5 py-2 text-[13px] leading-relaxed'
                  }
                >
                  {t.content}
                </div>
              </div>
            ))}

            {busy && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-border bg-surface px-3.5 py-2 text-muted">
                  <Spinner /> <span className="text-xs">thinking…</span>
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <form
            className="flex gap-2"
            onSubmit={(e) => { e.preventDefault(); void send(input); }}
          >
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask the bot something…"
              disabled={busy}
            />
            <Button type="submit" disabled={busy || !input.trim()} aria-label="Send">
              <Send className="h-4 w-4" />
            </Button>
          </form>

          <Muted className="text-xs">
            Retrieval runs exactly as it does in production, so this is a real test of your
            Knowledge Sources. Nothing here is written to Conversations or Leads.
          </Muted>
        </CardContent>
      </Card>
    </>
  );
}
