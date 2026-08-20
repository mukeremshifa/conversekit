// ----------------------------------------------------------------
// Chart primitives.
//
// Hand-rolled SVG rather than a charting library. These four forms are
// simple enough that a dependency would cost ~100KB and then have to be
// fought over the details that actually matter here: 2px strokes, 4px
// rounded data-ends anchored to the baseline, a 2px surface gap between
// stacked fills, and a crosshair that snaps to the nearest day.
//
// Colour comes from --color-chart-* so both themes are handled by the
// token layer. Those values are validated, not chosen by eye — see the
// note in index.css. Text never wears a series colour; a swatch beside
// it carries identity instead.
// ----------------------------------------------------------------
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

const S1 = 'var(--color-chart-1)';
const S2 = 'var(--color-chart-2)';

export const SERIES = { visitor: S1, assistant: S2 } as const;

/** Nice-ish upper bound so the axis lands on a round number. */
function niceMax(value: number): number {
  if (value <= 0) return 4;
  const mag = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((s) => value <= s * mag * 1.0001) ?? 10;
  return step * mag;
}

/**
 * 1240000 → "1.2M". Exported because the Usage screen needs the same
 * abbreviation in its tables and stat tiles as on its axis, and two
 * roundings of the same number on one screen read as a bug.
 *
 * Deliberately lossy. Token counts are large and, on any deployment
 * with an estimated share, approximate anyway — rendering them to the
 * unit would claim a precision the number does not have.
 */
export function compactNumber(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(n));
}

const fmtDay = (iso: string) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });

// ── Sparkline ─────────────────────────────────────────────────────
// Deliberately axis-free and hover-free: it lives inside a stat tile
// where the number is the message and this is only its shape.
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const id = useId();
  const w = 100, h = 28;
  if (values.length < 2) return <div className={cn('h-7', className)} />;

  const max = Math.max(...values, 1);
  const step = w / (values.length - 1);
  const pts = values.map((v, i) => [i * step, h - (v / max) * (h - 3) - 1.5] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const area = `${line} L${w} ${h} L0 ${h} Z`;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={cn('h-7 w-full', className)} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={S1} stopOpacity="0.22" />
          <stop offset="100%" stopColor={S1} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={S1} strokeWidth="2" vectorEffect="non-scaling-stroke"
            strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}


/** Measures the container so the viewBox can match the rendered width 1:1.
 *  Without this an SVG scales its text with the viewBox, so the same chart
 *  rendered 720 units wide has ~5px axis labels in a 330px column and gets
 *  letterboxed against a fixed pixel height. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(640);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      setW(Math.max(240, Math.round(entry.contentRect.width)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

// ── Shared hover plumbing ─────────────────────────────────────────
interface HoverState { i: number; x: number }

function useNearest(count: number, plotLeft: number, plotWidth: number) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  function onMove(e: React.MouseEvent<SVGSVGElement> | React.PointerEvent<SVGSVGElement>) {
    const svg = ref.current;
    if (!svg || count === 0) return;
    const box = svg.getBoundingClientRect();
    // Client px → viewBox units, so the maths holds at any rendered size.
    const vb = svg.viewBox.baseVal.width || box.width;
    const x = ((e.clientX - box.left) / box.width) * vb;
    const t = (x - plotLeft) / plotWidth;
    const i = Math.max(0, Math.min(count - 1, Math.round(t * (count - 1))));
    setHover({ i, x });
  }
  return { ref, hover, onMove, clear: () => setHover(null) };
}

/** Tooltip rendered in HTML, positioned over the SVG — text stays
 *  selectable and inherits the app's type rather than SVG defaults. */
function Tooltip({ left, children }: { left: string; children: React.ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 rounded-lg border border-border
                 bg-surface px-2.5 py-1.5 text-xs shadow-lg"
      style={{ left }}
      role="status"
    >
      {children}
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
      <span className="h-2 w-2 rounded-[2px]" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

// ── Stacked area ──────────────────────────────────────────────────
//
// Two series, upper stacked on lower, one point per day. Generalised
// out of MessagesChart when the Usage screen needed the same form for
// input and output tokens — same 2px surface-coloured gap between the
// bands, same crosshair, same axis. Both callers below are thin: they
// name their series and map their rows onto `lower`/`upper`.
//
// `format` exists because the two callers count different things.
// Messages are small integers and read fine raw; tokens run to the
// millions and an axis label of 1240000 is unreadable at 10px.
interface StackPoint { date: string; lower: number; upper: number }

function StackedArea({
  data, labels, format = (n: number) => String(n), label,
}: {
  data: StackPoint[];
  /** [lower, upper] — legend and tooltip both read these. */
  labels: [string, string];
  format?: (n: number) => string;
  /** The accessible description of the whole chart. */
  label: string;
}) {
  const gid = useId();
  const [box, W] = useWidth();
  const H = 200, PAD_L = 44, PAD_R = 8, PAD_T = 10, PAD_B = 22;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;

  const max = useMemo(() => niceMax(Math.max(...data.map((d) => d.lower + d.upper), 0)), [data]);
  const { ref, hover, onMove, clear } = useNearest(data.length, PAD_L, plotW);

  if (!data.length) return null;
  const x = (i: number) => PAD_L + (i / Math.max(1, data.length - 1)) * plotW;
  const y = (v: number) => PAD_T + plotH - (v / max) * plotH;

  const path = (pick: (d: StackPoint) => number, base: (d: StackPoint) => number) => {
    const top = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(pick(d)).toFixed(1)}`).join(' ');
    const bottom = [...data].reverse()
      .map((d, i) => `L${x(data.length - 1 - i).toFixed(1)} ${y(base(d)).toFixed(1)}`).join(' ');
    return `${top} ${bottom} Z`;
  };

  const ticks = [0, max / 2, max];
  const active = hover ? data[hover.i] : null;

  return (
    <div className="relative" ref={box}>
      <div className="mb-3 flex items-center gap-4">
        <LegendSwatch color={S1} label={labels[1]} />
        <LegendSwatch color={S2} label={labels[0]} />
      </div>

      <svg
        ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" height={H}
        onPointerMove={onMove} onPointerLeave={clear}
        role="img"
        aria-label={label}
      >
        <defs>
          <linearGradient id={`${gid}-a`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={S1} stopOpacity="0.85" />
            <stop offset="100%" stopColor={S1} stopOpacity="0.55" />
          </linearGradient>
        </defs>

        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)}
                  stroke="var(--color-chart-grid)" strokeWidth="1" />
            <text x={PAD_L - 7} y={y(t) + 3.5} textAnchor="end"
                  className="fill-faint" style={{ fontSize: 10 }}>
              {format(t)}
            </text>
          </g>
        ))}

        {/* The lower band sits under the upper one; the 2px
            surface-coloured stroke on the upper band is the gap that
            keeps the two fills from bleeding. */}
        <path d={path((d) => d.lower, () => 0)} fill={S2} fillOpacity="0.75" />
        <path d={path((d) => d.lower + d.upper, (d) => d.lower)}
              fill={`url(#${gid}-a)`} stroke="var(--color-surface)" strokeWidth="2" />

        {data.map((d, i) => (
          <text key={d.date} x={x(i)} y={H - 6} textAnchor="middle"
                className="fill-faint" style={{ fontSize: 9.5 }}>
            {/* Only ever ~6 labels, so they cannot collide. */}
            {i % Math.ceil(data.length / Math.max(2, Math.floor(W / 110))) === 0 ? fmtDay(d.date) : ''}
          </text>
        ))}

        {active && (
          <g pointerEvents="none">
            <line x1={x(hover!.i)} x2={x(hover!.i)} y1={PAD_T} y2={PAD_T + plotH}
                  stroke="var(--color-border-strong)" strokeWidth="1" />
            <circle cx={x(hover!.i)} cy={y(active.lower + active.upper)} r="4.5"
                    fill={S1} stroke="var(--color-surface)" strokeWidth="2" />
          </g>
        )}
      </svg>

      {active && (
        <Tooltip left={`${((x(hover!.i) / W) * 100).toFixed(2)}%`}>
          <div className="font-semibold">{fmtDay(active.date)}</div>
          <div className="mt-1 space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: S1 }} />
              <span className="text-muted">{labels[1]}</span>
              <span className="ml-auto font-semibold">{format(active.upper)}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-[2px]" style={{ background: S2 }} />
              <span className="text-muted">{labels[0]}</span>
              <span className="ml-auto font-semibold">{format(active.lower)}</span>
            </div>
          </div>
        </Tooltip>
      )}
    </div>
  );
}

/** Messages per day — visitor turns stacked over the replies to them. */
export function MessagesChart({ data }: { data: { date: string; visitor: number; assistant: number }[] }) {
  const max = Math.max(...data.map((d) => d.visitor + d.assistant), 0);
  return (
    <StackedArea
      data={data.map((d) => ({ date: d.date, lower: d.assistant, upper: d.visitor }))}
      labels={['Assistant', 'Visitor']}
      label={`Messages per day. ${data.length} days, peak ${max} messages.`}
    />
  );
}

/** Tokens per day — output stacked over input.
 *
 *  Input is the LOWER band on purpose: it is the larger number on
 *  almost every deployment (a retrieval prompt carries thousands of
 *  characters of context, a reply carries hundreds), so putting it
 *  underneath keeps the chart from looking like a thin line with a
 *  cliff on top. */
export function TokensChart({ data }: { data: { date: string; inputTokens: number; outputTokens: number }[] }) {
  const max = Math.max(...data.map((d) => d.inputTokens + d.outputTokens), 0);
  return (
    <StackedArea
      data={data.map((d) => ({ date: d.date, lower: d.inputTokens, upper: d.outputTokens }))}
      labels={['Input', 'Output']}
      format={compactNumber}
      label={`Tokens per day. ${data.length} days, peak ${max} tokens.`}
    />
  );
}

// ── Column chart: leads per day ───────────────────────────────────
export function LeadsChart({ data }: { data: { date: string; leads: number }[] }) {
  const [box, W] = useWidth();
  const H = 150, PAD_L = 26, PAD_R = 6, PAD_T = 10, PAD_B = 20;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const max = useMemo(() => niceMax(Math.max(...data.map((d) => d.leads), 0)), [data]);
  const { ref, hover, onMove, clear } = useNearest(data.length, PAD_L, plotW);

  if (!data.length) return null;
  const slot = plotW / data.length;
  const barW = Math.max(3, Math.min(18, slot - 3));   // the -3 is the inter-bar gap
  const x = (i: number) => PAD_L + slot * i + (slot - barW) / 2;
  const y = (v: number) => PAD_T + plotH - (v / max) * plotH;
  const active = hover ? data[hover.i] : null;

  return (
    <div className="relative" ref={box}>
      <svg
        ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" height={H}
        onPointerMove={onMove} onPointerLeave={clear}
        role="img" aria-label={`Leads per day. ${data.length} days, peak ${max}.`}
      >
        {[0, max].map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)}
                  stroke="var(--color-chart-grid)" strokeWidth="1" />
            <text x={PAD_L - 7} y={y(t) + 3.5} textAnchor="end"
                  className="fill-faint" style={{ fontSize: 10 }}>{t}</text>
          </g>
        ))}

        {data.map((d, i) => {
          const h = d.leads ? Math.max(3, PAD_T + plotH - y(d.leads)) : 0;
          return (
            <rect key={d.date} x={x(i)} y={PAD_T + plotH - h} width={barW} height={h}
                  rx="3" fill={S1}
                  opacity={hover && hover.i !== i ? 0.45 : 1} />
          );
        })}

        {data.map((d, i) => (
          <text key={d.date} x={x(i) + barW / 2} y={H - 6} textAnchor="middle"
                className="fill-faint" style={{ fontSize: 9.5 }}>
            {i % Math.ceil(data.length / Math.max(2, Math.floor(W / 95))) === 0 ? fmtDay(d.date) : ''}
          </text>
        ))}
      </svg>

      {active && (
        <Tooltip left={`${(((x(hover!.i) + barW / 2) / W) * 100).toFixed(2)}%`}>
          <div className="font-semibold">{fmtDay(active.date)}</div>
          <div className="text-muted">{active.leads} {active.leads === 1 ? 'lead' : 'leads'}</div>
        </Tooltip>
      )}
    </div>
  );
}

// ── Horizontal bars: top questions ────────────────────────────────
// Horizontal because the labels are sentences; a column chart would
// either truncate them or rotate them.
export function TopQuestions({ items }: { items: { text: string; count: number }[] }) {
  const max = Math.max(...items.map((i) => i.count), 1);
  return (
    <ul className="space-y-2.5">
      {items.map((q) => (
        <li key={q.text} className="space-y-1">
          <div className="flex items-baseline gap-3">
            <span className="min-w-0 flex-1 truncate text-[13px]" title={q.text}>{q.text}</span>
            <span className="shrink-0 text-xs font-semibold text-muted">{q.count}</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-sunk">
            <div className="h-full rounded-full" style={{ width: `${(q.count / max) * 100}%`, background: S1 }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
