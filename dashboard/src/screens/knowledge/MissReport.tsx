// ----------------------------------------------------------------
// "Questions your bot could not answer"
//
// The half of retrieval logging a tenant actually wants. Everything
// else on this screen answers "what does my bot know"; this answers
// "what does it not", from real visitors rather than from a test query
// someone thought to type.
//
// It is also the loop that closes. A question here is one an FAQ entry
// would have answered, so the row's action is Add as FAQ — which drops
// straight into the editor on the FAQ tab with the question already
// filled in, because the gap between "I can see the problem" and "I
// have fixed it" is where a report like this normally dies.
//
// Reads misses only. The denominator behind the rate comes from rows
// that DID match, which are logged too and never shown here — see
// buildMissReport in src/stats.ts for why counting only failures makes
// a report that cannot be tuned against.
// ----------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { MessageCircleQuestion, Plus, RefreshCw } from 'lucide-react';
import { ApiError, endpoints, type Bot, type MissReport as Report } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  EmptyState, ListSkeleton, Muted, Select, SelectContent, SelectItem,
  SelectTrigger, SelectValue,
} from '@/components/ui';

const RANGES = [7, 30, 90];

export function MissReport({
  bot, onAddFaq,
}: {
  bot: Bot;
  /** Hand a question to the FAQ editor, prefilled. */
  onAddFaq: (question: string) => void;
}) {
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
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Questions your bot could not answer</CardTitle>
          <CardDescription>
            Real questions from real visitors where nothing in your knowledge base was close enough
            to use. This is the list to write answers for.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
            <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {RANGES.map((d) => <SelectItem key={d} value={String(d)}>Last {d} days</SelectItem>)}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {unavailable ? (
          <Muted className="text-sm">{unavailable}</Muted>
        ) : report === null ? (
          <ListSkeleton rows={3} />
        ) : report.totals.queries === 0 ? (
          <EmptyState
            icon={MessageCircleQuestion}
            title="No searches yet"
            description="Once visitors start asking this bot questions, the ones it could not answer show up here — with how often each was asked, and a one-click way to turn it into an FAQ entry."
          />
        ) : (
          <>
            <Summary report={report} />
            {report.questions.length === 0 ? (
              <Muted className="mt-4 text-sm">
                Every search in this window found something. Nothing to write.
              </Muted>
            ) : (
              <div className="mt-4 divide-y divide-border">
                {report.questions.map((q) => (
                  <div key={q.text} className="flex items-start gap-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-[13px] font-medium leading-relaxed">{q.text}</p>
                      <p className="mt-0.5 text-xs text-muted">
                        asked {q.count} time{q.count === 1 ? '' : 's'} · last {formatDate(q.lastAsked)}
                      </p>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => onAddFaq(q.text)}>
                      <Plus className="h-3.5 w-3.5" /> Add as FAQ
                    </Button>
                  </div>
                ))}
              </div>
            )}
            {report.truncated && (
              <Muted className="mt-3 text-xs">
                This bot logged more searches than one report can read, so the counts below the top
                few are partial. Narrow the range for exact numbers.
              </Muted>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The numbers under the headline, and the reason this report is more
 * than a UI feature.
 *
 * The miss rate on its own is not actionable — some misses are visitors
 * asking about the weather. What makes it readable is the pair beside
 * it: how confidently the searches that DID land scored, against the
 * floor they were tested with. A median sitting just above the floor
 * means the threshold is doing the rejecting; a wide gap means the
 * misses are genuinely off-topic and no amount of tuning will help.
 */
function Summary({ report }: { report: Report }) {
  const { totals, channels, scores } = report;
  const rate = totals.missRate === null ? null : Math.round(totals.missRate * 100);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
      <span>
        <strong className="text-ink tabular-nums">{totals.misses}</strong> of{' '}
        <strong className="text-ink tabular-nums">{totals.queries}</strong> searches found nothing
        {rate !== null && <> · <Badge tone={rate > 40 ? 'bad' : rate > 15 ? 'wait' : 'ok'}>{rate}%</Badge></>}
      </span>
      {channels.lexical > 0 && (
        <span>
          <strong className="text-ink tabular-nums">{channels.lexical}</strong> rescued by the
          keyword fallback
        </span>
      )}
      {/* Its own count, not folded into either channel: a merged search
          was answered by both at once, and the typical-match figure
          below deliberately excludes these — a keyword rank averaged
          into a similarity median is not a measurement. */}
      {channels.hybrid > 0 && (
        <span>
          <strong className="text-ink tabular-nums">{channels.hybrid}</strong> answered by the
          merged search
        </span>
      )}
      {scores.hitMedian !== null && (
        <span className="tabular-nums">
          typical match {scores.hitMedian.toFixed(2)}
          {scores.floor !== null && <> against a floor of {scores.floor}</>}
        </span>
      )}
    </div>
  );
}
