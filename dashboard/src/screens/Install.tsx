import { useState } from 'react';
import { toast } from 'sonner';
import { Check, Copy } from 'lucide-react';
import { API, API_IS_DEFAULT, WIDGET_BASE } from '@/lib/config';
import type { Bot } from '@/lib/api';
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Muted,
} from '@/components/ui';
import { Header } from '@/screens/Providers';

export function Install({ bot }: { bot: Bot }) {
  const [copied, setCopied] = useState(false);

  // Must point at Pages, not the Worker — the Worker serves only the
  // API and has no /widget.js route.
  //
  // data-api-base is emitted ONLY when this dashboard is pointed
  // somewhere other than the host widget.js already defaults to. Putting
  // the default into every tenant's page would make the API's hostname
  // impossible to move without re-editing every tag ever pasted; left
  // out, it stays a constant inside a file we serve and can update.
  const apiAttr = API_IS_DEFAULT ? '' : `\n  data-api-base="${API}"`;
  const snippet =
    `<script\n  src="${WIDGET_BASE}/widget.js"\n  data-bot-id="${bot.id}"${apiAttr}\n  defer>\n</script>`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(snippet);
    } catch {
      // clipboard API needs a secure context; fall back for plain http.
      const ta = document.createElement('textarea');
      ta.value = snippet;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    toast.success('Copied to clipboard');
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <>
      <Header title="Install" subtitle="One tag, pasted once. No build step on the client's side." />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Embed snippet</CardTitle>
            <CardDescription>Paste this just before the closing &lt;/body&gt; tag.</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-lg border border-border bg-bg p-4 font-mono text-xs leading-relaxed">
            {snippet}
          </pre>
          <Muted className="text-xs">
            Hosting <code className="font-mono">widget.js</code> yourself? Add{' '}
            <code className="font-mono">data-api-base="{API}"</code> to the tag — your copy
            serves its own font, but every message still has to reach this API.
          </Muted>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Before it will answer</CardTitle>
            <CardDescription>Two things have to line up or the widget stays silent.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed">
            <li>
              <strong>The origin must match exactly.</strong> Currently allowed:{' '}
              {(bot.allowed_origins?.length ? bot.allowed_origins : bot.allowed_origin ? [bot.allowed_origin] : []).map((o) => (
                <code key={o} className="mr-1 rounded bg-bg px-1.5 py-0.5 font-mono text-xs">{o}</code>
              ))}
              . Requests from anywhere else are refused with a 403.
            </li>
            <li>
              <strong>Give it something to say.</strong> Fill in the Knowledge Base, or add
              Knowledge Sources for anything longer than a few paragraphs.
            </li>
          </ol>
          <Muted className="text-xs">
            Bot ID <code className="font-mono">{bot.id}</code>
          </Muted>
        </CardContent>
      </Card>
    </>
  );
}
