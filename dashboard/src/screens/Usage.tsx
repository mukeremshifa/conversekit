// ----------------------------------------------------------------
// Usage — what this bot spends, and how much of that is a guess.
//
// Its own screen rather than a tile on Overview, because the
// interesting cut is by vendor and model and no existing screen has a
// shape for that. Overview answers "is it working"; this answers "what
// is it costing", and the two questions have different denominators —
// Overview counts conversations, this counts provider CALLS, and one
// visitor question can produce two of them when the widget falls back
// from streaming to the buffered endpoint.
//
// THE HONESTY SENTENCE IS THE FEATURE, not decoration on it. On the
// platform default — Gemini chat plus Workers AI embeddings — the
// embedding vendor reports no token counts at all, so every ingest row
// is a character estimate, and on a bot with a real corpus that is most
// of the tokens on this page. A screen that showed one blended total
// would be presenting a guess as a measurement. So: a '≈' on every
// money figure, the reported/estimated split beside the total, and a
// plain sentence naming the reason whenever any of it is estimated.
//
// Cost is INDICATIVE and says so. It is recomputed at read time from a
// rate table rather than stored, so a price correction applies to the
// whole history — but BYOK tenants, negotiated rates and free tiers all
// make it approximate regardless, and an estimated token count
// multiplied by a rate looks exactly like a bill if you let it.
// ----------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Coins, Cpu, Info, RefreshCw, Sigma } from 'lucide-react';
import { ApiError, endpoints, type Bot, type UsageGroup, type UsageReport } from '@/lib/api';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  EmptyState, Muted, Skeleton, Table, Td, Th,
} from '@/components/ui';
import { Header } from '@/screens/Providers';
import { TokensChart, compactNumber } from '@/components/charts';
import { cn } from '@/lib/utils';

/** 365 is offered here and nowhere else: usage_log is kept for 400 days
 *  precisely so a tenant can compare this month against the same month
 *  last year. */
const RANGES = [7, 30, 90, 365] as const;

/** What each `kind` means to someone who did not write the schema. */
const KIND_LABEL: Record<string, string> = {
  chat: 'Visitor conversations',
  embed: 'Indexing your knowledge base',
  preview: 'Testing in the dashboard',
};

/**
 * Money, rounded HARD and never to the cent while anything on the page
 * is estimated.
 *
 * An estimate multiplied by a rate looks exactly like a bill, and
 * "$4.07" is a claim this data cannot support. Two significant-ish
 * figures is the most it can honestly carry, and very small amounts
 * collapse to "under $0.01" rather than pretending at four decimals.
 */
function money(amount: number): string {
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return 'under $0.01';
  if (amount < 10) return `$${amount.toFixed(2)}`;
  return `$${Math.round(amount).toLocaleString()}`;
}

export function Usage({ bot, onNavigate }: { bot: Bot; onNavigate: (route: string) => void }) {
  const [days, setDays] = useState<number>(30);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(true);
  /** Set when the endpoint is unavailable rather than empty. The two
   *  look identical in a bare screen and mean opposite things. */
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setUnavailable(null);
    try {
      setReport(await endpoints.usage(bot.id, days));
    } catch (err) {
      // Two deployment states rather than errors, both worth saying
      // plainly instead of shouting at a tenant about:
      //   501 — the Worker has the route, the database lacks 017.
      //   404 — the Worker predates the route entirely.
      // A missing *bot* cannot be confused with the second: this route
      // never 404s for one, it returns an empty report, because RLS
      // simply yields no rows for a bot the caller cannot see.
      if (err instanceof ApiError && (err.status === 501 || err.status === 404)) {
        setReport(null);
        setUnavailable(err.message);
        return;
      }
      toast.error(err instanceof Error ? err.message : 'Could not load usage');
    } finally {
      setLoading(false);
    }
  }, [bot.id, days]);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <Header
        title="Usage"
        subtitle="Tokens this bot has spent — on visitor conversations, on indexing your knowledge base, and on your own testing."
        action={
          <div className="flex items-center gap-2">
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
                  {r === 365 ? '1y' : `${r}d`}
                </button>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={load}>
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </Button>
          </div>
        }
      />

      {unavailable ? (
        <Card><CardContent className="py-10 text-center"><Muted>{unavailable}</Muted></CardContent></Card>
      ) : loading && !report ? (
        <SkeletonUsage />
      ) : !report ? (
        <Card><CardContent className="py-10 text-center"><Muted>No usage data available.</Muted></CardContent></Card>
      ) : report.totals.calls === 0 ? (
        <Card>
          <CardContent className="py-4">
            <EmptyState
              icon={Sigma}
              title="Nothing spent in this window"
              description="Every reply and every re-index costs tokens. Once this bot answers a visitor or indexes a source, what it spent shows up here — broken down by vendor and model."
            />
          </CardContent>
        </Card>
      ) : (
        <Loaded report={report} loading={loading} onNavigate={onNavigate} />
      )}
    </>
  );
}

function Loaded({ report, loading, onNavigate }: {
  report: UsageReport;
  loading: boolean;
  onNavigate: (route: string) => void;
}) {
  const t = report.totals;
  const estimatedPct = report.estimatedShare === null ? 0 : Math.round(report.estimatedShare * 100);

  return (
    <div className={cn('space-y-6 transition-opacity', loading && 'opacity-60')}>
      <div className="ck-stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          icon={Coins}
          label="Estimated spend"
          // The '≈' is not a flourish. It is on every rendering of this
          // number on this screen, and it is there whether or not the
          // token counts were estimated, because the RATES are
          // indicative too.
          value={report.cost ? `≈ ${money(report.cost.amount)}` : '—'}
          hint={
            report.cost
              ? report.cost.unpricedCalls > 0
                ? `${report.cost.pricedCalls.toLocaleString()} of ${t.calls.toLocaleString()} calls have a known rate`
                : `across ${report.cost.pricedCalls.toLocaleString()} calls`
              : 'No published rate for this vendor'
          }
        />
        <Stat icon={Sigma} label="Tokens" value={compactNumber(t.totalTokens)}
              hint={`${compactNumber(t.inputTokens)} in · ${compactNumber(t.outputTokens)} out`} />
        <Stat icon={Cpu} label="Provider calls" value={t.calls.toLocaleString()}
              hint={t.errorCalls > 0
                ? `${t.errorCalls.toLocaleString()} failed and were charged anyway`
                : 'not the same as conversations'} />
        <Stat
          icon={Info}
          label="Measured"
          value={report.estimatedShare === null ? '—' : `${100 - estimatedPct}%`}
          hint={report.estimatedShare === null
            ? 'Nothing recorded yet'
            : `${compactNumber(t.reportedTokens)} tokens confirmed by the vendor`}
        />
      </div>

      {/* D2, and the reason this screen exists in the shape it does.
          The sentence ships WITH the number, never after it. */}
      {estimatedPct > 0 && (
        <Card>
          <CardContent className="flex items-start gap-3 py-4">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
            <div className="space-y-1 text-sm">
              <p>
                <strong>{estimatedPct}% of these tokens are estimated.</strong>{' '}
                Some of your providers do not report token counts — Cloudflare Workers AI
                and Gemini both stay silent on embeddings, and local servers stay silent
                on streamed replies — so for those calls the figure above is worked out
                from the length of the text instead.
              </p>
              <Muted className="text-xs">
                The estimate is roughly four characters per token, which is calibrated for
                English and over-counts for Amharic, Chinese, Japanese and Korean. Treat
                every figure on this page as indicative, never as an invoice.{' '}
                <button
                  type="button"
                  onClick={() => onNavigate('providers')}
                  className="cursor-pointer font-semibold text-accent-ink hover:underline"
                >
                  Test your provider
                </button>{' '}
                to see whether it reports counts at all.
              </Muted>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Tokens per day</CardTitle>
            <CardDescription>
              What the bot read and what it wrote, over the last {report.range.days} days.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <TokensChart data={report.series} />
          {report.truncated && (
            <Muted className="mt-3 text-xs">
              This bot made more provider calls than one report can read, so these totals
              under-report. Narrow the range for exact numbers.
            </Muted>
          )}
        </CardContent>
      </Card>

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>By model</CardTitle>
              <CardDescription>Where the tokens actually went.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <GroupTable groups={report.byModel} showVendor />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>By activity</CardTitle>
              <CardDescription>
                Indexing is usually the larger number — one document is thousands of tokens,
                one reply is hundreds.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <GroupTable groups={report.byKind} labels={KIND_LABEL} />
          </CardContent>
        </Card>
      </div>

      <Muted className="text-xs">
        Days are bucketed in UTC. Rows count provider calls, not conversations — a reply
        that has to retry files two.
        {report.cost?.pricedAt && <> Rates last checked {report.cost.pricedAt}.</>}
        {report.cost && report.cost.unpricedCalls > 0 && (
          <> {report.cost.unpricedCalls.toLocaleString()} call
            {report.cost.unpricedCalls === 1 ? '' : 's'} came from a vendor with no published
            rate; their tokens are counted above and their cost is not.</>
        )}
      </Muted>
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────

function GroupTable({ groups, showVendor, labels }: {
  groups: UsageGroup[];
  showVendor?: boolean;
  /** Friendly names for opaque keys — `kind` is a schema word. */
  labels?: Record<string, string>;
}) {
  if (groups.length === 0) return <Muted className="text-sm">Nothing recorded in this window.</Muted>;

  return (
    <div className="overflow-x-auto">
      <Table>
        <thead>
          <tr>
            <Th>{showVendor ? 'Model' : 'Activity'}</Th>
            <Th className="text-right">Calls</Th>
            <Th className="text-right">Tokens</Th>
            <Th className="text-right">Cost</Th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => (
            <tr key={g.key}>
              <Td>
                <span className="break-all text-[13px] font-medium">{labels?.[g.key] ?? g.key}</span>
                {showVendor && g.vendor && (
                  <span className="ml-2 align-middle"><Badge tone="neutral">{g.vendor}</Badge></span>
                )}
              </Td>
              <Td className="text-right tabular-nums">{g.calls.toLocaleString()}</Td>
              <Td className="text-right tabular-nums">{compactNumber(g.totalTokens)}</Td>
              {/* An em dash rather than $0.00 when the rate is unknown:
                  free and unknown are different answers, and only one of
                  them is a measurement. */}
              <Td className="text-right tabular-nums">
                {g.cost === null ? '—' : `≈ ${money(g.cost)}`}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}

function Stat({ label, value, hint, icon: Icon }: {
  label: string;
  value: string;
  hint?: string;
  icon: typeof Coins;
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 text-faint" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</span>
        </div>
        <div className="mt-2 font-display text-[28px] leading-none">{value}</div>
        {hint && <p className="mt-1.5 text-xs text-muted">{hint}</p>}
      </CardContent>
    </Card>
  );
}

/** Matches the loaded layout so the page does not jump when data lands. */
function SkeletonUsage() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading usage">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <CardContent className="space-y-3 pt-5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-7 w-20" />
              <Skeleton className="h-3 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="space-y-3 py-6">
          <Skeleton className="h-3 w-32" />
          <Skeleton className="h-[200px] w-full" />
        </CardContent>
      </Card>
    </div>
  );
}
