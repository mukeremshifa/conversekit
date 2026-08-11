import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw } from 'lucide-react';
import { endpoints, type Bot, type Message } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Muted, Spinner,
} from '@/components/ui';
import { Header } from '@/screens/Providers';

export function Conversations({ bot }: { bot: Bot }) {
  const [messages, setMessages] = useState<Message[] | null>(null);

  const load = useCallback(async () => {
    setMessages(null);
    try {
      setMessages((await endpoints.conversations(bot.id)).conversations);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load conversations');
      setMessages([]);
    }
  }, [bot.id]);

  useEffect(() => { void load(); }, [load]);

  // The API returns newest-first; a transcript only reads correctly
  // oldest-first within each session.
  const sessions = useMemo(() => {
    const grouped = new Map<string, Message[]>();
    for (const m of [...(messages ?? [])].reverse()) {
      const list = grouped.get(m.session_id) ?? [];
      list.push(m);
      grouped.set(m.session_id, list);
    }
    return [...grouped.entries()].reverse();
  }, [messages]);

  return (
    <>
      <Header title="Conversations" subtitle="Recent visitor transcripts, grouped by session." />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{sessions.length} session{sessions.length === 1 ? '' : 's'}</CardTitle>
            <CardDescription>Most recent first, up to the last 100 messages.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-3.5 w-3.5" /> Refresh</Button>
        </CardHeader>
        <CardContent>
          {messages === null ? (
            <div className="flex items-center gap-2 text-muted"><Spinner /> Loading…</div>
          ) : sessions.length === 0 ? (
            <Muted className="text-sm">No conversations yet.</Muted>
          ) : (
            <div className="space-y-6">
              {sessions.map(([sid, msgs]) => (
                <div key={sid}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="font-mono text-xs text-muted">{sid.slice(0, 20)}…</span>
                    <span className="h-px flex-1 bg-border" />
                    <span className="text-xs text-muted">{formatDate(msgs[0]?.created_at)}</span>
                  </div>
                  <div className="space-y-2">
                    {msgs.map((m) => (
                      <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                        <div
                          className={
                            m.role === 'user'
                              ? 'max-w-[80%] rounded-2xl rounded-br-sm bg-accent px-3.5 py-2 text-[13px] leading-relaxed text-accent-fg'
                              : 'max-w-[80%] rounded-2xl rounded-bl-sm border border-border bg-bg px-3.5 py-2 text-[13px] leading-relaxed'
                          }
                        >
                          <p className="whitespace-pre-wrap break-words">{m.content}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
