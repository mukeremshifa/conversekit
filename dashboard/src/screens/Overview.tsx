// ----------------------------------------------------------------
// Overview
//
// The dashboard used to open straight into the Playground, so every
// number the platform records — conversations, leads, retrieval corpus
// — was captured and never shown. This is the screen that answers
// "is it working?" before you go looking for a specific transcript.
//
// Token spend is deliberately absent: usage comes back from the
// provider on every turn but is not persisted anywhere, so charting it
// would mean a schema change and a write-path change. Noted rather than
// faked.
// ----------------------------------------------------------------
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDownRight, ArrowUpRight, MessagesSquare, Target, Search } from 'lucide-react';
import { endpoints, type Bot, type Stats } from '@/lib/api';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Muted, Spinner } from '@/components/ui';
import { Header } from '@/screens/Providers';
import { LeadsChart, MessagesChart, Sparkline, TopQuestions } from '@/components/charts';
import { cn } from '@/lib/utils';

const RANGES = [7, 30, 90] as const;

export function Overview({ bot, onNavigate }: { bot: Bot; onNavigate: (route: string) => void }) {
  const [days, setDays] = useState<number>(30);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    endpoints.stats(bot.id, days)
      .then((s) => { if (!cancelled) setStats(s); })
      .catch((err) => {
        if (cancelled) return;
        toast.error(err instanceof Error ? err.message : 'Could not load statistics');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [bot.id, days]);

  return (
    <>
      <Header
        title="Overview"
        subtitle={`How ${bot.name} has been doing.`}
        action={
          <div className="flex rounded-lg border border-border p-0.5" role="group" aria-label="Time range">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setDays(r)}
                aria-pressed={days === r}
                className={cn(
                  'cursor-pointer rounded-[6px] px-3 py-1 text-xs font-semibold transition-colors',
                  days === r ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg',
                )}
              >
                {r}d
              </button>
            ))}
          </div>
        }
      />

      {loading && !stats ? (
        <SkeletonOverview />
      ) : !stats ? (
        <Card><CardContent className="py-12 text-center"><Muted>No statistics available.</Muted></CardContent></Card>
      ) : (
        <Loaded stats={stats} loading={loading} onNavigate={onNavigate} />
      )}
    </>
  );
}

function Loaded({ stats, loading, onNavigate }:
  { stats: Stats; loading: boolean; onNavigate: (route: string) => void }) {
  const t = stats.totals;
  const quiet = t.messages === 0 && t.leads === 0;

  return (
    <div className={cn('space-y-6 transition-opacity', loading && 'opacity-60')}>
      <div className="ck-stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Conversations" value={t.sessions} previous={stats.previous.sessions}
          spark={stats.series.map((d) => d.sessions)} icon={MessagesSquare}
        />
        <Stat
          label="Messages" value={t.messages} previous={stats.previous.messages}
          spark={stats.series.map((d) => d.visitor + d.assistant)} icon={MessagesSquare}
        />
        <Stat
          label="Leads" value={t.leads} previous={stats.previous.leads}
          spark={stats.series.map((d) => d.leads)} icon={Target}
        />
        <Stat
          label="Lead conversion"
          value={t.conversionRate === null ? '—' : `${Math.round(t.conversionRate * 100)}%`}
          hint={t.conversionRate === null ? 'No conversations yet' : `${t.leads} of ${t.sessions} conversations`}
          icon={Target}
        />
      </div>

      {quiet && (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center">
            <MessagesSquare className="h-7 w-7 text-faint" />
            <p className="font-semibold">Nothing in this window yet</p>
            <p className="max-w-sm text-sm text-muted">
              Once visitors start talking to this bot, their conversations and any leads
              it captures will appear here.
            </p>
            <button
              type="button"
              onClick={() => onNavigate('install')}
              className="mt-1 cursor-pointer text-sm font-semibold text-accent-ink hover:underline"
            >
              Get the install snippet
            </button>
          </CardContent>
        </Card>
      )}

      {!quiet && (
        <>
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Messages per day</CardTitle>
                <CardDescription>
                  Visitor turns and the replies to them, over the last {stats.range.days} days.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <MessagesChart data={stats.series} />
              {stats.truncated.messages && (
                <Muted className="mt-3 text-xs">
                  Showing the most recent messages only — this window exceeded the row limit,
                  so totals may under-report.
                </Muted>
              )}
            </CardContent>
          </Card>

          <div className="grid items-start gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Leads per day</CardTitle>
                  <CardDescription>Captured mid-conversation.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                {t.leads === 0
                  ? <EmptyPanel icon={Target} text="No leads captured in this window." />
                  : <LeadsChart data={stats.series} />}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Top questions</CardTitle>
                  <CardDescription>What visitors actually asked.</CardDescription>
                </div>
              </CardHeader>
              <CardContent>
                {stats.topQuestions.length === 0
                  ? <EmptyPanel icon={Search} text="No visitor questions yet." />
                  : <TopQuestions items={stats.topQuestions} />}
              </CardContent>
            </Card>
          </div>
        </>
      )}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Knowledge base</CardTitle>
            <CardDescription>What this bot can answer from.</CardDescription>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('sources')}
            className="cursor-pointer text-xs font-semibold text-accent-ink hover:underline"
          >
            Manage sources
          </button>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Mini label="Documents" value={t.documents} />
            <Mini label="Chunks indexed" value={t.chunks} />
            <Mini label="Ready" value={t.documentsReady} tone={t.documentsReady ? 'ok' : undefined} />
            <Mini
              label={t.documentsFailed ? 'Failed' : 'Pending'}
              value={t.documentsFailed || t.documentsPending}
              tone={t.documentsFailed ? 'bad' : undefined}
            />
          </div>
          {t.documents === 0 && (
            <Muted className="mt-4 text-xs">
              With no sources, answers come from the knowledge-base fields alone.
            </Muted>
          )}
        </CardContent>
      </Card>

      <Muted className="text-xs">
        Days are bucketed in UTC. Token usage is not shown because it is not stored —
        providers return it per turn, but nothing persists it yet.
      </Muted>
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────

function Stat({ label, value, previous, spark, hint, icon: Icon }: {
  label: string;
  value: number | string;
  previous?: number;
  spark?: number[];
  hint?: string;
  icon: typeof MessagesSquare;
}) {
  const numeric = typeof value === 'number' ? value : null;
  // A delta against a zero baseline is not a percentage anyone can use.
  const delta = numeric !== null && previous !== undefined && previous > 0
    ? Math.round(((numeric - previous) / previous) * 100)
    : null;

  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 text-faint" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</span>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="font-display text-[28px] leading-none">
            {typeof value === 'number' ? value.toLocaleString() : value}
          </span>
          {delta !== null && delta !== 0 && (
            <span className={cn('inline-flex items-center gap-0.5 text-xs font-semibold',
              delta > 0 ? 'text-success' : 'text-danger')}>
              {delta > 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
              {Math.abs(delta)}%
            </span>
          )}
        </div>
        {hint
          ? <p className="mt-1.5 text-xs text-muted">{hint}</p>
          : spark
            ? <div className="mt-2"><Sparkline values={spark} /></div>
            : null}
        {delta !== null && !hint && (
          <p className="mt-1 text-[11px] text-faint">vs previous period</p>
        )}
      </CardContent>
    </Card>
  );
}

function Mini({ label, value, tone }: { label: string; value: number; tone?: 'ok' | 'bad' }) {
  return (
    <div>
      <div className={cn('font-display text-xl leading-none',
        tone === 'ok' && 'text-success', tone === 'bad' && 'text-danger')}>
        {value.toLocaleString()}
      </div>
      <div className="mt-1 text-xs text-muted">{label}</div>
    </div>
  );
}

function EmptyPanel({ icon: Icon, text }: { icon: typeof Target; text: string }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center">
      <Icon className="h-6 w-6 text-faint" />
      <p className="text-sm text-muted">{text}</p>
    </div>
  );
}

/** Matches the loaded layout so the page does not jump when data lands. */
function SkeletonOverview() {
  const bar = 'animate-pulse rounded bg-sunk';
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading statistics">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <CardContent className="space-y-3 pt-5">
              <div className={cn(bar, 'h-3 w-24')} />
              <div className={cn(bar, 'h-7 w-16')} />
              <div className={cn(bar, 'h-7 w-full')} />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="space-y-3 py-6">
          <div className={cn(bar, 'h-3 w-32')} />
          <div className={cn(bar, 'h-[200px] w-full')} />
        </CardContent>
      </Card>
      <div className="grid gap-6 lg:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i}>
            <CardContent className="space-y-3 py-6">
              <div className={cn(bar, 'h-3 w-28')} />
              <div className={cn(bar, 'h-[150px] w-full')} />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="flex items-center gap-2 text-muted">
        <Spinner /> <span className="text-sm">Loading statistics…</span>
      </div>
    </div>
  );
}
