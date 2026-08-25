import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Boxes, FileText, FileUp, HelpCircle, Link2, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { endpoints, uploadDocument, type Bot, type Chunk, type Doc } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Field, Input, Muted, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
  EmptyState, RowsSkeleton, Table, TableSkeleton, Td, Textarea, Th,
} from '@/components/ui';
import { Header } from '@/screens/Providers';

const STATUS = {
  pending:    { tone: 'wait' as const, label: 'queued' },
  processing: { tone: 'wait' as const, label: 'indexing…' },
  ready:      { tone: 'ok' as const,   label: 'ready' },
  failed:     { tone: 'bad' as const,  label: 'failed' },
};

/**
 * Whether this document was indexed by a different embedding model
 * than the one that would run today.
 *
 * The failure it makes visible is the quietest one in the pipeline:
 * two 768-dimension models from different vendors pass every check —
 * the width assertion, the pgvector column, Postgres itself — and store
 * vectors in different embedding spaces. Similarity between them is
 * noise, so the bot answers confidently and wrongly, forever, with no
 * error anywhere.
 *
 * Only `ready` documents are compared. A pending one has no model yet
 * and a failed one has nothing indexed to be stale, and flagging either
 * would be a second red badge saying the same thing as the first.
 */
function needsReindex(doc: Doc, current: string | null): boolean {
  return !!current && doc.status === 'ready' && !!doc.embedding_model
    && doc.embedding_model !== current;
}

/** Mirrors MAX_FILE_BYTES in src/rag/files.ts. Checked here too so a
 *  file that cannot possibly succeed fails instantly rather than after
 *  the browser has pushed ten megabytes up a slow connection. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPT = '.pdf,.docx';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function Sources({
  bot, embedded = false,
}: {
  bot: Bot;
  /** Rendered inside the Knowledge screen, which owns the page header. */
  embedded?: boolean;
}) {
  const [docs, setDocs] = useState<Doc[] | null>(null);
  /** The embedding model that would run TODAY, from the API. Null when
   *  the bot's embedding config cannot be resolved at all — a Providers
   *  problem, and not a reason to hide the source list. */
  const [embedding, setEmbedding] = useState<{ vendor: string; model: string } | null>(null);
  const [inspect, setInspect] = useState<{ doc: Doc; chunks: Chunk[] | null } | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const { documents, embedding: current } = await endpoints.documents(bot.id);
      setDocs(documents);
      setEmbedding(current ?? null);

      // Ingestion is asynchronous, so poll while anything is in flight
      // — and stop the moment nothing is, rather than polling forever.
      const busy = documents.some((d) => d.status === 'pending' || d.status === 'processing');
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      if (busy) timer.current = window.setTimeout(load, 3000);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load sources');
    }
  }, [bot.id]);

  useEffect(() => {
    setDocs(null);
    setInspect(null);
    void load();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [load]);

  const currentModel = embedding?.model ?? null;
  const stale = docs?.filter((d) => needsReindex(d, currentModel)) ?? [];

  async function showChunks(doc: Doc) {
    setInspect({ doc, chunks: null });
    try {
      const { chunks } = await endpoints.chunks(doc.id);
      setInspect({ doc, chunks });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load chunks');
      setInspect(null);
    }
  }

  async function remove(doc: Doc) {
    if (!confirm(`Delete “${doc.title}” and everything indexed from it?`)) return;
    try {
      await endpoints.deleteDoc(doc.id);
      toast.success('Source deleted');
      if (inspect?.doc.id === doc.id) setInspect(null);
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete');
    }
  }

  async function reindex(doc: Doc) {
    try {
      await endpoints.reindex(doc.id);
      toast.success('Reindexing…');
      void load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reindex');
    }
  }

  return (
    <>
      {!embedded && (
        <Header
          title="Knowledge Sources"
          subtitle="Documents the bot searches before answering. Text, markdown, or a web page."
        />
      )}

      <AddSource botId={bot.id} onAdded={load} />

      {stale.length > 0 && embedding && (
        <Card className="border-danger/40">
          <CardHeader>
            <div>
              <CardTitle>Re-index required</CardTitle>
              <CardDescription>
                This bot now embeds with <strong>{embedding.model}</strong> ({embedding.vendor}), but{' '}
                {stale.length === 1 ? 'one source was' : `${stale.length} sources were`} indexed with a
                different model. Searching across the two compares numbers that do not mean the same
                thing, so the bot is answering without them — from its own business details alone.
                Re-index each one below to bring it back.
              </CardDescription>
            </div>
            <Button
              size="sm"
              onClick={async () => {
                // Sequentially: each one starts an embedding job, and
                // firing them together only makes the progress display
                // a lie — the same reason uploads go one at a time.
                for (const d of stale) await reindex(d);
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" /> Re-index {stale.length === 1 ? 'it' : 'all'}
            </Button>
          </CardHeader>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Indexed sources</CardTitle>
            <CardDescription>
              {docs?.length
                ? `${docs.length} source${docs.length === 1 ? '' : 's'}, ${docs.reduce((n, d) => n + d.chunk_count, 0)} chunks`
                : 'Nothing indexed yet.'}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {docs === null ? (
            // The table's own headers and row height, rather than a
            // stack of tiles this screen has never rendered.
            <TableSkeleton
              columns={['Title', 'Type', 'Status', 'Chunks', 'Added', { label: '' }]}
              rows={3}
            />
          ) : docs.length === 0 ? (
            <EmptyState
              icon={Boxes}
              title="No knowledge sources"
              description="Sources are for longer material — a pricing page, a policy PDF, a handbook. They are chunked and searched automatically. For the questions visitors ask over and over, use the FAQ tab instead."
              action={{ label: 'Add a source', onClick: () => document.getElementById('ck-add-source')?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }}
            />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Title</Th><Th>Type</Th><Th>Status</Th><Th>Chunks</Th><Th>Added</Th><Th />
                </tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <Td className="font-medium">
                      {d.url
                        ? <a href={d.url} target="_blank" rel="noopener noreferrer" className="text-accent-ink hover:underline">{d.title}</a>
                        : d.title}
                    </Td>
                    <Td>
                      <span className="flex items-center gap-1.5 text-muted">
                        {d.source === 'url' ? <Link2 className="h-3.5 w-3.5" />
                          : d.source === 'file' ? <FileUp className="h-3.5 w-3.5" />
                          : d.source === 'faq' ? <HelpCircle className="h-3.5 w-3.5" />
                          : <FileText className="h-3.5 w-3.5" />}
                        {d.source === 'file'
                          ? `${d.mime_type === 'application/pdf' ? 'PDF' : 'Word'}${d.size_bytes ? ` · ${formatBytes(d.size_bytes)}` : ''}`
                          : d.source}
                      </span>
                    </Td>
                    <Td>
                      <Badge tone={STATUS[d.status].tone}>{STATUS[d.status].label}</Badge>
                      {/* A fifth badge beside the four statuses rather
                          than instead of them: the document IS ready —
                          it is indexed, it just cannot be searched by
                          the model this bot now uses. */}
                      {needsReindex(d, currentModel) && (
                        <>
                          {' '}
                          <Badge tone="bad">re-index required</Badge>
                          <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted">
                            Indexed with {d.embedding_model}, now searching with {currentModel}.
                          </p>
                        </>
                      )}
                      {d.status === 'failed' && d.error && (
                        <p className="mt-1 max-w-xs text-xs leading-relaxed text-danger">{d.error}</p>
                      )}
                    </Td>
                    <Td className="tabular-nums">{d.chunk_count}</Td>
                    <Td className="whitespace-nowrap text-muted">{formatDate(d.created_at)}</Td>
                    <Td>
                      <div className="flex gap-3">
                        <Button variant="link" onClick={() => showChunks(d)}>Chunks</Button>
                        <Button variant="link" onClick={() => reindex(d)}>Reindex</Button>
                        {/* The FAQ row is not a source someone added, it
                            is a view of the FAQ tab. Deleting it would
                            cascade away every item they wrote, from a
                            screen that gives no hint of that — so the
                            action here is a signpost instead. */}
                        {d.source === 'faq' ? (
                          <Button variant="link" onClick={() => { window.location.hash = 'knowledge'; }}>
                            Edit in FAQ
                          </Button>
                        ) : (
                          <Button variant="link" className="text-danger" onClick={() => remove(d)} aria-label={`Delete ${d.title}`}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>

      {inspect && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Chunks — {inspect.doc.title}</CardTitle>
              <CardDescription>
                Exactly what retrieval can see. When an answer is wrong, this is the first place to look.
                {inspect.doc.embedding_model && ` Embedded with ${inspect.doc.embedding_model} (${inspect.doc.embedding_dimensions}d).`}
              </CardDescription>
            </div>
            <Button variant="outline" size="sm" onClick={() => setInspect(null)}>Close</Button>
          </CardHeader>
          <CardContent>
            {inspect.chunks === null ? (
              // Chunks are numbered paragraphs on a divided list, not
              // a two-column table.
              <RowsSkeleton rows={4} lines={3} ordinal />
            ) : inspect.chunks.length === 0 ? (
              <Muted className="text-sm">No chunks — indexing may still be running, or it failed.</Muted>
            ) : (
              <div className="divide-y divide-border">
                {inspect.chunks.map((c) => (
                  <div key={c.id} className="flex gap-3 py-3">
                    <span className="w-8 shrink-0 pt-0.5 text-xs font-bold text-muted">#{c.ordinal}</span>
                    <div className="min-w-0 flex-1">
                      {(c.kind === 'faq' || (c.priority ?? 0) > 0) && (
                        <div className="mb-1 flex gap-2">
                          {c.kind === 'faq' && <Badge tone="ok">FAQ</Badge>}
                          {(c.priority ?? 0) > 0 && <Badge tone="wait">boosted</Badge>}
                        </div>
                      )}
                      <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{c.content}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}

function AddSource({ botId, onAdded }: { botId: string; onAdded: () => void }) {
  const [source, setSource] = useState<'file' | 'text' | 'markdown' | 'url'>('file');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);

  // Upload state is kept apart from document.status on purpose. They are
  // different failures with different fixes: an upload that stalls is a
  // connection problem, an index that fails is a problem with the file.
  const [staged, setStaged] = useState<File[]>([]);
  const [sending, setSending] = useState<{ name: string; fraction: number } | null>(null);

  function stage(incoming: FileList | null) {
    if (!incoming?.length) return;
    const accepted: File[] = [];
    for (const file of Array.from(incoming)) {
      if (file.size > MAX_FILE_BYTES) {
        toast.error(`${file.name} is ${formatBytes(file.size)} — the limit is ${formatBytes(MAX_FILE_BYTES)}.`);
        continue;
      }
      if (!/\.(pdf|docx)$/i.test(file.name)) {
        toast.error(`${file.name} is not a PDF or Word document.`);
        continue;
      }
      accepted.push(file);
    }
    setStaged((prev) => [...prev, ...accepted]);
  }

  async function submitFiles() {
    if (!staged.length) { toast.error('Choose a file first'); return; }

    setBusy(true);
    let failures = 0;
    try {
      // Sequential, not parallel: each upload is up to 10 MB and each
      // one kicks off an embedding job at the other end. Racing them
      // buys nothing and makes the progress display a lie.
      for (const file of staged) {
        setSending({ name: file.name, fraction: 0 });
        try {
          await uploadDocument(botId, file, {
            title: staged.length === 1 ? title : undefined,
            onProgress: (fraction) => setSending({ name: file.name, fraction }),
          });
        } catch (err) {
          failures++;
          toast.error(`${file.name}: ${err instanceof Error ? err.message : 'upload failed'}`);
        }
      }

      const sent = staged.length - failures;
      if (sent > 0) toast.success(sent === 1 ? 'Uploaded — indexing now' : `${sent} files uploaded — indexing now`);
      setStaged([]); setTitle('');
      onAdded();
    } finally {
      setSending(null);
      setBusy(false);
    }
  }

  async function submitTyped() {
    const body: Record<string, unknown> = { source, title: title.trim() };
    if (source === 'url') body.url = url.trim();
    else body.content = content.trim();

    if (source === 'url' ? !url.trim() : !content.trim()) {
      toast.error(source === 'url' ? 'A URL is required' : 'Content is required');
      return;
    }

    setBusy(true);
    try {
      await endpoints.addDocument(botId, body);
      setTitle(''); setUrl(''); setContent('');
      toast.success('Indexing started');
      onAdded();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add source');
    } finally {
      setBusy(false);
    }
  }

  return (
    /* id is the scroll target for the empty state's action. */
    <Card id="ck-add-source">
      <CardHeader>
        <div>
          <CardTitle>Add a source</CardTitle>
          <CardDescription>
            Upload a PDF or Word document, paste text, or link a web page.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-[180px_1fr]">
          <Field label="Type">
            <Select value={source} onValueChange={(v) => setSource(v as typeof source)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="file">PDF or Word</SelectItem>
                <SelectItem value="text">Pasted text</SelectItem>
                <SelectItem value="markdown">Markdown</SelectItem>
                <SelectItem value="url">Web page</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {(source !== 'file' || staged.length === 1) && (
            <Field label="Title" hint={source === 'file' ? 'optional — defaults to the filename' : 'optional for a URL'}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Pricing page" />
            </Field>
          )}
        </div>

        {source === 'file' ? (
          <DropZone
            staged={staged}
            sending={sending}
            disabled={busy}
            onFiles={stage}
            onRemove={(i) => setStaged((prev) => prev.filter((_, n) => n !== i))}
          />
        ) : source === 'url' ? (
          <Field label="URL" hint="HTML, text or markdown">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/pricing" />
          </Field>
        ) : (
          <Field label="Content">
            <Textarea
              rows={8}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Paste what you want the bot to know…"
            />
          </Field>
        )}

        <Button onClick={source === 'file' ? submitFiles : submitTyped} disabled={busy || (source === 'file' && !staged.length)}>
          {busy ? (source === 'file' ? 'Uploading…' : 'Adding…') : source === 'file' ? 'Upload and index' : 'Add and index'}
        </Button>
      </CardContent>
    </Card>
  );
}

function DropZone({
  staged, sending, disabled, onFiles, onRemove,
}: {
  staged: File[];
  sending: { name: string; fraction: number } | null;
  disabled: boolean;
  onFiles: (files: FileList | null) => void;
  onRemove: (index: number) => void;
}) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  return (
    <div className="mb-4">
      <div
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (!disabled) onFiles(e.dataTransfer.files); }}
        onClick={() => !disabled && input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') input.current?.click(); }}
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed px-6 py-8 text-center transition-colors ${
          over ? 'border-accent bg-accent/5' : 'border-border hover:border-muted'
        } ${disabled ? 'pointer-events-none opacity-60' : ''}`}
      >
        <Upload className="h-6 w-6 text-muted" />
        <p className="text-sm font-medium">Drop a PDF or Word document here, or click to choose</p>
        <Muted className="text-xs">
          .pdf and .docx, up to {formatBytes(MAX_FILE_BYTES)} each. Scanned pages have no text to read —
          those need to be run through OCR first.
        </Muted>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          className="hidden"
          onChange={(e) => { onFiles(e.target.files); e.target.value = ''; }}
        />
      </div>

      {staged.length > 0 && (
        <ul className="mt-3 space-y-2">
          {staged.map((file, i) => {
            const active = sending?.name === file.name;
            return (
              <li key={`${file.name}-${i}`} className="rounded-md border border-border px-3 py-2">
                <div className="flex items-center gap-2 text-sm">
                  <FileUp className="h-3.5 w-3.5 shrink-0 text-muted" />
                  <span className="truncate font-medium">{file.name}</span>
                  <span className="shrink-0 text-xs text-muted">{formatBytes(file.size)}</span>
                  {!disabled && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onRemove(i); }}
                      aria-label={`Remove ${file.name}`}
                      className="ml-auto text-muted hover:text-danger"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {active && (
                  <div className="mt-2">
                    <div className="h-1 w-full overflow-hidden rounded-full bg-border">
                      <div
                        className="h-full bg-accent transition-[width] duration-150"
                        style={{ width: `${Math.round(sending.fraction * 100)}%` }}
                      />
                    </div>
                    {/* Deliberately not called "indexing" — the file has
                        not reached the converter yet. */}
                    <p className="mt-1 text-xs text-muted">
                      {sending.fraction >= 1 ? 'Sent — waiting for the server…' : `Uploading ${Math.round(sending.fraction * 100)}%`}
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
