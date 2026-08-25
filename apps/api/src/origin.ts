// ----------------------------------------------------------------
// Origin lock
//
// A bot used to carry one exact origin string, which fails the moment
// a client has both an apex and a www host — or a staging site. This
// normalises and matches against a list, and keeps reading the legacy
// single-value column so the deploy can precede the migration.
// ----------------------------------------------------------------
import type { Bot } from './types';

/** Lower-case, strip trailing slashes. Origins are compared exactly
 *  otherwise: scheme and port are part of the identity. */
export function normalizeOrigin(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, '');
}

export function allowedOriginsFor(bot: Bot): string[] {
  const list = bot.allowed_origins?.length
    ? bot.allowed_origins
    : bot.allowed_origin ? [bot.allowed_origin] : [];
  return list.map(normalizeOrigin).filter(Boolean);
}

export function isOriginAllowed(bot: Bot, requestOrigin: string): boolean {
  return allowedOriginsFor(bot).includes(normalizeOrigin(requestOrigin));
}

/**
 * Validate what a tenant typed before it is stored. A trailing slash or
 * a path silently breaks the exact match at request time, which is very
 * hard to debug from the widget side — reject it at the source instead.
 */
export function validateOrigins(input: unknown): { ok: true; origins: string[] } | { ok: false; error: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: '`allowed_origins` must be a non-empty array' };
  }
  if (input.length > 20) return { ok: false, error: 'At most 20 origins' };

  const origins: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'Each origin must be a non-empty string' };
    const value = normalizeOrigin(raw);

    let url: URL;
    try { url = new URL(value); }
    catch { return { ok: false, error: `'${raw}' is not a valid URL` }; }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { ok: false, error: `'${raw}' must use http or https` };
    }
    if (url.pathname !== '/' || url.search || url.hash) {
      return { ok: false, error: `'${raw}' must be an origin only — no path, query or fragment` };
    }
    if (value !== url.origin.toLowerCase()) {
      return { ok: false, error: `'${raw}' should be written as '${url.origin.toLowerCase()}'` };
    }
    if (!origins.includes(value)) origins.push(value);
  }
  return { ok: true, origins };
}

export function validateSuggestions(input: unknown): { ok: true; suggestions: string[] | null } | { ok: false; error: string } {
  if (input === null || input === undefined) return { ok: true, suggestions: null };
  if (!Array.isArray(input)) return { ok: false, error: '`suggestions` must be an array or null' };
  if (input.length > 6) return { ok: false, error: 'At most 6 suggestions' };

  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return { ok: false, error: 'Each suggestion must be a string' };
    const value = raw.trim();
    if (!value) continue;
    // They render as chips in a 370px panel; longer wraps badly.
    if (value.length > 80) return { ok: false, error: 'Suggestions must be 80 characters or fewer' };
    out.push(value);
  }
  return { ok: true, suggestions: out.length ? out : null };
}
