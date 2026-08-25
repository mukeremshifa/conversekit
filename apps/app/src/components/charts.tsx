// ----------------------------------------------------------------
// Chart primitives.
//
// Hand-rolled SVG rather than a charting library. These forms are
// simple enough that a dependency would cost ~100KB and then have to be
// fought over the details that actually matter here: 2px strokes, a 2px
// surface gap between stacked fills, a crosshair that snaps to the
// nearest day, and tooltips in HTML so they inherit the app's type
// rather than SVG defaults. The polish a library is usually bought for
// — monotone curves, a draw-in on mount, restrained fills — is the
// ~60 lines below.
//
// Colour comes from --color-chart-* so both themes are handled by the
// token layer. Those five slots are validated, not chosen by eye — see
// the note in index.css. Text never wears a series colour; a swatch
// beside it carries identity instead.
//
// TWO RULES THAT LOOK LIKE DETAILS AND ARE NOT:
//
//   Never a second y-axis. Two measures of different scale go in two
//   panels side by side (see MiniChart), never overlaid on one plot —
//   the alignment of two scales is arbitrary and invents a correlation
//   that is not in the data.
//
//   Colour follows the entity, never its rank. ShareBar orders its
//   segments largest-first for reading but assigns hues by a stable
//   key, so a vendor overtaking another does not make the two swap
//   colours under a reader who had learned them.
// ----------------------------------------------------------------
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

const S1 = 'var(--color-chart-1)';
const S2 = 'var(--color-chart-2)';
const S3 = 'var(--color-chart-3)';
const S4 = 'var(--color-chart-4)';
const S5 = 'var(--color-chart-5)';

/** Fixed slot order. Assigned in sequence and never cycled: a sixth
 *  category folds into "Other" rather than reusing a hue, because the
 *  order IS the colour-blind-safety mechanism and a generated sixth
 *  colour is not covered by the validation. */
export const SLOTS = [S1, S2, S3, S4, S5] as const;

/** Slot 4, exported for the one screen that needs a series colour by
 *  name: the measured/estimated panel is a single series and has to sit
 *  clear of the two the token chart above it already uses. */
export const SERIES_4 = S4;

/** The neutral "Other" fill. Not a slot — it deliberately reads as
 *  "everything else" rather than as one more identity. */
const OTHER = 'var(--color-border-strong)';

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

/** A 0–1 share as a whole percent. */
export const percent = (n: number): string => `${Math.round(n * 100)}%`;

const fmtDay = (iso: string) =>
  new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });

// ── Weekly rollup ─────────────────────────────────────────────────
//
// A year of daily points is ~365 marks in a 200px-tall plot: every
// mark under a pixel wide, the axis labels thinned until they are
// meaningless, and a shape that reads as noise. Past the threshold the
// series is summed into weeks, which is the granularity a year-long
// question is actually asked at.
//
// Sums EVERY numeric field and keeps the first date of the group, so
// one implementation serves both the Overview and Usage series shapes.
// The corollary matters: derived rates (conversion, turns per session)
// must be computed from the bucketed counts AFTER this runs — summing
// seven daily percentages would be meaningless.
const WEEKLY_ABOVE = 120;

export function byWeekIfLong<T extends { date: string }>(rows: T[]): { rows: T[]; weekly: boolean } {
  if (rows.length <= WEEKLY_ABOVE) return { rows, weekly: false };
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += 7) {
    const group = rows.slice(i, i + 7);
    const acc = { ...group[0] };
    for (const row of group.slice(1)) {
      for (const k of Object.keys(acc) as (keyof T)[]) {
        if (typeof acc[k] === 'number') {
          (acc[k] as number) = (acc[k] as number) + (row[k] as number);
        }
      }
    }
    out.push(acc);
  }
  return { rows: out, weekly: true };
}

// ── Monotone cubic interpolation ──────────────────────────────────
//
// Fritsch–Carlson. Straight segments between daily points read as a
// jagged sawtooth on any series with real variance; a naive cubic
// smooths it but overshoots, which on a count series draws a curve
// dipping below zero on the way into a quiet day — a line claiming
// something impossible. This variant is shape-preserving: it cannot
// overshoot a local extreme, so a zero day stays at zero.
type Pt = readonly [number, number];

function monotone(pts: Pt[]): string {
  const n = pts.length;
  if (n === 0) return '';
  if (n < 3) return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');

  const dx: number[] = [], slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    slope[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
  }

  // Tangents, clamped where the slope changes sign so the curve turns
  // flat at a peak or trough instead of sailing past it.
  const t: number[] = new Array(n);
  t[0] = slope[0];
  t[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) { t[i] = 0; continue; }
    const w1 = 2 * dx[i] + dx[i - 1];
    const w2 = dx[i] + 2 * dx[i - 1];
    t[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
  }

  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${(pts[i][0] + h).toFixed(1)} ${(pts[i][1] + t[i] * h).toFixed(1)}`
       + ` ${(pts[i + 1][0] - h).toFixed(1)} ${(pts[i + 1][1] - t[i + 1] * h).toFixed(1)}`
       + ` ${pts[i + 1][0].toFixed(1)} ${pts[i + 1][1].toFixed(1)}`;
  }
  return d;
}

/** The same curve closed into a filled band between `top` and `base`. */
function band(top: Pt[], base: Pt[]): string {
  const down = monotone([...base].reverse()).replace(/^M/, 'L');
  return `${monotone(top)} ${down} Z`;
}

// ── Sparkline ─────────────────────────────────────────────────────
// Deliberately axis-free and hover-free: it lives inside a stat tile
// where the number is the message and this is only its shape.
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  const id = useId();
  const w = 100, h = 28;
  if (values.length < 2) return <div className={cn('h-7', className)} />;

  const max = Math.max(...values, 1);
  const step = w / (values.length - 1);
  const pts: Pt[] = values.map((v, i) => [i * step, h - (v / max) * (h - 3) - 1.5]);
  const line = monotone(pts);
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

/** The x-axis label thinner, shared by every dated plot: roughly one
 *  label per `per` pixels, so labels can never collide at any width. */
const everyNth = (count: number, width: number, per: number) =>
  Math.ceil(count / Math.max(2, Math.floor(width / per)));

// ── Stacked area ──────────────────────────────────────────────────
//
// Two series, upper stacked on lower, one point per bucket.
//
// The fills are muted and the boundaries are drawn instead: a 2px
// surface-coloured gap where the bands meet, a 2px series line along
// the top. Saturated fills over a large area read loud — the crisp
// edge is what makes the shape legible, not the weight of the ink.
interface StackPoint { date: string; lower: number; upper: number }

function StackedArea({
  data, labels, format = (n: number) => String(n), label, weekly,
}: {
  data: StackPoint[];
  /** [lower, upper] — legend and tooltip both read these. */
  labels: [string, string];
  format?: (n: number) => string;
  /** The accessible description of the whole chart. */
  label: string;
  weekly?: boolean;
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

  const at = (pick: (d: StackPoint) => number): Pt[] => data.map((d, i) => [x(i), y(pick(d))]);
  const zero: Pt[] = data.map((_, i) => [x(i), y(0)]);
  const lowerTop = at((d) => d.lower);
  const totalTop = at((d) => d.lower + d.upper);

  const ticks = [0, max / 2, max];
  const active = hover ? data[hover.i] : null;
  const nth = everyNth(data.length, W, 110);
  const bucket = weekly ? 'Week of ' : '';

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
            <stop offset="0%" stopColor={S1} stopOpacity="0.5" />
            <stop offset="100%" stopColor={S1} stopOpacity="0.12" />
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

        {/* Keyed on the bucket count so a range change replays the
            draw-in and a refetch of the same range does not. */}
        <g className="ck-plot" key={data.length}>
          <path d={band(totalTop, lowerTop)} fill={`url(#${gid}-a)`} />
          <path d={band(lowerTop, zero)} fill={S2} fillOpacity="0.34" />
          {/* The gap, not a border: a surface-coloured stroke along the
              seam keeps the two fills from bleeding into one another. */}
          <path d={monotone(lowerTop)} fill="none" stroke="var(--color-surface)" strokeWidth="2.5" />
          <path d={monotone(lowerTop)} fill="none" stroke={S2} strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" />
          <path d={monotone(totalTop)} fill="none" stroke={S1} strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" />
        </g>

        {data.map((d, i) => (
          <text key={d.date} x={x(i)} y={H - 6} textAnchor="middle"
                className="fill-faint" style={{ fontSize: 9.5 }}>
            {i % nth === 0 ? fmtDay(d.date) : ''}
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
          <div className="font-semibold">{bucket}{fmtDay(active.date)}</div>
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

/** Tokens per bucket — output stacked over input.
 *
 *  Input is the LOWER band on purpose: it is the larger number on
 *  almost every deployment (a retrieval prompt carries thousands of
 *  characters of context, a reply carries hundreds), so putting it
 *  underneath keeps the chart from looking like a thin line with a
 *  cliff on top. */
export function TokensChart({ data, weekly }: {
  data: { date: string; inputTokens: number; outputTokens: number }[];
  weekly?: boolean;
}) {
  const max = Math.max(...data.map((d) => d.inputTokens + d.outputTokens), 0);
  return (
    <StackedArea
      data={data.map((d) => ({ date: d.date, lower: d.inputTokens, upper: d.outputTokens }))}
      labels={['Input', 'Output']}
      format={compactNumber}
      weekly={weekly}
      label={`Tokens per ${weekly ? 'week' : 'day'}. ${data.length} buckets, peak ${max} tokens.`}
    />
  );
}

// ── MiniChart ─────────────────────────────────────────────────────
//
// One compact panel: one series, its own axis, its own tooltip.
//
// This is the shape that replaces every temptation to overlay a second
// measure on an existing plot. Two of these side by side over the same
// date range is a small multiple — the reader compares them by looking
// across, and neither scale is distorted to fit the other.
//
// One series means no legend box: the caption names it, and the peak
// beside the caption is the direct label, which keeps the range
// readable without printing a number on every mark.
export interface MiniPoint { date: string; value: number }

export function MiniChart({
  title, data, kind = 'area', color = S1, format = (n: number) => String(n),
  max: fixedMax, weekly, noun,
}: {
  title: string;
  data: MiniPoint[];
  kind?: 'area' | 'column';
  color?: string;
  format?: (n: number) => string;
  /** Pin the axis — a rate is read against 100%, not against its own peak. */
  max?: number;
  weekly?: boolean;
  /** What one mark counts, for the tooltip: "3 leads". */
  noun?: string;
}) {
  const gid = useId();
  const [box, W] = useWidth();
  const H = 132, PAD_L = 34, PAD_R = 8, PAD_T = 12, PAD_B = 20;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;

  const peak = useMemo(() => Math.max(...data.map((d) => d.value), 0), [data]);
  const max = fixedMax ?? niceMax(peak);
  const { ref, hover, onMove, clear } = useNearest(data.length, PAD_L, plotW);

  if (!data.length) return null;
  const y = (v: number) => PAD_T + plotH - (v / max) * plotH;
  const active = hover ? data[hover.i] : null;
  const bucket = weekly ? 'Week of ' : '';

  // Columns sit in slots; an area's points sit on the gridline.
  const slot = plotW / data.length;
  const barW = Math.max(3, Math.min(16, slot - 3));   // the -3 is the inter-bar gap
  const cx = (i: number) => kind === 'column'
    ? PAD_L + slot * i + slot / 2
    : PAD_L + (i / Math.max(1, data.length - 1)) * plotW;

  const top: Pt[] = data.map((d, i) => [cx(i), y(d.value)]);
  const zero: Pt[] = data.map((_, i) => [cx(i), y(0)]);
  const nth = everyNth(data.length, W, 78);

  return (
    <div className="relative" ref={box}>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-xs font-semibold text-fg">{title}</span>
        <span className="text-xs text-muted">peak {format(peak)}</span>
      </div>

      <svg
        ref={ref} viewBox={`0 0 ${W} ${H}`} width="100%" height={H}
        onPointerMove={onMove} onPointerLeave={clear}
        role="img"
        aria-label={`${title}. ${data.length} ${weekly ? 'weeks' : 'days'}, peak ${format(peak)}.`}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.42" />
            <stop offset="100%" stopColor={color} stopOpacity="0.04" />
          </linearGradient>
        </defs>

        {[0, max].map((t) => (
          <g key={t}>
            <line x1={PAD_L} x2={W - PAD_R} y1={y(t)} y2={y(t)}
                  stroke="var(--color-chart-grid)" strokeWidth="1" />
            <text x={PAD_L - 7} y={y(t) + 3.5} textAnchor="end"
                  className="fill-faint" style={{ fontSize: 10 }}>{format(t)}</text>
          </g>
        ))}

        <g className="ck-plot" key={data.length}>
          {kind === 'area' ? (
            <>
              <path d={band(top, zero)} fill={`url(#${gid})`} />
              <path d={monotone(top)} fill="none" stroke={color} strokeWidth="2"
                    strokeLinecap="round" strokeLinejoin="round" />
            </>
          ) : (
            data.map((d, i) => {
              const h = d.value ? Math.max(3, PAD_T + plotH - y(d.value)) : 0;
              return (
                <rect key={d.date} x={cx(i) - barW / 2} y={PAD_T + plotH - h}
                      width={barW} height={h} rx="3" fill={color}
                      opacity={hover && hover.i !== i ? 0.45 : 1} />
              );
            })
          )}
        </g>

        {data.map((d, i) => (
          <text key={d.date} x={cx(i)} y={H - 6} textAnchor="middle"
                className="fill-faint" style={{ fontSize: 9.5 }}>
            {i % nth === 0 ? fmtDay(d.date) : ''}
          </text>
        ))}

        {active && kind === 'area' && (
          <g pointerEvents="none">
            <line x1={cx(hover!.i)} x2={cx(hover!.i)} y1={PAD_T} y2={PAD_T + plotH}
                  stroke="var(--color-border-strong)" strokeWidth="1" />
            <circle cx={cx(hover!.i)} cy={y(active.value)} r="4.5"
                    fill={color} stroke="var(--color-surface)" strokeWidth="2" />
          </g>
        )}
      </svg>

      {active && (
        <Tooltip left={`${((cx(hover!.i) / W) * 100).toFixed(2)}%`}>
          <div className="font-semibold">{bucket}{fmtDay(active.date)}</div>
          <div className="text-muted">
            {format(active.value)}{noun ? ` ${noun}${active.value === 1 ? '' : 's'}` : ''}
          </div>
        </Tooltip>
      )}
    </div>
  );
}

// ── ShareBar: part-to-whole ───────────────────────────────────────
//
// One 100% bar plus a legend that carries every value — the legend IS
// the table view, so no value on this chart is reachable only by
// hovering, and no label is ever squeezed inside a segment too small
// to hold it.
//
// Capped at five named segments plus an "Other": past ~6 the segments
// stop being comparable, and a sixth hue would have to be generated,
// which the validated palette does not cover.
export interface ShareItem { key: string; label: string; value: number; hint?: string }

const MAX_SEGMENTS = 5;

export function ShareBar({ items, format = compactNumber }: {
  items: ShareItem[];
  format?: (n: number) => string;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const segments = useMemo(() => {
    const positive = items.filter((i) => i.value > 0);

    // Hue by a STABLE key, not by size: assigning the palette in
    // alphabetical order means a vendor keeps its colour when its share
    // moves, so a reader who learned "Gemini is gold" is not misled the
    // week Gemini drops to second.
    const hue = new Map(
      [...positive].sort((a, b) => a.key.localeCompare(b.key))
        .slice(0, MAX_SEGMENTS)
        .map((item, i) => [item.key, SLOTS[i]] as const),
    );

    // ...but READ largest-first, which is what a part-to-whole bar is for.
    const ranked = [...positive].sort((a, b) => b.value - a.value);
    // Widened to string: the "Other" fill appended below is deliberately
    // not one of the slots.
    const named: (ShareItem & { color: string })[] = ranked
      .filter((i) => hue.has(i.key))
      .map((i) => ({ ...i, color: hue.get(i.key)! }));
    const rest = ranked.filter((i) => !hue.has(i.key));

    if (rest.length) {
      named.push({
        key: '__other',
        label: `Other (${rest.length})`,
        value: rest.reduce((s, i) => s + i.value, 0),
        hint: rest.map((i) => i.label).join(', '),
        color: OTHER,
      });
    }
    return named;
  }, [items]);

  const total = segments.reduce((s, i) => s + i.value, 0);
  if (!total) return null;

  return (
    <div>
      {/* gap-[2px] is the surface gap between fills — a separator, not
          a border drawn around each segment. */}
      <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full" role="presentation">
        {segments.map((s) => (
          <div
            key={s.key}
            className="h-full transition-opacity first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${(s.value / total) * 100}%`,
              background: s.color,
              opacity: hover && hover !== s.key ? 0.4 : 1,
            }}
            onMouseEnter={() => setHover(s.key)}
            onMouseLeave={() => setHover(null)}
          />
        ))}
      </div>

      <ul className="mt-4 space-y-2">
        {segments.map((s) => (
          <li
            key={s.key}
            className="flex items-baseline gap-2.5 text-[13px]"
            onMouseEnter={() => setHover(s.key)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="h-2 w-2 shrink-0 translate-y-[-1px] rounded-[2px]"
                  style={{ background: s.color }} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate" title={s.hint ?? s.label}>{s.label}</span>
            <span className="shrink-0 tabular-nums text-muted">{format(s.value)}</span>
            <span className="w-10 shrink-0 text-right font-semibold tabular-nums">
              {Math.round((s.value / total) * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Horizontal bars: top questions ────────────────────────────────
// Horizontal because the labels are sentences; a column chart would
// either truncate them or rotate them. One series, so every bar wears
// slot 1 — colouring them by value would spend the identity channel
// re-encoding what bar length already shows.
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
