#!/usr/bin/env node
/**
 * Unit tests for the pure parts of the RAG pipeline — chunking, text
 * extraction, and the SSRF guard. No network, no database.
 *
 *   npm run test:rag
 */
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT  = mkdtempSync(join(tmpdir(), 'ck-rag-'));

await build({
  entryPoints: [join(ROOT, 'src/rag/chunk.ts'), join(ROOT, 'src/rag/extract.ts'), join(ROOT, 'src/rag/files.ts')],
  outdir: OUT, format: 'esm', bundle: true, platform: 'neutral',
});

const { chunkText, normalizeText } = await import(`file://${OUT}/chunk.js`);
const { htmlToText, markdownToText, isPrivateHost } = await import(`file://${OUT}/extract.js`);
const { detectFileType, stripConversionNoise, extensionOf, objectKeyFor, fileToText, storedFileToText } =
  await import(`file://${OUT}/files.js`);

let failures = 0;
const check = (label, cond, detail = '') => {
  if (cond) console.log(`  ok   ${label}`);
  else { failures++; console.log(`  FAIL ${label}${detail ? `\n       ${detail}` : ''}`); }
};

// ── Chunking ─────────────────────────────────────────────────────
console.log('\nChunking');
{
  const para = 'A'.repeat(300) + '\n\n' + 'B'.repeat(300) + '\n\n' + 'C'.repeat(300);
  const out = chunkText(para, { size: 400, overlap: 0 });
  check('splits on paragraph boundaries', out.length === 3, JSON.stringify(out.map((c) => c.length)));
  check('no chunk exceeds the size budget', out.every((c) => c.length <= 400), JSON.stringify(out.map((c) => c.length)));
}
{
  // Sizes must clear the 100-char floor chunkText enforces, or the
  // input fits in one chunk and the assertion proves nothing.
  const sentence = 'The clinic offers a full range of preventative dental care. ';
  const out = chunkText(sentence.repeat(8), { size: 150, overlap: 0 });
  check('splits a long body into several chunks', out.length >= 3, `got ${out.length}`);
  check('prefers sentence boundaries over hard cuts',
        out.slice(0, -1).every((c) => /[.!?]$/.test(c.trim())),
        JSON.stringify(out.slice(0, 2)));
}
{
  // No separators at all — must still terminate and respect the budget.
  const blob = 'x'.repeat(1000);
  const out = chunkText(blob, { size: 100, overlap: 0 });
  check('hard-cuts text with no boundaries', out.length === 10 && out.every((c) => c.length === 100));
}
{
  const body = 'Whitening costs 199 pounds. Cleaning costs 80 pounds. Implants start at 1200 pounds. Braces vary by case. ';
  const plain    = chunkText(body.repeat(4), { size: 150, overlap: 0 });
  const overlapd = chunkText(body.repeat(4), { size: 150, overlap: 40 });

  check('overlap produces the same number of chunks', plain.length === overlapd.length,
        `${plain.length} vs ${overlapd.length}`);
  check('every chunk after the first repeats prior text',
        overlapd.length > 1 && overlapd.slice(1).every((c, i) => {
          const head = c.slice(0, 20);
          return plain[i].includes(head.trim().split(' ')[0]);
        }),
        JSON.stringify(overlapd.slice(0, 2)));
  check('overlapped chunks are longer than plain ones',
        overlapd[1].length > plain[1].length);
}
check('empty input yields no chunks', chunkText('   \n\n  ').length === 0);
check('short input is a single chunk', chunkText('Just a line.').length === 1);
check('overlap cannot exceed half the size',
      chunkText('sentence. '.repeat(60), { size: 200, overlap: 999 }).every((c) => c.length <= 320));
check('normalizeText collapses runaway blank lines',
      normalizeText('a\n\n\n\n\nb') === 'a\n\nb', JSON.stringify(normalizeText('a\n\n\n\n\nb')));

// ── HTML extraction ──────────────────────────────────────────────
console.log('\nHTML extraction');
{
  const html = `<html><head><title>Pearl Dental</title>
    <style>.x{color:red}</style><script>var a=1;</script></head>
    <body><nav>Home About</nav><h1>Teeth Whitening</h1>
    <p>We offer Zoom whitening for &pound;199 &amp; take-home kits.</p>
    <footer>© 2026</footer></body></html>`;
  const text = htmlToText(html);
  check('keeps the page title',        text.includes('Pearl Dental'));
  check('keeps body copy',             text.includes('Zoom whitening'));
  check('drops <script> contents',     !text.includes('var a=1'));
  check('drops <style> contents',      !text.includes('color:red'));
  check('drops nav and footer chrome', !text.includes('Home About') && !text.includes('© 2026'));
  check('decodes entities',            text.includes('&') && !text.includes('&amp;'), text.slice(0, 120));
  check('leaves no raw tags',          !/<[a-z]/i.test(text), text.slice(0, 120));
}

// ── Markdown extraction ──────────────────────────────────────────
console.log('\nMarkdown extraction');
{
  const md = '# Pricing\n\nSee [our page](https://x.com) for `details`.\n\n```\ncode block\n```\n\n- Cleaning\n- Whitening\n\n**Bold** and _italic_.';
  const text = markdownToText(md);
  // KEEPS them, as of M6. This assertion used to read the other way,
  // and reversing it is the change: chunkText reads the markers to
  // build the breadcrumb it prefixes onto each prose chunk, and it
  // consumes them there — so nothing markdown-shaped reaches an
  // embedding, but stripping them here would leave a heading as a bare
  // line the chunker cannot tell from a sentence. See M6 in
  // docs/rag-hardening.md.
  check('KEEPS heading markers, at their own level',
        /^# Pricing$/m.test(text), text.slice(0, 120));
  check('keeps link text only',    text.includes('our page') && !text.includes('https://x.com'));
  check('drops fenced code',       !text.includes('code block'));
  check('keeps list items',        text.includes('Cleaning') && text.includes('Whitening'));
  check('strips emphasis markers', !text.includes('**') && text.includes('Bold'));
}

// ── SSRF guard ───────────────────────────────────────────────────
console.log('\nSSRF guard');
for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '172.16.0.1', '172.31.255.255',
                    '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', 'db.internal']) {
  check(`blocks ${host}`, isPrivateHost(host) === true);
}
for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1', 'conversekit.io']) {
  check(`allows ${host}`, isPrivateHost(host) === false);
}

// ── File type detection (Phase 2B) ───────────────────────────────
//
// This is the only guard between an upload and the corpus. The spike
// established that env.AI.toMarkdown() validates nothing — it handed
// back a .zip and a .txt verbatim as "markdown" — so a gap here puts
// binary noise into a tenant's embeddings.
console.log('\nFile type detection');
const bytes = (...nums) => new Uint8Array(nums);
const PDF_MAGIC  = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37); // %PDF-1.7
const ZIP_MAGIC  = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
const JUNK       = bytes(0xde, 0xad, 0xbe, 0xef);
const PDF_MIME   = 'application/pdf';
const DOCX_MIME  = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

{
  const ok = detectFileType('handbook.pdf', PDF_MIME, PDF_MAGIC);
  check('accepts a real PDF', ok.ok === true && ok.type.mime === PDF_MIME, JSON.stringify(ok));

  const upper = detectFileType('HANDBOOK.PDF', PDF_MIME, PDF_MAGIC);
  check('extension match is case-insensitive', upper.ok === true, JSON.stringify(upper));

  // The spec allows bytes before the header and real PDFs use that.
  const offset = new Uint8Array(300);
  offset.set(PDF_MAGIC, 200);
  check('accepts a PDF whose header is not at byte 0',
        detectFileType('late.pdf', PDF_MIME, offset).ok === true);

  check('accepts a real DOCX',
        detectFileType('notes.docx', DOCX_MIME, ZIP_MAGIC).ok === true);

  // Browsers regularly send octet-stream for a docx. That is ignorance,
  // not a contradiction, so it must not be a rejection.
  check('accepts a vague content type',
        detectFileType('notes.docx', 'application/octet-stream', ZIP_MAGIC).ok === true);
  check('accepts an absent content type',
        detectFileType('notes.docx', null, ZIP_MAGIC).ok === true);
}
{
  const renamed = detectFileType('payload.pdf', PDF_MIME, ZIP_MAGIC);
  check('rejects a zip renamed to .pdf', renamed.ok === false, JSON.stringify(renamed));
  check('  and says the contents are wrong, not the name',
        renamed.ok === false && /contents are not a PDF/.test(renamed.error), renamed.error);

  const garbage = detectFileType('broken.pdf', PDF_MIME, JUNK);
  check('rejects bytes that are no known format', garbage.ok === false);

  const conflict = detectFileType('report.pdf', 'text/html', PDF_MAGIC);
  check('rejects a content type that contradicts the extension', conflict.ok === false, JSON.stringify(conflict));

  const txt = detectFileType('notes.txt', 'text/plain', bytes(0x68, 0x69));
  check('rejects .txt — toMarkdown would pass it through as raw bytes', txt.ok === false);
  check('  and points at the source types that do handle text',
        txt.ok === false && /paste the text/.test(txt.error), txt.error);

  const zip = detectFileType('archive.zip', 'application/zip', ZIP_MAGIC);
  check('rejects .zip even though its magic bytes match docx', zip.ok === false, JSON.stringify(zip));

  const bare = detectFileType('README', '', PDF_MAGIC);
  check('rejects a file with no extension', bare.ok === false, JSON.stringify(bare));

  const dotfile = detectFileType('.pdf', PDF_MIME, PDF_MAGIC);
  check('a leading dot is not an extension', dotfile.ok === false, JSON.stringify(dotfile));
}
{
  check('extensionOf reads the last segment', extensionOf('a/b/c.report.PDF') === 'pdf');
  check('extensionOf handles windows separators', extensionOf('C:\\docs\\x.docx') === 'docx');
  check('extensionOf returns empty for no extension', extensionOf('LICENSE') === '');
}
{
  // A hostile filename must not be able to name someone else's object.
  const key = objectKeyFor('org-1', 'bot-1', 'pdf');
  check('object keys are prefixed by org and bot', key.startsWith('org-1/bot-1/'), key);
  check('object keys end in the detected extension', key.endsWith('.pdf'), key);
  check('object keys are unique per call', objectKeyFor('o', 'b', 'pdf') !== objectKeyFor('o', 'b', 'pdf'));
}

// ── Conversion noise ─────────────────────────────────────────────
//
// A converted PDF leads with a metadata block of XMP uuids and producer
// strings. Indexing that is worse than useless: it is what made an XFA
// form look like a successful conversion during the spike.
console.log('\nConversion noise');
const PDF_SHAPED = [
  '# handbook.pdf',
  '## Metadata',
  '- PDFFormatVersion=1.7',
  '- xmpmm:documentid=uuid:5cf55a22-524b-4232-b307-21df48802595',
  '- dc:creator=SE:W:CAR:MP',
  '',
  '## Contents',
  '### Page 1',
  'Whitening costs 199 pounds at the Elm Street clinic.',
  '### Page 2',
  'Cleaning costs 80 pounds.',
].join('\n');
{
  const out = stripConversionNoise(PDF_SHAPED, 'handbook.pdf');
  check('drops the metadata block', !out.includes('xmpmm:documentid') && !out.includes('PDFFormatVersion'), out);
  check('drops the Metadata heading', !/##\s+Metadata/.test(out), out);
  check('drops the page markers', !/Page\s+1/.test(out), out);
  check('keeps the actual content', out.includes('Whitening costs 199 pounds') && out.includes('Cleaning costs 80'), out);
  check('drops the filename title line', !out.includes('handbook.pdf'), out);
}
{
  // DOCX output has no Metadata or Contents section at all.
  const docx = '# notes.docx\n\nThe clinic opens at 9am on weekdays.\n\n## Pricing\n\nWhitening is 199 pounds.';
  const out  = stripConversionNoise(docx, 'notes.docx');
  check('leaves DOCX-shaped output intact', out.includes('opens at 9am') && out.includes('Whitening is 199'), out);
  check('keeps real headings', out.includes('## Pricing'), out);
  check('still drops the filename title', !out.includes('notes.docx'), out);
}
{
  // A Metadata block with no Contents section must not eat the document.
  const noContents = '# x.pdf\n## Metadata\n- Producer=Acme\n\n## Introduction\nThe real text starts here.';
  const out = stripConversionNoise(noContents, 'x.pdf');
  check('drops a metadata block that has no Contents heading', !out.includes('Producer=Acme'), out);
  check('  without eating the section after it', out.includes('The real text starts here'), out);
}
{
  const prose = 'See Page 3 of the handbook for details.';
  check('leaves an inline page reference alone', stripConversionNoise(prose).includes('Page 3'));
}

// ── File conversion (Phase 2B) ───────────────────────────────────
//
// A fake binding, so the three outcomes the spike found are pinned
// without touching the network.
console.log('\nFile conversion');
const fakeAi = (result) => ({
  run: async () => ({}),
  toMarkdown: async () => (result instanceof Error ? Promise.reject(result) : result),
});
const rejects = async (label, promise, pattern) => {
  try {
    await promise;
    check(label, false, 'resolved instead of throwing');
  } catch (err) {
    check(label, pattern.test(err.message), err.message);
  }
};

{
  const good = fakeAi({ format: 'markdown', name: 'a.pdf', mimeType: PDF_MIME, tokens: 9, data: PDF_SHAPED });
  const text = await fileToText(good, 'handbook.pdf', PDF_MIME, new ArrayBuffer(8));
  check('converts a good file to plain text', text.includes('Whitening costs 199 pounds'), text);
  check('  with the metadata already gone', !text.includes('xmpmm'), text);
}

// The XFA finding: a conversion that succeeds and contains nothing but
// metadata must fail loudly, not index uuids as knowledge.
await rejects('an all-metadata conversion fails rather than indexing metadata',
  fileToText(
    fakeAi({ format: 'markdown', name: 'w9.pdf', mimeType: PDF_MIME, tokens: 283,
             data: '# w9.pdf\n## Metadata\n- Producer=Designer 6.5\n\n## Contents\n### Page 1\n\n### Page 2\n' }),
    'w9.pdf', PDF_MIME, new ArrayBuffer(8)),
  /No readable text/);

// A file that yields a handful of characters is still broken, but it is
// not the scanned-page case and must not claim to be: text plainly was
// read. An earlier version conflated the two and told people to
// re-export a file whose text had been extracted correctly.
await rejects('a nearly-empty conversion is refused without claiming nothing was read',
  fileToText(
    fakeAi({ format: 'markdown', name: 't.pdf', mimeType: PDF_MIME, tokens: 3,
             data: '# t.pdf\n\n## Contents\n### Page 1\nprobe\n' }),
    't.pdf', PDF_MIME, new ArrayBuffer(8)),
  /Only 5 characters of text/);

await rejects('a conversion error surfaces the converter\'s own message',
  fileToText(
    fakeAi({ format: 'error', name: 'x.pdf', mimeType: PDF_MIME, error: 'Invalid PDF: Invalid PDF structure.' }),
    'x.pdf', PDF_MIME, new ArrayBuffer(8)),
  /Invalid PDF structure/);

await rejects('a thrown binding failure is reported, not swallowed',
  fileToText(fakeAi(new Error('Too big: expected string to have <=50000000 characters')),
             'huge.pdf', PDF_MIME, new ArrayBuffer(8)),
  /Too big/);

await rejects('an empty file is rejected before the binding is called',
  fileToText(fakeAi({ format: 'markdown', name: 'e.pdf', mimeType: PDF_MIME, tokens: 0, data: '' }),
             'empty.pdf', PDF_MIME, new ArrayBuffer(0)),
  /empty/);

// ── Reading a stored file back out of R2 ─────────────────────────
console.log('\nStored file retrieval');
const okAi = fakeAi({ format: 'markdown', name: 'a.pdf', mimeType: PDF_MIME, tokens: 9, data: PDF_SHAPED });
const bucketWith = (key, bytes) => ({
  get: async (k) => (k === key ? { arrayBuffer: async () => bytes } : null),
});
const fileDoc = (over = {}) => ({
  r2_key: 'org/bot/abc.pdf', mime_type: PDF_MIME, title: 'Handbook', content: null, ...over,
});

{
  const bucket = bucketWith('org/bot/abc.pdf', new ArrayBuffer(64));
  const text = await storedFileToText(bucket, okAi, fileDoc());
  check('reads the object and converts it', text.includes('Whitening costs 199 pounds'), text);
}
{
  // The object is gone but the extracted text was cached on the row.
  // That is the difference between a recoverable reindex and a dead
  // source, so it is worth the branch.
  const empty = { get: async () => null };
  const text = await storedFileToText(empty, okAi, fileDoc({ content: 'Cached extraction from last time.' }));
  check('falls back to the cached text when the object is gone',
        text === 'Cached extraction from last time.', text);
}
await rejects('a missing object with no cache fails with a recovery instruction',
  storedFileToText({ get: async () => null }, okAi, fileDoc()), /no longer in storage/);

await rejects('a file document with no key fails clearly',
  storedFileToText({ get: async () => null }, okAi, fileDoc({ r2_key: null })), /no stored object/);

await rejects('an unbound bucket is reported as configuration, not corruption',
  storedFileToText(undefined, okAi, fileDoc()), /storage is not configured/);

await rejects('an unbound AI binding is reported as configuration',
  storedFileToText(bucketWith('org/bot/abc.pdf', new ArrayBuffer(64)), undefined, fileDoc()),
  /Workers AI binding is not configured/);

rmSync(OUT, { recursive: true, force: true });
console.log(failures === 0 ? `\nAll RAG unit tests passed.\n` : `\n${failures} failure(s).\n`);
process.exit(failures === 0 ? 0 : 1);
