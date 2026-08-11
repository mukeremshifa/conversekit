/**
 * A real, minimal PDF built in memory.
 *
 * The file-ingestion tests need a PDF that genuinely converts, and
 * committing a binary fixture to the repo to get one is a poor trade:
 * it is unreviewable in a diff, and the interesting part — what text
 * the assertions expect to come back out — is invisible.
 *
 * This is a complete PDF 1.4 document with a correct cross-reference
 * table, not a stub with a %PDF- header. A parser that recovers from a
 * broken xref by scanning would hide exactly the failure these tests
 * exist to catch.
 */

/** Escape the three characters that end a PDF string literal early. */
function pdfString(s) {
  return s.replace(/[\\()]/g, (c) => `\\${c}`);
}

/**
 * @param {string[]} lines  One line of visible text per entry.
 * @param {object}   [opts]
 * @param {string}   [opts.title]  Document title, written into /Info.
 * @returns {Uint8Array}
 */
export function makePdf(lines, opts = {}) {
  const leading = 16;
  const text = lines
    .map((line, i) => (i === 0 ? `(${pdfString(line)}) Tj` : `T* (${pdfString(line)}) Tj`))
    .join('\n');

  const stream = `BT\n/F1 12 Tf\n${leading} TL\n72 720 Td\n${text}\nET`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Title (${pdfString(opts.title ?? 'ConverseKit test document')}) /Producer (ConverseKit tests) >>`,
  ];

  // Offsets are byte offsets into the finished file, so the body has to
  // be assembled before the xref table can be written.
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });

  const xrefAt = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;

  const trailer =
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\n` +
    `startxref\n${xrefAt}\n%%EOF\n`;

  return new TextEncoder().encode(body + xref + trailer);
}

/** A PDF whose bytes are valid but which carries no extractable text —
 *  the shape a scanned page or an XFA form presents. */
export function makeTextlessPdf() {
  return makePdf([], { title: 'Scanned' });
}
