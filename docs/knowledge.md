# Knowledge sources (RAG)

How documents become answers: chunking, embedding, retrieval, and what happens when retrieval fails.

[← Back to the README](../README.md)

---

## Knowledge sources (RAG)

Beyond the free-text knowledge-base fields, a bot can be given **documents** —
an uploaded PDF or Word file, pasted text, markdown, or a fetched web page. Each
is chunked, embedded, and searched by cosine similarity at chat time; the top
matches are injected into the system prompt as clearly-labelled reference
material.

| Piece | Where |
|---|---|
| Schema, `match_chunks`, RLS | [supabase/005_rag.sql](../supabase/005_rag.sql) |
| File sources, storage cap | [supabase/008_files.sql](../supabase/008_files.sql) |
| Chunker, extractor, ingest, retrieve | [src/rag/](../src/rag/) |
| Upload, conversion, type sniffing | [src/rag/files.ts](../src/rag/files.ts) |
| Dashboard | Knowledge Sources tab, with a chunk inspector |

Per-bot settings live in `bots.rag_config`:

```json
{ "enabled": true, "top_k": 5, "min_similarity": 0.3,
  "chunk_size": 800, "chunk_overlap": 120 }
```

Three things worth knowing:

- **Embeddings are 768-dimensional, everywhere.** The pgvector column is fixed
  width, so this is a one-way door per deployment. 768 was chosen because every
  vendor in the catalog can produce it; 1536 would have excluded local models.
- **Retrieval never fails a turn.** No corpus, or an embedding vendor being
  down, degrades to the plain prompt rather than a 502.
- **Retrieved text is framed as data, not instructions.** Ingested pages are
  attacker-controlled in the general case, so the prompt explicitly tells the
  model to ignore any directives inside them.

**File uploads** go through `POST /v1/admin/bots/:id/documents/upload` as
multipart, are stored in the `DOCS` R2 bucket, and are converted by Workers AI's
`toMarkdown()` — so there is no PDF parser in the Worker bundle. `.pdf` and
`.docx`, 10 MB per file, 100 MB per organization. Two things that are easy to
get wrong and are guarded in [src/rag/files.ts](../src/rag/files.ts):

- **The converter validates nothing.** Handed a `.zip` it returns the bytes back
  as "markdown". The upload route is the only gate, so it checks the extension,
  the declared content type and the file's actual leading bytes, and rejects any
  disagreement between them.
- **A PDF can convert successfully and contain no text.** Scanned pages and
  fillable forms yield metadata only. Those are failed with an explanation
  rather than indexed, which would otherwise put XMP uuids in the corpus.

Requires R2 enabled on the account and the bucket created:
`wrangler r2 bucket create conversekit-documents`. Without the binding the
upload route answers `501` and every other source type keeps working.
Measurements behind these choices: [scripts/spike/FINDINGS.md](../scripts/spike/FINDINGS.md).

---

Three tests guard the platform:

```bash
npm run test:rag           # chunker, extractor and SSRF guard — pure, no network
```

```bash
npm run verify:rls         # local, no network — applies every migration to a
                           # throwaway Postgres and asserts the policies isolate
npm run verify:isolation    # end-to-end against a real Supabase project + Worker
```

Run `verify:rls` after touching any policy; it is the fast inner loop and needs
nothing but `psql`.

**`verify:rls` skips `005_rag.sql` and `008_files.sql` where pgvector is not
installed, and says so loudly.** A stock Postgres does not ship the extension.
Those two are covered by `verify:isolation`, which runs against the real project
where it exists. Never read a green `verify:rls` as having covered the RAG or
file schema — check the output for the skip.

---
