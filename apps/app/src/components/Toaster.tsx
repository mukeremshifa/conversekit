// ----------------------------------------------------------------
// The toast surface.
//
// Sonner supplies the behaviour, which is the half worth keeping: the
// stack, the timers, hover-to-hold, swipe to dismiss, and the aria
// live region. None of its appearance survives. `unstyled` switches
// off the toast half of its stylesheet and the card is rebuilt from
// the same tokens, radius and type scale as every other surface here,
// so it reads as one of ours rather than as a library's default.
//
// What that replaced was `richColors`, which floods the whole toast
// with sonner's own green or red. Two things wrong with it: neither
// hue is in this palette, and a wall of colour is a louder claim than
// "Saved" deserves. Status now sits in a small tinted chip behind the
// icon — the treatment Badge already gives it — over a neutral card.
// The two icons differ in shape as well as colour, so the distinction
// survives a reader who cannot tell the two hues apart.
//
// Bottom right, because a toast should sit out of the way of the
// thing it is commenting on; top centre lands on the page heading and
// over any open dialog, which is exactly where the eye already is.
// Under 600px sonner takes over and lays the toast across the bottom
// of the screen, where there is no corner to spare.
//
// A few rules cannot be reached from here — elevation, the stack
// behind the front toast, the transition curve — and live next to the
// motion vocabulary in index.css. See the Toasts block there.
// ----------------------------------------------------------------
import { Toaster as Sonner } from 'sonner';
import { Check, TriangleAlert, X } from 'lucide-react';

/** The chip: 20px, which is exactly the line box of the title beside
 *  it, so the two align on the first line whether or not a second one
 *  follows. Colour arrives per type from the toast's own data-type. */
const ICON =
  'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ' +
  'group-data-[type=success]:border-success/25 group-data-[type=success]:bg-success/10 group-data-[type=success]:text-success ' +
  'group-data-[type=error]:border-danger/25 group-data-[type=error]:bg-danger/10 group-data-[type=error]:text-danger';

/** Only errors ask for one (lib/toast.ts), so it is styled like the
 *  dialog's close rather than sonner's circle hanging off the corner.
 *  order-last puts it at the right-hand end: sonner renders it first
 *  in the DOM, which is the right reading order for a screen reader
 *  and the wrong one for the eye. */
const CLOSE =
  'order-last -mr-1 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center self-start ' +
  'rounded-md text-faint transition-colors hover:bg-sunk hover:text-fg';

export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      className="ck-toaster"
      icons={{
        success: <Check className="h-3 w-3" strokeWidth={3} />,
        error: <TriangleAlert className="h-3 w-3" strokeWidth={2.5} />,
        close: <X className="h-3.5 w-3.5" />,
      }}
      toastOptions={{
        unstyled: true,
        closeButtonAriaLabel: 'Dismiss',
        classNames: {
          // `group` is what lets the icon read the toast's data-type.
          // The width comes from the toaster; below 600px sonner
          // overrides it with the full-bleed one.
          toast:
            'ck-toast group flex w-full items-start gap-2.5 rounded-xl border border-border ' +
            'bg-surface px-3.5 py-3 text-fg',
          icon: ICON,
          content: 'flex min-w-0 flex-1 flex-col gap-1',
          title: 'text-sm font-medium leading-5',
          description: 'text-[13px] leading-relaxed text-muted',
          closeButton: CLOSE,
        },
      }}
    />
  );
}
