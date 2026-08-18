// ----------------------------------------------------------------
// Lead extraction
// Gemini appends [[LEAD:{...}]] at the end of its reply when it
// has collected enough info from the visitor. We strip it from the
// visible text and return both parts separately.
//
// The marker's SHAPE became configurable in 010 (which optional fields
// the bot is asked for), but the marker's DELIMITERS did not — so
// src/lead-stream.ts, which only ever matches `[[LEAD:` and `]]`, needs
// no knowledge of any of this.
// ----------------------------------------------------------------
import type { LeadFields, LeadFieldMode } from './types';

export interface ExtractedLead {
  name: string;
  email: string;
  phone: string | null;
  inquiry: string | null;
  /** supabase/010. Null unless the bot's lead_config turned it on AND
   *  the visitor gave one. */
  company: string | null;
}

export interface ExtractionResult {
  cleanReply: string;
  lead: ExtractedLead | null;
}

const LEAD_PATTERN = /\[\[LEAD:([\s\S]*?)\]\]/;

/** Trimmed, or null when absent, blank, or the JSON null the prompt
 *  asks for on fields the visitor did not provide. */
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/**
 * @param fields Which optional fields this bot asked for
 *   (bots.lead_config.fields). Absent behaves as the pre-010 defaults —
 *   phone and inquiry on, company off.
 *
 *   A field set to `off` is discarded even if the model emits it
 *   anyway, so turning a field off is a real guarantee about what gets
 *   stored rather than a suggestion.
 *
 *   `required` is deliberately NOT enforced here. It is an instruction
 *   in the prompt, and if the model finishes without it the right
 *   outcome is a lead missing one field, not a discarded lead with a
 *   valid name and email in it. Throwing away the thing the feature
 *   exists to capture is not a stricter version of capturing it.
 */
export function extractLead(rawReply: string, fields?: LeadFields): ExtractionResult {
  const match = rawReply.match(LEAD_PATTERN);

  if (!match) {
    return { cleanReply: rawReply.trim(), lead: null };
  }

  // Strip the marker from the visible reply first
  const cleanReply = rawReply.replace(LEAD_PATTERN, '').trim();

  const on = (key: keyof LeadFields, fallback: LeadFieldMode): boolean =>
    (fields?.[key] ?? fallback) !== 'off';

  let lead: ExtractedLead | null = null;
  try {
    const parsed = JSON.parse(match[1].trim());

    const name  = typeof parsed.name  === 'string' ? parsed.name.trim()  : '';
    const email = typeof parsed.email === 'string' ? parsed.email.trim() : '';

    // Require at minimum a non-empty name and a plausible email.
    // Unchanged by 010 and not configurable: leads.email is NOT NULL
    // with a CHECK, so a lead without one cannot be stored anyway.
    if (name && email && email.includes('@')) {
      lead = {
        name,
        email,
        phone:   on('phone',   'optional') ? str(parsed.phone)   : null,
        inquiry: on('inquiry', 'optional') ? str(parsed.inquiry) : null,
        company: on('company', 'off')      ? str(parsed.company) : null,
      };
    } else {
      console.warn('[leads] LEAD block found but missing name or valid email — skipping save.');
    }
  } catch (err) {
    console.warn('[leads] Failed to parse LEAD JSON — skipping save.', err);
  }

  return { cleanReply, lead };
}
