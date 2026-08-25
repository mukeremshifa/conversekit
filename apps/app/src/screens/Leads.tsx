import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Download, MessageSquareText, RefreshCw, Search, Target } from 'lucide-react';
import { endpoints, type Bot, type Lead, type Message } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Dialog, DialogContent, EmptyState, Input, Muted, Skeleton,
  Table, TableSkeleton, Td, Th, TranscriptSkeleton,
} from '@/components/ui';
import { Transcript, orderedForReading } from '@/components/Transcript';
import { Header } from '@/screens/Providers';

/**
 * The transcript behind one lead.
 *
 * `leads.session_id` has always matched `conversations.session_id` —
 * the linkage existed from the first migration and nothing ever queried
 * across it. Fetched on open rather than with the lead list, because
 * most leads are never opened and pulling every transcript up front
 * would be a hundred sessions of messages to render three of them.
 */
function LeadTranscript({ bot, lead, onClose }: { bot: Bot; lead: Lead; onClose: () => void }) {
  const [messages, setMessages] = useState<Message[] | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { conversations } = await endpoints.conversations(bot.id, lead.session_id);
        if (live) setMessages(conversations);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Could not load that conversation');
        if (live) setMessages([]);
      }
    })();
    // A drawer closed before the fetch lands must not set state on an
    // unmounted component, and must not overwrite the next lead's.
    return () => { live = false; };
  }, [bot.id, lead.session_id]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent
        className="max-w-2xl"
        title={`Conversation with ${lead.name}`}
        description={formatDate(lead.created_at)}
      >
        {messages === null ? (
          <TranscriptSkeleton bubbles={4} />
        ) : messages.length === 0 ? (
          <Muted>
            No messages found for this session. Transcripts are kept for the last 100 messages
            per bot, so an older conversation may have rolled off.
          </Muted>
        ) : (
          <Transcript messages={orderedForReading(messages)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

export function Leads({ bot }: { bot: Bot }) {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [q, setQ] = useState('');
  const [viewing, setViewing] = useState<Lead | null>(null);

  const load = useCallback(async () => {
    setLeads(null);
    try {
      setLeads((await endpoints.leads(bot.id)).leads);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load leads');
      setLeads([]);
    }
  }, [bot.id]);

  useEffect(() => { void load(); }, [load]);

  const filtered = (leads ?? []).filter((l) => {
    if (!q.trim()) return true;
    const hay = `${l.name} ${l.email} ${l.phone ?? ''} ${l.company ?? ''} ${l.inquiry ?? ''} ${l.tag ?? ''}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  // Columns only appear once something is actually using them, so a bot
  // that has not turned company on or set a label keeps the table it had
  // before 010 rather than growing two permanently empty columns.
  const hasCompany = filtered.some((l) => l.company);
  const hasTag = filtered.some((l) => l.tag);

  function exportCsv() {
    // The export is not conditional the way the table is: a spreadsheet
    // with an empty column costs nothing, and a header that changes
    // shape between exports breaks whatever the recipient built on it.
    const rows = [
      ['Date', 'Name', 'Email', 'Phone', 'Company', 'Inquiry', 'Label', 'Consent asked'],
      ...filtered.map((l) => [
        formatDate(l.created_at), l.name, l.email, l.phone ?? '',
        l.company ?? '', l.inquiry ?? '', l.tag ?? '',
        l.consent_given ? 'yes' : '',
      ]),
    ];
    // Quote every field and double internal quotes — a lead's inquiry
    // routinely contains commas and newlines.
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `leads-${bot.name.replace(/\W+/g, '-').toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <Header title="Leads" subtitle="Captured automatically when a visitor gives their details in chat." />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>
              {/* Not "0 captured" while it counts: a zero that turns
                  into thirty-one reads as a wrong answer, not a
                  pending one. */}
              {leads === null ? <Skeleton inline className="h-4 w-24" /> : `${leads.length} captured`}
            </CardTitle>
            <CardDescription>Newest first.</CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Input className="w-44" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
            <Button variant="outline" size="sm" onClick={load}><RefreshCw className="h-3.5 w-3.5" /> Refresh</Button>
            <Button variant="outline" size="sm" onClick={exportCsv} disabled={!filtered.length}>
              <Download className="h-3.5 w-3.5" /> CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {leads === null ? (
            // The real headers, in the real table: the company and
            // label columns are left out because they only appear once
            // a lead is using them, which is unknowable until the rows
            // land.
            <TableSkeleton
              columns={['Date', 'Name', 'Email', 'Phone', 'Inquiry', { label: '' }]}
              rows={5}
            />
          ) : filtered.length === 0 ? (
            leads.length === 0 ? (
              <EmptyState
                icon={Target}
                title="No leads yet"
                description="A lead appears the moment a visitor shares their name and email mid-conversation. Make sure the widget is live on your site."
                action={{ label: 'Get the install snippet', onClick: () => { window.location.hash = 'install'; } }}
              />
            ) : (
              <EmptyState icon={Search} title="No matches" description="No leads match that search." />
            )
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th><Th>Name</Th><Th>Email</Th><Th>Phone</Th>
                  {hasCompany && <Th>Company</Th>}
                  <Th>Inquiry</Th>
                  {hasTag && <Th>Label</Th>}
                  <Th><span className="sr-only">Conversation</span></Th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((l) => (
                  <tr key={l.id}>
                    <Td className="whitespace-nowrap text-muted">{formatDate(l.created_at)}</Td>
                    <Td className="font-medium">{l.name}</Td>
                    <Td><a className="text-accent-ink hover:underline" href={`mailto:${l.email}`}>{l.email}</a></Td>
                    <Td>{l.phone ?? '—'}</Td>
                    {hasCompany && <Td>{l.company ?? '—'}</Td>}
                    <Td className="max-w-sm">{l.inquiry ?? '—'}</Td>
                    {hasTag && <Td>{l.tag ? <Badge>{l.tag}</Badge> : '—'}</Td>}
                    <Td className="text-right">
                      <Button variant="outline" size="sm" onClick={() => setViewing(l)}>
                        <MessageSquareText className="h-3.5 w-3.5" /> Conversation
                      </Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Keyed on the lead so switching rows refetches rather than
          showing the previous transcript under the new name. */}
      {viewing && (
        <LeadTranscript key={viewing.id} bot={bot} lead={viewing} onClose={() => setViewing(null)} />
      )}
    </>
  );
}
