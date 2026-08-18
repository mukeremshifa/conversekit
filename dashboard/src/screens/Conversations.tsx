import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { MessageSquareText, RefreshCw } from 'lucide-react';
import { endpoints, type Bot, type Message } from '@/lib/api';
import { Transcript, groupBySession } from '@/components/Transcript';
import { formatDate } from '@/lib/utils';
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  EmptyState, TableSkeleton,
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

  const sessions = useMemo(() => groupBySession(messages ?? []), [messages]);

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
            <TableSkeleton rows={4} cols={3} />
          ) : sessions.length === 0 ? (
            <EmptyState
              icon={MessageSquareText}
              title="No conversations yet"
              description="Transcripts land here once visitors start talking to this bot."
              action={{ label: 'Try it in the Playground', onClick: () => { window.location.hash = 'playground'; } }}
            />
          ) : (
            <div className="space-y-6">
              {sessions.map(([sid, msgs]) => (
                <div key={sid}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="font-mono text-xs text-muted">{sid.slice(0, 20)}…</span>
                    <span className="h-px flex-1 bg-border" />
                    <span className="text-xs text-muted">{formatDate(msgs[0]?.created_at)}</span>
                  </div>
                  <Transcript messages={msgs} />
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
