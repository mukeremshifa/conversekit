// ----------------------------------------------------------------
// Streaming-safe lead marker filter
//
// The model appends [[LEAD:{...}]] to the end of a reply. In the
// non-streaming path leads.ts strips it before the visitor ever sees
// it — but when tokens are forwarded as they arrive, the marker would
// appear on screen character by character before we could react.
//
// This holds back exactly the text that might still turn out to be a
// marker (including a partial opener split across chunks) and releases
// everything else immediately, so the visitor sees no lag.
// ----------------------------------------------------------------

const OPEN  = '[[LEAD:';
const CLOSE = ']]';

/**
 * Longest suffix of `s` that is a proper prefix of `marker`.
 * A chunk ending in "…thanks! [[LE" must not be emitted yet.
 */
function heldPrefixLength(s: string, marker: string): number {
  const max = Math.min(s.length, marker.length - 1);
  for (let k = max; k > 0; k--) {
    if (s.endsWith(marker.slice(0, k))) return k;
  }
  return 0;
}

export class LeadStreamFilter {
  /** Everything the model produced, markers included — for extractLead(). */
  private raw = '';
  /** Buffered text not yet safe to emit. */
  private pending = '';

  /** Feed a delta; returns the text that is safe to show the visitor. */
  push(delta: string): string {
    this.raw     += delta;
    this.pending += delta;

    let out = '';

    for (;;) {
      const start = this.pending.indexOf(OPEN);
      if (start === -1) break;

      const end = this.pending.indexOf(CLOSE, start + OPEN.length);
      if (end === -1) {
        // Opener seen, payload still arriving: emit what precedes it, hold the rest.
        out += this.pending.slice(0, start);
        this.pending = this.pending.slice(start);
        return out;
      }

      // Complete marker: drop it and keep scanning what follows.
      out += this.pending.slice(0, start);
      this.pending = this.pending.slice(end + CLOSE.length);
    }

    const held = heldPrefixLength(this.pending, OPEN);
    out += this.pending.slice(0, this.pending.length - held);
    this.pending = this.pending.slice(this.pending.length - held);

    return out;
  }

  /**
   * Call once the stream ends.
   * `tail` is any held text that turned out not to be a marker after all.
   * `raw` is the full reply for extractLead() to parse.
   */
  flush(): { tail: string; raw: string } {
    // A leftover starting with the opener is a truncated marker — never show it.
    const tail = this.pending.startsWith(OPEN) ? '' : this.pending;
    this.pending = '';
    return { tail, raw: this.raw };
  }
}
