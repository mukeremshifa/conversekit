// ----------------------------------------------------------------
// Lead extraction
// Gemini appends [[LEAD:{...}]] at the end of its reply when it
// has collected enough info from the visitor. We strip it from the
// visible text and return both parts separately.
// ----------------------------------------------------------------

export interface ExtractedLead {
  name: string;
  email: string;
  phone: string | null;
  inquiry: string | null;
}

export interface ExtractionResult {
  cleanReply: string;
  lead: ExtractedLead | null;
}

const LEAD_PATTERN = /\[\[LEAD:([\s\S]*?)\]\]/;

export function extractLead(rawReply: string): ExtractionResult {
  const match = rawReply.match(LEAD_PATTERN);

  if (!match) {
    return { cleanReply: rawReply.trim(), lead: null };
  }

  // Strip the marker from the visible reply first
  const cleanReply = rawReply.replace(LEAD_PATTERN, '').trim();

  let lead: ExtractedLead | null = null;
  try {
    const parsed = JSON.parse(match[1].trim());

    const name  = typeof parsed.name  === 'string' ? parsed.name.trim()  : '';
    const email = typeof parsed.email === 'string' ? parsed.email.trim() : '';

    // Require at minimum a non-empty name and a plausible email
    if (name && email && email.includes('@')) {
      lead = {
        name,
        email,
        phone:   typeof parsed.phone   === 'string' && parsed.phone   ? parsed.phone.trim()   : null,
        inquiry: typeof parsed.inquiry === 'string' && parsed.inquiry ? parsed.inquiry.trim() : null,
      };
    } else {
      console.warn('[leads] LEAD block found but missing name or valid email — skipping save.');
    }
  } catch (err) {
    console.warn('[leads] Failed to parse LEAD JSON — skipping save.', err);
  }

  return { cleanReply, lead };
}
