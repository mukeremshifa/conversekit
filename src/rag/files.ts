// ----------------------------------------------------------------
// Uploaded file → text
//
// The whole of PDF and DOCX support is one binding call:
// `env.AI.toMarkdown()` converts the bytes and hands back markdown,
// which is a format the pipeline already understands. No PDF parser in
// the bundle, no `unpdf`, no fight with the runtime.
//
// Three things the spike proved, each of which is a guard below
// (scripts/spike/FINDINGS.md has the numbers):
//
//   1. toMarkdown does not validate. A .zip and a .txt labelled as such
//      came back verbatim as format "markdown", no error. The allow-list
//      here is the ONLY thing standing between a tenant and a corpus
//      full of binary noise — so it checks the leading bytes rather than
//      believing the upload's declared content type.
//
//   2. A PDF can convert successfully and contain nothing. An XFA form
//      returned 1,133 characters of which every one was metadata. Left
//      alone this pipeline would have embedded `xmpmm:documentid` as
//      knowledge and marked the document ready.
//
//   3. Corrupt input fails cleanly, with a message good enough to store
//      verbatim in documents.error.
// ----------------------------------------------------------------
import type { AiBinding, Document } from '../types';
import { ExtractError, markdownToText } from './extract';

/**
 * Per-file upload ceiling.
 *
 * Not the converter's limit — that is 50,000,000 bytes, and a 25 MB PDF
 * converts in about a second. This is the chunk budget: a 6.8 MB,
 * 75-page paper produced ~300 chunks against ingest.ts's MAX_CHUNKS of
 * 400. Anything much past 10 MB is rejected downstream anyway, and far
 * less legibly than it is here.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Total stored bytes one organization may hold.
 *
 * MIRRORS `v_cap` in supabase/008_files.sql, which is the authority: a
 * trigger enforces it there, because this copy races every concurrent
 * upload and is bypassed entirely by anything reaching PostgREST
 * directly. This one exists only so the common case gets a sentence
 * with real numbers in it instead of a constraint violation.
 */
export const ORG_STORAGE_CAP_BYTES = 100 * 1024 * 1024;

/**
 * Below this, a conversion is treated as having failed rather than as
 * having produced a very short document. See (2).
 *
 * Kept separate from the empty case because the two need different
 * sentences. "No readable text could be extracted" is true of a scan
 * and false of a file that yielded eleven characters — telling someone
 * their text could not be read when it plainly was sends them off to
 * re-export a file that was never the problem.
 */
const MIN_EXTRACTED_CHARS = 20;

/** Bytes to read for the signature check. A PDF header need only appear
 *  somewhere in the first kilobyte. */
export const SNIFF_BYTES = 1024;

export interface AllowedType {
  /** Canonical content type, and what gets handed to toMarkdown. */
  mime: string;
  extensions: string[];
  label: string;
  /** True when `head` carries this format's signature. */
  matches(head: Uint8Array): boolean;
}

function indexOfBytes(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const startsWith = (head: Uint8Array, sig: number[]) => sig.every((b, i) => head[i] === b);

/**
 * Deliberately short. Workers AI converts 28 formats, but every entry
 * here is a support surface and another way for odd bytes to reach the
 * corpus, so this grows on demand rather than in advance.
 */
export const ALLOWED_TYPES: AllowedType[] = [
  {
    mime: 'application/pdf',
    extensions: ['pdf'],
    label: 'PDF',
    // The spec allows bytes before the header, so search rather than
    // anchor — real-world PDFs do use that latitude.
    matches: (head) => indexOfBytes(head, [0x25, 0x50, 0x44, 0x46, 0x2d]) >= 0, // %PDF-
  },
  {
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['docx'],
    label: 'Word document',
    // DOCX is a zip. This does not prove it is a *Word* zip — that would
    // mean reading the central directory for [Content_Types].xml — but a
    // mislabelled archive fails inside toMarkdown with a clean error,
    // which is a good enough outcome for a bad enough input.
    matches: (head) => startsWith(head, [0x50, 0x4b, 0x03, 0x04]), // PK\x03\x04
  },
];

/** Content types a browser sends when it has no idea. Not a conflict. */
const VAGUE_TYPES = new Set([
  '', 'application/octet-stream', 'binary/octet-stream', 'application/binary',
]);

export function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
}

export function supportedList(): string {
  return ALLOWED_TYPES.map((t) => t.extensions.map((e) => `.${e}`).join('/')).join(', ');
}

export type Detection =
  | { ok: true; type: AllowedType }
  | { ok: false; error: string };

/**
 * Decide what a file actually is, from three signals that must agree:
 * the extension, the declared content type, and the leading bytes.
 *
 * Each one alone is forgeable. The extension is chosen by whoever named
 * the file, the content type by whoever posted it, and only the bytes
 * are chosen by the program that wrote the file — which is why
 * disagreement is rejected rather than resolved in favour of one of them.
 */
export function detectFileType(
  filename: string,
  declared: string | null | undefined,
  head: Uint8Array,
): Detection {
  const ext = extensionOf(filename);
  const byExt = ALLOWED_TYPES.find((t) => t.extensions.includes(ext));
  if (!byExt) {
    return {
      ok: false,
      error: ext
        ? `.${ext} files are not supported. Upload ${supportedList()}, or paste the text as a source instead.`
        : `That file has no extension, so its type cannot be established. Upload ${supportedList()}.`,
    };
  }

  const claimed = (declared ?? '').split(';')[0].trim().toLowerCase();
  if (!VAGUE_TYPES.has(claimed) && claimed !== byExt.mime) {
    return {
      ok: false,
      error: `That file is named .${ext} but was sent as '${claimed}'. Rename it to match its real format and try again.`,
    };
  }

  if (!byExt.matches(head)) {
    return {
      ok: false,
      error: `That file is named .${ext} but its contents are not a ${byExt.label}. It may be corrupt, or renamed from another format.`,
    };
  }

  return { ok: true, type: byExt };
}

/**
 * Keep the document, drop the paperwork.
 *
 * A converted PDF arrives as a `# name` title, a `## Metadata` block of
 * producer strings and XMP uuids, then `## Contents` with `### Page N`
 * markers. Only the contents are knowledge: the metadata block is pure
 * retrieval noise, and it is exactly what made the XFA form in (2) look
 * like a successful conversion.
 *
 * DOCX output has neither section, so input without them passes through
 * untouched apart from its title line.
 */
export function stripConversionNoise(markdown: string, filename?: string): string {
  let out = markdown;

  // Everything after the Contents heading, when the converter emitted one.
  const contents = /^##[ \t]+Contents[ \t]*$/m.exec(out);
  if (contents) {
    out = out.slice(contents.index + contents[0].length);
  } else {
    // No Contents section: drop a Metadata block if there is one, from
    // its heading up to the next heading of the same or higher level.
    out = out.replace(/^##[ \t]+Metadata[ \t]*$[\s\S]*?(?=^#{1,2}[ \t]|$(?![\s\S]))/m, '');
  }

  // The leading `# <filename>` the converter adds. It only repeats the
  // document title, which the row already carries.
  if (filename) {
    const stem = filename.replace(/\.[^.]+$/, '');
    out = out.replace(/^[ \t]*#[ \t]+(.*)$/m, (line, heading: string) =>
      heading.trim() === filename || heading.trim() === stem ? '' : line);
  }

  // Page markers carry no meaning once the text is chunked by size, and
  // they would otherwise land inside embeddings as the words "Page 12".
  out = out.replace(/^#{2,4}[ \t]+Page[ \t]+\d+[ \t]*$/gim, '');

  return out;
}

/**
 * Convert an uploaded file to indexable plain text.
 *
 * Throws ExtractError with a message written for the tenant: it lands in
 * `documents.error` and the dashboard renders it as-is.
 */
export async function fileToText(
  ai: AiBinding,
  filename: string,
  mime: string,
  bytes: ArrayBuffer,
): Promise<string> {
  if (bytes.byteLength === 0) throw new ExtractError('That file is empty.');

  let result;
  try {
    result = await ai.toMarkdown({ name: filename, blob: new Blob([bytes], { type: mime }) });
  } catch (err) {
    // Transport and size failures throw; conversion failures do not.
    const message = err instanceof Error ? err.message : String(err);
    throw new ExtractError(`Could not read that file: ${message}`);
  }

  if (result.format === 'error') {
    throw new ExtractError(`Could not read that file: ${result.error}`);
  }

  const text = markdownToText(stripConversionNoise(result.data, filename)).trim();

  if (text.length === 0) {
    throw new ExtractError(
      'No readable text could be extracted from that file. Scanned pages and ' +
      'fillable forms store their words as images or form fields rather than ' +
      'text — export it as a text-based file, or paste the content directly.',
    );
  }

  if (text.length < MIN_EXTRACTED_CHARS) {
    throw new ExtractError(
      `Only ${text.length} characters of text could be read from that file, ` +
      'which is too little to answer questions from. If it is a scan, it needs ' +
      'to go through OCR before it can be indexed.',
    );
  }

  return text;
}

/**
 * Read an uploaded document back out of the bucket and convert it.
 *
 * Re-extracted on every ingest rather than served from the cached
 * `content`, so a reindex picks up an improved converter — it is a ~1s
 * binding call on top of a bucket read, cheap enough not to optimise
 * away. The cache is the fallback for the one case that is otherwise
 * unrecoverable: the object is gone and there is nothing left to read.
 */
export async function storedFileToText(
  bucket: R2Bucket | undefined,
  ai: AiBinding | undefined,
  doc: Pick<Document, 'r2_key' | 'mime_type' | 'title' | 'content'>,
): Promise<string> {
  if (!doc.r2_key) throw new ExtractError('Document is a file source but has no stored object');

  const object = bucket ? await bucket.get(doc.r2_key) : null;

  if (!object) {
    const cached = doc.content?.trim();
    if (cached) return cached;
    throw new ExtractError(
      bucket
        ? 'The uploaded file is no longer in storage. Delete this source and upload it again.'
        : 'File storage is not configured on this deployment.',
    );
  }

  if (!ai) throw new ExtractError('File conversion is unavailable: the Workers AI binding is not configured.');

  const name = doc.title || doc.r2_key.split('/').pop() || 'upload';
  return fileToText(ai, name, doc.mime_type ?? 'application/octet-stream', await object.arrayBuffer());
}

/**
 * Where a file lives in the bucket.
 *
 * Prefixed by org and bot so a deleted bot's objects can be swept by
 * prefix, and so an accidental listing is already tenant-scoped. The
 * uuid, not the tenant's filename, is the identifying part: filenames
 * collide, and one that arrived with `../` in it must not be able to
 * name someone else's object.
 */
export function objectKeyFor(orgId: string, botId: string, extension: string): string {
  return `${orgId}/${botId}/${crypto.randomUUID()}.${extension}`;
}
