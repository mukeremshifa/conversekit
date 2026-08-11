# Phase 2B spike — `env.AI.toMarkdown()`

Run 2026-08-11 against the live binding (`wrangler dev -c scripts/spike/wrangler.toml --remote`).
`worker.ts` is the throwaway Worker that produced these numbers; nothing in it ships.

## Verdict: it works. Phase 2B collapses to the short shape.

```
upload → R2 → env.AI.toMarkdown() → markdown → existing chunk/embed pipeline
```

No PDF parser in the bundle. No `unpdf`. **No Workflows** — see timings.

## Measurements

| File | Bytes | Conversion | Output | Tokens |
|---|---|---|---|---|
| arXiv 1706.03762 (15 pp, text) | 2,215,244 | **843 ms** | 39,845 chars | 9,961 |
| arXiv 2005.14165 (75 pp, text) | 6,768,044 | **908 ms** | 238,310 chars | 59,578 |
| calibre demo.docx | 1,311,881 | **246 ms** | 11,890 chars | 2,973 |
| IRS W-9 (6 pp, XFA form) | 140,815 | 160 ms | **0 content chars** | 283 |

Quality on the text PDFs is good: real prose, per-page `### Page N` headings, a
`## Metadata` preamble. Words occasionally join across line-wrap boundaries
(`You NeedAshish Vaswani`) — normal for PDF extraction and harmless once embedded.

`supported()` reports **28 formats** live, including `.pdf`, `.docx`, `.odt`,
`.pptx`, `.xlsx`, `.csv`, `.html` and the image types.

## Hard limits

- **50,000,000 bytes.** At 50 MB the binding throws
  `AiInternalError: Too big: expected string to have <=50000000 characters`.
  25 MB converts fine. Conversion time tracks *content*, not byte count —
  a PDF padded to 25 MB still converted in 1.16 s.
- Free for these formats. Only image conversion can bill Workers AI neurons,
  and images are not in our allow-list.

## Three findings that shape the code

1. **`toMarkdown` is not a validator.** A `.zip` and a `.txt` labelled as such
   were passed through as raw bytes and returned verbatim, `format: "markdown"`.
   Nothing rejects them. The upload route's MIME allow-list is therefore the
   *only* guard, and it must sniff magic bytes rather than trust the declared
   content type.
2. **A PDF can convert "successfully" and contain nothing.** The W-9 is an XFA
   form: 1,133 chars of output, every one of them metadata, zero content. Left
   alone the pipeline would index the PDF's `xmpmm:documentid` as knowledge and
   mark the document `ready`. Extraction must strip the metadata block and fail
   loudly on an empty remainder.
3. **Corrupt input fails cleanly.** Garbage labelled `application/pdf` returns
   `format: "error"`, `error: "Invalid PDF: Invalid PDF structure."` — a message
   good enough to store in `documents.error` as-is.

## Why not Workflows

Conversion is a ~1 s binding call, so the long pole is embedding, as the brief
predicted. Measured against the real `@cf/baai/bge-base-en-v1.5` binding, in the
batches of 32 that `src/rag/ingest.ts` already sends:

```
320 chunks (a 75-page PDF's worth) → 7,779 ms total
per batch: 1723, 520, 923, 1031, 515, 927, 609, 512, 511, 508 ms
```

End-to-end budget for the worst document the size ceiling allows:

| Step | Time |
|---|---|
| R2 get | ~100 ms |
| `toMarkdown` | ~900 ms |
| chunk (pure JS) | negligible |
| embed 320 chunks | ~7.8 s |
| insert 320 chunks (7 batched POSTs) | ~2 s |
| **total** | **~11 s** |

Eleven seconds of almost pure I/O wait fits `waitUntil` with room to spare.
Workflows would buy per-step retries and survival across eviction, but it is a
new binding with no local simulator, and `documents.status` + the reindex
endpoint already recover the failure that actually happens. Revisit only if the
size ceiling is raised far enough to push chunk counts past the existing
`MAX_CHUNKS = 400`.

## Consequences for the size ceiling

`MAX_CHUNKS = 400` at the default 800-char chunk size is ~320,000 chars of text.
The 75-page, 6.8 MB paper produced 238,310 — roughly 300 chunks. So the real
ceiling is the chunk budget, not `toMarkdown`'s 50 MB: a **10 MB** upload limit
lands just past the point where `MAX_CHUNKS` starts rejecting documents anyway,
and keeps ingestion inside the ~11 s budget above.
