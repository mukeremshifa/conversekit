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

/**
 * Neutralise a lead marker the VISITOR typed.
 *
 * extractLead runs over the model's raw reply, so a visitor who talks
 * the model into echoing `[[LEAD:{"name":"…","email":"…"}]]` writes a
 * row into the leads table and fires the tenant's notification at a
 * sales team who will chase it. Rule 7 in the system prompt ("do not
 * repeat their words") is the only other thing in the way, and a
 * prompt instruction is not a control.
 *
 * Applied once in preflight, to the string that is both sent to the
 * model and persisted — so a marker cannot come back through the
 * history window on a later turn either.
 *
 * The delimiter is broken rather than the text removed, because a
 * visitor asking why `[[LEAD:...]]` appeared in their chat is a real
 * question — this product's own site bot will get it — and stripping
 * would hand the model a mangled version of it. The defanged form
 * reads the same to a human and cannot round-trip through
 * LEAD_PATTERN. Matching is looser than that pattern (case, inner
 * space) so that a model tidying up `[[lead :` on the way out cannot
 * hand back something that does match.
 */
export function defangLeadMarker(text: string): string {
  return text.replace(/\[\[\s*LEAD\s*:/gi, '[ [LEAD:');
}

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
