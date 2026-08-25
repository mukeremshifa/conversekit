// ----------------------------------------------------------------
// Minimal SSE reader
//
// OpenAI-compatible, Anthropic and Google (with ?alt=sse) all stream
// as text/event-stream, so one parser serves all three. Handles
// chunk boundaries falling mid-line, CRLF, comments and multi-line
// data fields.
// ----------------------------------------------------------------

export interface SSEMessage {
  event?: string;
  data: string;
}

export async function* readSSE(res: Response): AsyncGenerator<SSEMessage> {
  if (!res.body) throw new Error('Response has no body to stream');

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let event: string | undefined;
  let data: string[] = [];

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, nl);
        buffer   = buffer.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);

        // Blank line dispatches the accumulated event.
        if (line === '') {
          if (data.length) yield { event, data: data.join('\n') };
          event = undefined;
          data  = [];
          continue;
        }

        if (line.startsWith(':')) continue; // comment / keep-alive

        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let val     = colon === -1 ? ''   : line.slice(colon + 1);
        if (val.startsWith(' ')) val = val.slice(1);

        if (field === 'event')     event = val;
        else if (field === 'data') data.push(val);
      }
    }

    // Some servers close without a trailing blank line.
    if (data.length) yield { event, data: data.join('\n') };
  } finally {
    reader.releaseLock();
  }
}
