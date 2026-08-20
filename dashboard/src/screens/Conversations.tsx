import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { MessageSquareText, RefreshCw } from 'lucide-react';
import { endpoints, type Bot, type Message } from '@/lib/api';
import { Transcript, groupBySession } from '@/components/Transcript';
import { formatDate } from '@/lib/utils';
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  EmptyState, Skeleton, TranscriptSkeleton,
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
            <CardTitle>
              {/* A confident "0 sessions" that turns into twelve reads
                  as a wrong answer rather than a pending one. */}
              {messages === null
                ? <Skeleton inline className="h-4 w-24" />
                : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
            </CardTitle>
            <CardDescription>Most recent first, up to the last 100 messages.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-3.5 w-3.5" /> Refresh</Button>
        </CardHeader>
        <CardContent>
          {messages === null ? (
            <SessionsSkeleton />
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

/**
 * What this screen actually renders while it waits: sessions, each one
 * a header rule over a run of chat bubbles. It previewed a table before,
 * which is not a shape this screen has anywhere on it.
 */
function SessionsSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      {[4, 2].map((bubbles, i) => (
        <div key={i} style={{ opacity: 1 - i * 0.25 }}>
          <div className="mb-2 flex items-center gap-2">
            <Skeleton className="h-3 w-40" />
            <span className="h-px flex-1 bg-border" />
            <Skeleton className="h-3 w-28" />
          </div>
          <TranscriptSkeleton bubbles={bubbles} />
        </div>
      ))}
    </div>
  );
}
