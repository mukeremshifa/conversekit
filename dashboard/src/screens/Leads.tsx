import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Download, RefreshCw, Search, Target } from 'lucide-react';
import { endpoints, type Bot, type Lead } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  EmptyState, Input, Table, TableSkeleton, Td, Th,
} from '@/components/ui';
import { Header } from '@/screens/Providers';

export function Leads({ bot }: { bot: Bot }) {
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [q, setQ] = useState('');

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
    const hay = `${l.name} ${l.email} ${l.phone ?? ''} ${l.inquiry ?? ''}`.toLowerCase();
    return hay.includes(q.toLowerCase());
  });

  function exportCsv() {
    const rows = [
      ['Date', 'Name', 'Email', 'Phone', 'Inquiry'],
      ...filtered.map((l) => [formatDate(l.created_at), l.name, l.email, l.phone ?? '', l.inquiry ?? '']),
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
            <CardTitle>{leads?.length ?? 0} captured</CardTitle>
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
            <TableSkeleton rows={5} cols={5} />
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
                <tr><Th>Date</Th><Th>Name</Th><Th>Email</Th><Th>Phone</Th><Th>Inquiry</Th></tr>
              </thead>
              <tbody>
                {filtered.map((l) => (
                  <tr key={l.id}>
                    <Td className="whitespace-nowrap text-muted">{formatDate(l.created_at)}</Td>
                    <Td className="font-medium">{l.name}</Td>
                    <Td><a className="text-accent-ink hover:underline" href={`mailto:${l.email}`}>{l.email}</a></Td>
                    <Td>{l.phone ?? '—'}</Td>
                    <Td className="max-w-sm">{l.inquiry ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  );
}
