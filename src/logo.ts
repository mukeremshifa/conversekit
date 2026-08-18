// ----------------------------------------------------------------
// Bot logo
//
// The one uploaded asset that a browser has to fetch. Knowledge-base
// files never leave the Worker — they are converted to text and only
// ever read back server-side — so there was no public read path in this
// codebase before this file, and R2 objects here are NOT publicly
// addressable. A logo therefore needs the Worker to serve it:
// GET /v1/bots/:id/logo streams the object with a long, immutable
// cache lifetime, and the object key never appears in the response.
//
// Deliberately narrower than the document upload: three raster formats,
// half a megabyte, and no SVG.
// ----------------------------------------------------------------
import type { Bot } from './types';
import { widgetConfigFor } from './config';

/**
 * 512 KB. A bubble renders it at 56px and a header at 34px, so this is
 * already two orders of magnitude more than the pixels need; the room
 * is for a tenant who exports at 4x without thinking about it.
 */
export const MAX_LOGO_BYTES = 512 * 1024;

/** Enough for every signature below — WebP's needs twelve. */
export const LOGO_SNIFF_BYTES = 16;

export interface LogoType {
  mime: string;
  extension: string;
  label: string;
  matches(head: Uint8Array): boolean;
}

const startsWith = (head: Uint8Array, bytes: number[]) =>
  bytes.every((b, i) => head[i] === b);

const asciiAt = (head: Uint8Array, offset: number, text: string) =>
  [...text].every((ch, i) => head[offset + i] === ch.charCodeAt(0));

/**
 * SVG IS DELIBERATELY ABSENT, and this is the only interesting decision
 * in the file. An SVG is a document that can carry <script> and
 * external references; serving a tenant-supplied one from the API
 * origin would hand every tenant a script-execution primitive there.
 * Nothing about a logo is worth that. PNG covers transparency, which is
 * the only reason anyone actually asks for SVG here.
 */
export const LOGO_TYPES: LogoType[] = [
  {
    mime: 'image/png',
    extension: 'png',
    label: 'PNG',
    matches: (h) => startsWith(h, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    mime: 'image/jpeg',
    extension: 'jpg',
    label: 'JPEG',
    matches: (h) => startsWith(h, [0xff, 0xd8, 0xff]),
  },
  {
    mime: 'image/webp',
    extension: 'webp',
    label: 'WebP',
    // RIFF container with a WEBP form type at byte 8. Checking only
    // "RIFF" would also accept a .wav.
    matches: (h) => asciiAt(h, 0, 'RIFF') && asciiAt(h, 8, 'WEBP'),
  },
];

export function supportedLogoList(): string {
  return LOGO_TYPES.map((t) => t.label).join(', ');
}

/**
 * Identify by content, not by what the upload claimed.
 *
 * Same reasoning as detectFileType in rag/files.ts: filename and
 * content-type are both tenant-supplied, and the leading bytes are the
 * only part of an upload that has to be true for the file to render at
 * all.
 */
export function detectLogoType(head: Uint8Array): { ok: true; type: LogoType } | { ok: false; error: string } {
  const type = LOGO_TYPES.find((t) => t.matches(head));
  if (!type) {
    return {
      ok: false,
      error: `That file is not a supported image. Use ${supportedLogoList()} — SVG is not accepted.`,
    };
  }
  return { ok: true, type };
}

/**
 * Where a logo lives in the bucket.
 *
 * `logos/` prefix so it can never be confused with a knowledge source:
 * the org storage cap in 008_files.sql is enforced over the `documents`
 * table, and a logo is not a document. Its whole quota story is
 * MAX_LOGO_BYTES.
 *
 * The random segment is what makes the served URL safe to cache
 * forever — a replacement logo is a different key, so no cache anywhere
 * has to be told anything.
 */
export function logoKeyFor(orgId: string, botId: string, extension: string): string {
  return `logos/${orgId}/${botId}/${crypto.randomUUID()}.${extension}`;
}

/** The random segment, used as the URL's cache-busting token. */
export function logoVersion(key: string): string {
  return key.split('/').pop()?.split('.')[0] ?? '';
}

/**
 * The public URL for a bot's logo, or null when it has none.
 *
 * Built from the request's own origin so it works unchanged on
 * workers.dev, on a custom domain, and against `wrangler dev`. The R2
 * key is never exposed: it names an object in a bucket shared with
 * every tenant's documents.
 */
export function logoUrlFor(bot: Bot, origin: string): string | null {
  const key = widgetConfigFor(bot).logo_key;
  if (!key) return null;
  return `${origin}/v1/bots/${bot.id}/logo?v=${logoVersion(key)}`;
}
