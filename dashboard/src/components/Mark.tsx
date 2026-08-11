// ----------------------------------------------------------------
// The ConverseKit mark.
//
// The rounded frame is the host page; the gold dot is the widget,
// pinned bottom-right exactly where widget.js puts it. The frame is
// knocked out around the dot so the dot reads as sitting ON a page
// rather than inside a picture.
//
// The frame inherits currentColor so the mark works on any ground;
// the dot stays #EEBA2B because that is the brand at full strength,
// and this is one of the places it is on display.
// ----------------------------------------------------------------
import { useId } from 'react';
import { cn } from '@/lib/utils';

export function Mark({ className }: { className?: string }) {
  // Two marks on one page (sidebar + a dialog) would otherwise collide
  // on a hard-coded mask id and one would render without its notch.
  const id = useId();
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      className={cn('h-5 w-5 shrink-0', className)}
      role="img"
      aria-label="ConverseKit"
    >
      <mask id={id}>
        <rect width="32" height="32" fill="#fff" />
        <circle cx="23" cy="23" r="8.25" fill="#000" />
      </mask>
      <rect
        x="3.25" y="3.25" width="25.5" height="25.5" rx="7.5"
        stroke="currentColor" strokeWidth="2.5" mask={`url(#${id})`}
      />
      <circle cx="23" cy="23" r="5.25" fill="#EEBA2B" />
    </svg>
  );
}

/** Mark plus wordmark. The two halves split by weight, not colour —
 *  gold cannot legally tint text on the light ground, and a weight
 *  split reads as typographic confidence rather than a colour trick. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2.5', className)}>
      <Mark />
      <span className="font-display text-[17px] leading-none tracking-[-0.03em]">
        Converse<span className="font-normal text-muted">Kit</span>
      </span>
    </span>
  );
}
