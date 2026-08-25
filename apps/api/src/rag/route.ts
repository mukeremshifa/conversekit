// ----------------------------------------------------------------
// The retrieval router (015, Phase 5)
//
// THIS IS THE PART THAT ACTUALLY STOPS THE RAG CALLS. A structured
// profile makes hours and address deterministic, but on its own it
// changes nothing about what runs: before this file, the only gate in
// front of an embedding round-trip plus a pgvector search was
// `isTooShortToRetrieve` — four codepoints. "thanks!", "ok sounds good"
// and "what time do you open" each fired one, and each could pull up to
// DEFAULT_CONTEXT_CHARS of excerpts into a prompt that did not need
// them.
//
// WHAT THAT IS WORTH, HONESTLY. Not the embedding bill: a 20-token
// query on text-embedding-3-small is about $0.0000004 and you would
// need millions of turns to notice. In order, it is worth (1) not
// polluting the prompt — retrieved chunks are the largest variable part
// of it and are billed at CHAT-model rates on every turn, which is
// where retrieval costs real money indirectly; and (2) latency, because
// an embedding round-trip sits in front of time-to-first-token.
//
// A FALSE SKIP IS A WRONG ANSWER; A FALSE RETRIEVE IS ONLY LATENCY.
// Every rule below is written from that asymmetry. Skip only on
// confidence, and when in doubt, search.
//
// DO NOT ROUTE BY INTENT REGEX. /what.*hours/i will never match
// 你们几点开门, and the system prompt explicitly tells the model to
// answer in the visitor's own language. Intent detection is not needed
// anyway: because the profile is ALWAYS in the prompt, an hours
// question is answered correctly whether or not anything recognised it
// as one. This router's job is to catch turns where retrieval is
// POINTLESS, never turns where it is merely unnecessary.
// ----------------------------------------------------------------
import type { Bot } from '../types';
import { ragConfigFor } from './ingest';
import { isTooShortToRetrieve } from './retrieve';

export type TurnRoute = 'skip' | 'faq' | 'retrieve';

export interface RouteDecision {
  route: TurnRoute;
  /** Why, in words, for the retrieval preview and the logs. Never shown
   *  to a visitor, so it is allowed to be terse and English. */
  reason: string;
}

/**
 * Closings and acknowledgements, in the languages this platform's
 * visitors actually arrive speaking.
 *
 * MATCHED WHOLE-MESSAGE, NEVER AS A SUBSTRING. "thanks, but what are
 * your hours?" is a question, and a substring test would kill it — that
 * single mistake is the difference between this being a latency
 * optimisation and being a bot that got dumber. The test for it is
 * pinned in scripts/test-profile-units.mjs and must stay pinned.
 *
 * Deliberately short. Every entry added here is a new way to be wrong,
 * and the upside of catching one more phrasing is one embedding call.
 */
const CLOSINGS = new Set([
  // English
  'thanks', 'thank you', 'thanks a lot', 'thanks so much', 'many thanks',
  'thankyou', 'thx', 'ty', 'cheers', 'ok', 'okay', 'k', 'kk', 'okey',
  'ok thanks', 'okay thanks', 'ok thank you', 'alright', 'right', 'got it',
  'sounds good', 'ok sounds good', 'sounds great', 'perfect', 'great',
  'brilliant', 'lovely', 'nice', 'awesome', 'cool', 'no thanks', 'no thank you',
  'bye', 'goodbye', 'bye bye', 'see you', 'see ya', 'take care', 'good night',
  'have a good day', 'you too', 'no worries', 'never mind', 'nvm',
  // Spanish / Portuguese / Italian / French / German / Dutch
  'gracias', 'muchas gracias', 'vale', 'adios', 'adiós', 'hasta luego',
  'obrigado', 'obrigada', 'muito obrigado', 'tchau', 'ate logo', 'até logo',
  'grazie', 'grazie mille', 'ciao', 'arrivederci',
  'merci', 'merci beaucoup', 'au revoir', 'a bientot', 'à bientôt', 'd accord',
  'danke', 'danke schon', 'danke schön', 'vielen dank', 'tschuss', 'tschüss',
  'auf wiedersehen', 'alles klar',
  'bedankt', 'dank je', 'doei', 'tot ziens',
  // Nordic / Polish / Turkish
  'tack', 'tack sa mycket', 'takk', 'tak', 'hej da', 'hejdå',
  'dziekuje', 'dziękuję', 'dzieki', 'dzięki', 'do widzenia',
  'tesekkurler', 'teşekkürler', 'sagol', 'sağol', 'gorusuruz', 'görüşürüz',
  // CJK / Arabic / Hebrew / Russian / Hindi
  '谢谢', '谢谢你', '多谢', '感謝', '謝謝', '再见', '再見', '好的', '好',
  'ありがとう', 'ありがとうございます', 'どうも', 'さようなら', 'はい',
  '감사합니다', '고맙습니다', '안녕히계세요', '네',
  'شكرا', 'شكرًا', 'شكرا لك', 'مع السلامة',
  'תודה', 'תודה רבה', 'להתראות',
  'спасибо', 'большое спасибо', 'до свидания', 'пока', 'хорошо',
  'धन्यवाद', 'शुक्रिया',
]);

/**
 * An email address and nothing else, or a phone-shaped string and
 * nothing else.
 *
 * This is a LEAD-CAPTURE REPLY, not a question — the bot asked for a
 * contact detail one turn ago and the visitor typed it. Embedding it
 * searches the corpus for a phone number, which finds either nothing or
 * something coincidental, and neither helps.
 *
 * Both are anchored to the whole message. "call me on 07700 900123 and
 * tell me about implants" is a question with a phone number in it.
 */
const BARE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** Digits, spaces and the punctuation phone numbers are written with —
 *  at least seven digits, so a year or a house number is not one. */
const BARE_PHONE = /^[+(]?[\d\s().+-]{7,24}$/;

const digitsIn = (s: string) => (s.match(/\d/g) ?? []).length;

/**
 * Casing and edge punctuation removed, and nothing else.
 *
 * Unicode-aware classes, because a message ending in a Chinese full
 * stop or an Arabic question mark is as finished as one ending in a
 * dot. The INTERIOR is left intact, which is what keeps this usable for
 * the bare-email and bare-phone tests below — an address with its `@`
 * and its dots stripped is not an address any more.
 */
function normalise(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/^[\p{P}\p{S}\s]+/u, '')
    .replace(/[\p{P}\p{S}\s]+$/u, '')
    // Interior whitespace collapses so "thank  you" and "thank\nyou"
    // are the same closing. This does not join words that were not
    // already separate.
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * The form the closing set is looked up in: punctuation ANYWHERE
 * becomes a space, so "ok, sounds good" and "ok sounds good" are the
 * same message and "d'accord" matches "d accord".
 *
 * THIS IS STILL A WHOLE-MESSAGE TEST, and that is the property to
 * protect. Stripping punctuation cannot turn a question into a closing:
 * "thanks, but what are your hours?" becomes "thanks but what are your
 * hours", which is not in the set and never will be. What it must never
 * become is a SUBSTRING test — that single change is the difference
 * between this being a latency win and being a bot that stopped
 * answering. scripts/test-profile-units.mjs pins exactly that case.
 */
function words(normalised: string): string {
  return normalised
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * What this turn should do.
 *
 * Called from the chat path in place of the bare `hasCorpus` check, and
 * it subsumes `isTooShortToRetrieve` — which stays exported and
 * unit-tested in retrieve.ts, because it is the multilingual codepoint
 * floor from B3 and must not be re-derived here.
 *
 * 'faq' is returned by nothing yet and is not a gap: the FAQ shortcut
 * (Phase 7) lives inside retrieve(), where it can fall through to the
 * vector search on a miss without a second round trip. The value exists
 * so that a future router which can decide it in advance has somewhere
 * to say so.
 */
export function routeTurn(query: string, bot: Bot): RouteDecision {
  // OFF BY DEFAULT, so nobody's bot changes under them on deploy — the
  // same reasoning retrieval_mode defaults to 'fallback' for. Checked
  // FIRST, so a bot with the router off behaves exactly as it did
  // before this file existed, including for the too-short case, which
  // retrieve() still handles on its own.
  if (ragConfigFor(bot).router !== 'on') return { route: 'retrieve', reason: 'router off' };

  // B3's floor, not a re-derivation of it. 多少钱 ("how much?") is a
  // complete question in three characters and must not be skipped.
  if (isTooShortToRetrieve(query)) return { route: 'skip', reason: 'too short to embed' };

  const q = normalise(query);
  if (!q) return { route: 'skip', reason: 'punctuation only' };

  if (CLOSINGS.has(words(q))) return { route: 'skip', reason: 'closing or acknowledgement' };

  if (BARE_EMAIL.test(q)) return { route: 'skip', reason: 'bare email address' };
  if (BARE_PHONE.test(q) && digitsIn(q) >= 7) {
    return { route: 'skip', reason: 'bare phone number' };
  }

  return { route: 'retrieve', reason: 'default' };
}
