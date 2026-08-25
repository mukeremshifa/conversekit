// ----------------------------------------------------------------
// Toasts.
//
// Every passing message the dashboard shows goes through here rather
// than through sonner directly, so the two things that actually differ
// between kinds of message are decided once instead of at 69 call
// sites.
//
// A success is an acknowledgement — "Saved", "Logo removed" — of
// something the user just did and can see the result of, so it leaves
// quickly. An error is usually the only copy of what went wrong: the
// message is the API's, nothing else on screen repeats it, and reading
// it is the whole point. So it stays about twice as long and carries a
// close button, because the alternative to waiting it out is a swipe
// nobody discovers.
//
// The surface is deliberately just these two. Anything that wants a
// loading or promise toast should add it here with its own reasoning
// about duration and dismissal, rather than reaching past this module.
// ----------------------------------------------------------------
import { toast as sonner } from 'sonner';

const SUCCESS_MS = 3_500;
const ERROR_MS = 7_000;

export const toast = {
  success: (message: string) => sonner.success(message, { duration: SUCCESS_MS }),
  error: (message: string) => sonner.error(message, { duration: ERROR_MS, closeButton: true }),
};
