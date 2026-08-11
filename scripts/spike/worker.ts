// Phase 2B spike. Answers one question: can env.AI.toMarkdown() turn a
// real PDF/DOCX into text inside a Worker, how big can the file be, and
// how long does it take? Nothing here ships.
//
// Files are fetched by the Worker rather than posted to it: `wrangler
// dev --remote` 503s on bodies over ~1 MB, and production will read
// from R2 anyway, so a fetch is both testable and representative.
interface SpikeEnv {
  AI: Ai;
}

const BASE_PDF = 'https://arxiv.org/pdf/1706.03762';

async function convert(env: SpikeEnv, name: string, type: string, bytes: ArrayBuffer, extra: Record<string, unknown> = {}) {
  const started = Date.now();
  try {
    const res = await env.AI.toMarkdown({ name, blob: new Blob([bytes], { type }) });
    const ms = Date.now() - started;
    if (res.format === 'error') {
      return Response.json({ ok: false, ms, bytes: bytes.byteLength, error: res.error, ...extra });
    }
    const body = res.data.split(/^## Contents\s*$/m)[1] ?? res.data;
    return Response.json({
      ok: true, ms, bytes: bytes.byteLength, mimeType: res.mimeType,
      tokens: res.tokens, chars: res.data.length,
      contentChars: body.replace(/^#+ .*$/gm, '').replace(/\s+/g, ' ').trim().length,
      sample: body.slice(0, 1200),
      raw: res.data,
      ...extra,
    });
  } catch (err) {
    return Response.json({
      ok: false, ms: Date.now() - started, bytes: bytes.byteLength,
      threw: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      ...extra,
    });
  }
}

export default {
  async fetch(req: Request, env: SpikeEnv): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/supported') {
      const formats = await env.AI.toMarkdown().supported();
      return Response.json({ count: formats.length, formats });
    }

    // Small files only — the dev proxy 503s past ~1 MB.
    if (url.pathname === '/convert' && req.method === 'POST') {
      return convert(env,
        req.headers.get('x-file-name') ?? 'file.bin',
        req.headers.get('x-file-type') ?? 'application/octet-stream',
        await req.arrayBuffer());
    }

    if (url.pathname === '/convert') {
      const target = url.searchParams.get('url');
      if (!target) return new Response('?url= required', { status: 400 });
      const src = await fetch(target, { headers: { 'User-Agent': 'ConverseKit-Spike/1.0' } });
      if (!src.ok) return Response.json({ ok: false, fetchStatus: src.status });
      return convert(env,
        url.searchParams.get('name') ?? 'file.pdf',
        url.searchParams.get('type') ?? src.headers.get('content-type')?.split(';')[0] ?? 'application/octet-stream',
        await src.arrayBuffer());
    }

    // Size ceiling probe. Pads a real PDF past %%EOF — parsers ignore
    // trailing bytes, so only the byte count changes.
    if (url.pathname === '/limit') {
      const mb = Number(url.searchParams.get('mb') ?? '10');
      const src = await fetch(BASE_PDF, { headers: { 'User-Agent': 'ConverseKit-Spike/1.0' } });
      const base = new Uint8Array(await src.arrayBuffer());
      const total = Math.round(mb * 1024 * 1024);
      if (total <= base.byteLength) return Response.json({ ok: false, note: `base pdf is already ${base.byteLength}` });
      const padded = new Uint8Array(total);
      padded.set(base, 0);
      padded.fill(0x20, base.byteLength);
      return convert(env, 'padded.pdf', 'application/pdf', padded.buffer, { targetMb: mb });
    }

    // Embedding throughput — the real long pole once toMarkdown proved to
    // be a ~1s binding call. N batches of 32 chunks, exactly the shape
    // src/rag/ingest.ts sends.
    if (url.pathname === '/embed') {
      const batches = Number(url.searchParams.get('batches') ?? '10');
      const text = 'The clinic offers preventative dental care and whitening. '.repeat(14).slice(0, 800);
      const batch = Array.from({ length: 32 }, (_, i) => `${i} ${text}`);
      const started = Date.now();
      const per: number[] = [];
      let dims = 0;
      for (let i = 0; i < batches; i++) {
        const t = Date.now();
        const r = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: batch }) as unknown as { data: number[][] };
        per.push(Date.now() - t);
        dims = r.data[0].length;
      }
      return Response.json({ batches, chunks: batches * 32, dims, totalMs: Date.now() - started, per });
    }

    return new Response('spike: /supported, /convert?url=…, POST /convert, /limit?mb=N, /embed?batches=N', { status: 404 });
  },
};
