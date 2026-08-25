// ----------------------------------------------------------------
// UI primitives, shadcn/ui style: owned source rather than an
// installed component library, so they can be bent to fit without
// fighting a package. Radix supplies the behaviour and accessibility;
// the styling is ours.
// ----------------------------------------------------------------
import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as LabelPrimitive from '@radix-ui/react-label';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cva, type VariantProps } from 'class-variance-authority';
import { Check, ChevronDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';

// ── Button ──────────────────────────────────────────────────────
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium ' +
    'transition-colors disabled:pointer-events-none disabled:opacity-50 cursor-pointer',
  {
    variants: {
      variant: {
        default: 'bg-accent text-accent-fg hover:opacity-90',
        outline: 'border border-border bg-surface hover:bg-bg',
        ghost:   'hover:bg-bg',
        danger:  'bg-danger text-white hover:opacity-90',
        link:    'text-accent-ink underline-offset-4 hover:underline p-0 h-auto',
      },
      size: {
        default: 'h-9 px-4',
        sm:      'h-8 px-3 text-xs',
        icon:    'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type = 'button', ...props }, ref) => (
    <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  ),
);
Button.displayName = 'Button';

// ── Input / Textarea ────────────────────────────────────────────
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'flex h-9 w-full rounded-lg border border-border bg-surface px-3 py-1 text-sm',
        'placeholder:text-muted disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'flex w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm leading-relaxed',
        'placeholder:text-muted disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

// ── Label / Field ───────────────────────────────────────────────
export const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root ref={ref} className={cn('text-sm font-medium', className)} {...props} />
));
Label.displayName = 'Label';

export function Field({
  label, hint, htmlFor, children, className,
}: {
  label: string; hint?: string; htmlFor?: string;
  children: React.ReactNode; className?: string;
}) {
  return (
    <div className={cn('space-y-2', className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {hint && <span className="ml-2 font-normal text-muted text-xs">{hint}</span>}
      </Label>
      {children}
    </div>
  );
}

// ── Card ────────────────────────────────────────────────────────
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-xl border border-border bg-surface', className)} {...props} />;
}
export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-start justify-between gap-4 px-6 pt-6 pb-4', className)} {...props} />;
}
export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn('text-lg font-semibold tracking-tight', className)} {...props} />;
}
export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-muted mt-1.5 leading-relaxed', className)} {...props} />;
}
export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-6 pb-6 space-y-5', className)} {...props} />;
}

// ── Badge ───────────────────────────────────────────────────────
const badgeVariants = cva('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', {
  variants: {
    tone: {
      // Semantic tokens, not raw palette shades: these carry their own
      // dark values, and the old `wait` amber now reads as the brand
      // gold, which makes a pending state look like a logo.
      neutral: 'bg-sunk text-muted border border-border',
      ok:      'bg-success/10 text-success border border-success/25',
      wait:    'bg-warning/10 text-warning border border-warning/25',
      bad:     'bg-danger/10 text-danger border border-danger/25',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({
  className, tone, ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

// ── Select ──────────────────────────────────────────────────────
export const Select = SelectPrimitive.Root;
export const SelectValue = SelectPrimitive.Value;

export const SelectTrigger = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      'flex h-9 w-full items-center justify-between rounded-lg border border-border bg-surface',
      'px-3 py-2 text-sm cursor-pointer disabled:opacity-50',
      className,
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      <ChevronDown className="h-4 w-4 opacity-50" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = 'SelectTrigger';

export const SelectContent = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = 'popper', ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      position={position}
      className={cn(
        'relative z-50 max-h-96 min-w-32 overflow-hidden rounded-lg border border-border',
        'bg-surface shadow-lg',
        position === 'popper' && 'translate-y-1 w-[var(--radix-select-trigger-width)]',
        className,
      )}
      {...props}
    >
      <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = 'SelectContent';

export const SelectItem = React.forwardRef<
  React.ComponentRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      'relative flex w-full cursor-pointer select-none items-center rounded-md py-1.5 pl-8 pr-2',
      'text-sm outline-none data-[highlighted]:bg-bg data-[disabled]:opacity-50',
      className,
    )}
    {...props}
  >
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <SelectPrimitive.ItemIndicator><Check className="h-4 w-4" /></SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = 'SelectItem';

// ── Switch ──────────────────────────────────────────────────────
export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full',
      'border-2 border-transparent transition-colors',
      'data-[state=checked]:bg-accent data-[state=unchecked]:bg-border',
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb className="pointer-events-none block h-4 w-4 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0" />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';

// ── Dialog ──────────────────────────────────────────────────────
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  className, children, title, description,
}: {
  className?: string; children: React.ReactNode; title: string; description?: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2',
          'rounded-xl border border-border bg-surface p-6 shadow-xl',
          'max-h-[calc(100vh-4rem)] overflow-y-auto',
          className,
        )}
      >
        <DialogPrimitive.Title className="text-base font-semibold">{title}</DialogPrimitive.Title>
        {description && (
          <DialogPrimitive.Description className="mt-1 text-xs text-muted">
            {description}
          </DialogPrimitive.Description>
        )}
        <div className="mt-4 space-y-4">{children}</div>
        <DialogPrimitive.Close
          className="absolute right-4 top-4 rounded-md p-1 text-muted hover:bg-bg cursor-pointer"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

// ── Table ───────────────────────────────────────────────────────
export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  );
}
export function Th({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn('h-9 px-3 text-left align-middle text-xs font-semibold uppercase tracking-wide text-muted', className)}
      {...props}
    />
  );
}
export function Td({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn('px-3 py-2.5 align-top border-t border-border', className)} {...props} />;
}

// ── Misc ────────────────────────────────────────────────────────
export function Muted({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-sm text-muted', className)} {...props} />;
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent', className)}
      role="status"
      aria-label="Loading"
    />
  );
}

// ── Skeletons ───────────────────────────────────────────────────
// A spinner says "something is happening"; a skeleton says "here is the
// shape of what is coming", and the page does not jump when it lands.
// Spinner is still right inside a button, where there is no shape to
// preview.
//
// Every shape below is built from the same components as the thing it
// stands in for — the same <Table>, the same <Card>, the same field
// wrapper — rather than from bars measured by eye. A skeleton drawn
// freehand is a second layout that has to be kept in step with the
// first, and it never is: that is how a six-column table came to be
// previewed by five loose bars, and a chat transcript by a table.
export function Skeleton({ className, inline, ...props }: React.HTMLAttributes<HTMLElement> & { inline?: boolean }) {
  const cls = cn('ck-shimmer rounded-md bg-sunk', inline && 'inline-block align-middle', className);
  // Inline where it replaces text inside a heading or a sentence — a
  // <div> there would break the line it is meant to be part of.
  return inline
    ? <span className={cls} aria-hidden="true" {...props} />
    : <div className={cls} aria-hidden="true" {...props} />;
}

/** A bar sitting in the line box of the text it replaces, so a stack of
 *  skeleton lines is exactly as tall as the copy that lands in it. */
function TextLine({ width, height = 'h-[21px]', bar = 'h-3.5' }: { width: string; height?: string; bar?: string }) {
  return <div className={cn('flex items-center', height)}><Skeleton className={cn(bar, width)} /></div>;
}

/** One column of a table skeleton. A string is the real header label —
 *  pass it wherever the call site knows it, because a header that is
 *  already correct cannot shift when the rows arrive. */
export type SkeletonColumn = string | { label?: string; align?: 'right' };

/**
 * Shaped against the table it stands in for: the real <Table>, <Th> and
 * <Td>, so the header, the column widths, the row height and the rules
 * between rows are the ones the data will land in.
 */
export function TableSkeleton({ columns, rows = 5, cols = 4, className }: {
  columns?: SkeletonColumn[];
  rows?: number;
  /** Fallback for when the call site does not know its labels. */
  cols?: number;
  className?: string;
}) {
  const spec: SkeletonColumn[] = columns ?? Array.from({ length: cols }, () => ({}));
  // Uneven widths read as content; a grid of identical bars reads as a loader.
  const widths = ['w-24', 'w-32', 'w-40', 'w-20', 'w-28', 'w-36'];
  const alignOf = (c: SkeletonColumn) => (typeof c === 'string' ? undefined : c.align);

  return (
    <Table className={className} aria-busy="true" aria-label="Loading">
      <thead>
        <tr>
          {spec.map((c, i) => {
            const label = typeof c === 'string' ? c : c.label;
            return (
              <Th key={i} className={cn(alignOf(c) === 'right' && 'text-right')}>
                {label ?? <Skeleton className="h-2.5 w-16" />}
              </Th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, r) => (
          // Fading down the list keeps the eye at the top, which is
          // where the first real row appears.
          <tr key={r} style={{ opacity: 1 - r * 0.13 }}>
            {spec.map((c, i) => (
              <Td key={i}>
                {/* my-[3px] pads the 14px bar out to the 20px line box of
                    the text it replaces, so rows keep their height. */}
                <Skeleton className={cn('my-[3px] h-3.5', widths[(r + i) % widths.length],
                  alignOf(c) === 'right' && 'ml-auto')} />
              </Td>
            ))}
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * The divided list several cards render instead of a table: rows
 * separated by a rule, each one a line or two of text with its buttons
 * at the right-hand end.
 */
export function RowsSkeleton({
  rows = 3, lines = 2, ordinal = false, actions = [], row = 'gap-3 py-3', className,
}: {
  rows?: number;
  /** Lines of text in each row. */
  lines?: number;
  /** The fixed-width number a chunk carries in front of its text. */
  ordinal?: boolean;
  /** Buttons at the right-hand end, sized like the real ones. */
  actions?: ('button' | 'icon')[];
  /** Row padding, where the list being stood in for is roomier. */
  row?: string;
  className?: string;
}) {
  // A row that leads with an ordinal is a paragraph and runs full width;
  // every other row leads with a heading-ish line and explains itself
  // underneath.
  const widths = ordinal ? ['w-full', 'w-11/12', 'w-4/5'] : ['w-1/3', 'w-3/4', 'w-1/2'];

  return (
    <div className={cn('divide-y divide-border', className)} role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className={cn('flex items-start', row)} style={{ opacity: 1 - r * 0.15 }}>
          {/* The ordinal's column is w-8 whatever the number in it. */}
          {ordinal && <div className="w-8 shrink-0"><Skeleton className="mt-1 h-3 w-6" /></div>}
          <div className="min-w-0 flex-1">
            {Array.from({ length: lines }, (_, l) => (
              <TextLine key={l} width={widths[l % widths.length]} bar={l === 0 && !ordinal ? 'h-3.5' : 'h-2.5'} />
            ))}
          </div>
          {actions.length > 0 && (
            <div className="flex shrink-0 items-center gap-1">
              {actions.map((a, i) => (
                <Skeleton key={i} className={cn('rounded-lg', a === 'icon' ? 'h-9 w-9' : 'h-8 w-28')} />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Chat bubbles in the shape Transcript renders them — visitor right,
 *  bot left, alternating lengths so it reads as a conversation. */
export function TranscriptSkeleton({ bubbles = 4, className }: { bubbles?: number; className?: string }) {
  const asked = [['w-40'], ['w-28']];
  const answered = [['w-56', 'w-44'], ['w-48', 'w-36']];

  return (
    <div className={cn('space-y-2', className)} role="status" aria-label="Loading">
      {Array.from({ length: bubbles }, (_, i) => {
        const visitor = i % 2 === 0; // a session opens with the visitor asking
        const turn = Math.floor(i / 2);
        return (
          <div key={i} className={visitor ? 'flex justify-end' : 'flex justify-start'}
               style={{ opacity: 1 - i * 0.12 }}>
            <div className={cn('max-w-[80%] px-3.5 py-2',
              visitor
                ? 'rounded-2xl rounded-br-sm bg-fg/8'
                : 'rounded-2xl rounded-bl-sm border border-border bg-bg')}>
              {(visitor ? asked : answered)[turn % 2].map((w, l) => <TextLine key={l} width={w} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** A card of form fields, for screens whose loaded state is a form
 *  rather than a list. The title and description are the real ones:
 *  that copy is static, so there is nothing to preview. */
export function FormCardSkeleton({ title, description, fields = 2, className }: {
  title: string;
  description?: string;
  fields?: number;
  className?: string;
}) {
  return (
    <Card className={className} aria-busy="true">
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {description && <CardDescription>{description}</CardDescription>}
        </div>
      </CardHeader>
      <CardContent>
        {Array.from({ length: fields }, (_, i) => (
          // Field's own wrapper, so label-to-control spacing matches.
          <div key={i} className="space-y-2">
            <TextLine width="w-24" height="h-5" />
            <Skeleton className="h-9 w-full rounded-lg" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Stat's own shape: the icon and its label, the number, the note under
 *  it — inside Stat's own wrapper, inherited space-y-5 and all. */
export function StatSkeleton({ spark = false, hint = true }: { spark?: boolean; hint?: boolean }) {
  return (
    <Card aria-busy="true">
      <CardContent className="pt-5">
        <div className="flex h-4 items-center gap-2">
          <Skeleton className="h-3.5 w-3.5 rounded" />
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-7 w-16" />
        {spark
          ? <Skeleton className="h-7 w-full" />
          : hint ? <TextLine width="w-28" height="h-5" bar="h-3" /> : null}
      </CardContent>
    </Card>
  );
}

/** A card whose body is a chart: a header the height of the real one
 *  over a box the height of the chart itself. */
export function ChartCardSkeleton({ height = 200, lines = 1 }: { height?: number; lines?: number }) {
  return (
    <Card aria-busy="true">
      <CardHeader>
        <div className="w-full">
          <TextLine width="w-36" height="h-7" bar="h-4" />
          {Array.from({ length: lines }, (_, i) => (
            <TextLine key={i} width={i === lines - 1 ? 'w-48' : 'w-72'} height="h-[22px]" bar="h-3" />
          ))}
        </div>
      </CardHeader>
      <CardContent>
        <Skeleton className="w-full" style={{ height }} />
      </CardContent>
    </Card>
  );
}

// ── Empty state ─────────────────────────────────────────────────
// These appear when a new account has nothing, which is exactly when
// someone most needs telling what to do next — hence the action.
export function EmptyState({
  icon: Icon, title, description, action, className,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-6 py-12 text-center', className)}>
      <span className="flex h-11 w-11 items-center justify-center rounded-xl border border-border bg-sunk">
        <Icon className="h-5 w-5 text-muted" />
      </span>
      <div className="space-y-1">
        <p className="font-semibold">{title}</p>
        {description && <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted">{description}</p>}
      </div>
      {action && (
        <Button variant="outline" size="sm" className="mt-1" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}

// ── Settings layout ─────────────────────────────────────────────
// The grouping the configuration screen introduced, lifted here once
// Retrieval adopted it too. Two screens rendering "sections of settings"
// from two private copies is how the two drift apart.

/** A titled group with its heading OUTSIDE the card, so a long page
 *  reads as sections rather than as one stack of boxes. */
export function Section({
  title, description, children,
}: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-display text-xl leading-tight">{title}</h2>
        {description && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** Label and its explanation on the left, the control on the right.
 *  Stacks on narrow screens, where side by side would leave the input
 *  too cramped to type in. */
export function SettingRow({
  label, description, htmlFor, children, align = 'center',
}: {
  label: string; description?: React.ReactNode; htmlFor?: string;
  children: React.ReactNode; align?: 'center' | 'start';
}) {
  return (
    <div className={cn('flex flex-col gap-3 py-6 sm:flex-row sm:gap-10',
      align === 'center' ? 'sm:items-center' : 'sm:items-start')}>
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="block text-sm font-medium leading-none">{label}</label>
        {description && <p className="mt-2 text-sm leading-relaxed text-muted">{description}</p>}
      </div>
      <div className="w-full shrink-0 sm:w-75">{children}</div>
    </div>
  );
}

export function Rows({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-border">{children}</div>;
}

/** Per section save. A long page with one button at the top means
 *  scrolling back to it, and disabling until something changes makes it
 *  obvious which sections are still unsaved. */
export function SaveBar({ busy, dirty, onSave }: { busy: boolean; dirty: boolean; onSave: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-b-xl border-t border-border bg-sunk px-6 py-4">
      <span className="text-xs text-muted">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
      <Button onClick={onSave} disabled={busy || !dirty}>{busy ? 'Saving...' : 'Save'}</Button>
    </div>
  );
}

/** A single headline number. The dashboard card used across Overview,
 *  Usage and Retrieval. */
export function Stat({ label, value, hint, tone, icon: Icon }: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'ok' | 'warn' | 'bad';
  icon: React.ComponentType<{ className?: string }>;
}) {
  return (
    <Card>
      <CardContent className="pt-5">
        <div className="flex items-center gap-2">
          <Icon className="h-3.5 w-3.5 text-faint" />
          <span className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</span>
        </div>
        <div className={cn('mt-2 font-display text-[28px] leading-none tabular-nums',
          tone === 'ok' && 'text-success', tone === 'warn' && 'text-warning', tone === 'bad' && 'text-danger')}>
          {value}
        </div>
        {hint && <p className="mt-1.5 text-xs leading-relaxed text-muted">{hint}</p>}
      </CardContent>
    </Card>
  );
}
