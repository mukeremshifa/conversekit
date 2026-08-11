import { useState, type ReactNode } from 'react';
import { LogOut, Plus, Zap, Menu } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { endpoints, type Bot, type Org } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  Button, Dialog, DialogContent, DialogTrigger, Field, Input,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui';

export interface NavItem { id: string; label: string; icon: LucideIcon }

interface Props {
  nav: NavItem[];
  route: string;
  onNavigate: (route: string) => void;
  bots: Bot[];
  botId: string;
  onSelectBot: (id: string) => void;
  email: string | null;
  orgs: Org[];
  onBotCreated: (bot: Bot) => void;
  onSignOut: () => void;
  children: ReactNode;
}

export function Shell({
  nav, route, onNavigate, bots, botId, onSelectBot,
  email, orgs, onBotCreated, onSignOut, children,
}: Props) {
  const [open, setOpen] = useState(false); // mobile drawer

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-5 py-4">
        <Zap className="h-5 w-5 text-accent" />
        <span className="font-bold tracking-tight">ConverseKit</span>
      </div>

      <div className="space-y-2 border-b border-border px-4 py-4">
        <label className="text-xs font-semibold uppercase tracking-wide text-muted">Bot</label>
        <Select value={botId} onValueChange={(v) => { onSelectBot(v); setOpen(false); }}>
          <SelectTrigger aria-label="Select bot">
            <SelectValue placeholder="No bots" />
          </SelectTrigger>
          <SelectContent>
            {bots.map((b) => (
              <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <NewBotDialog orgs={orgs} onCreated={onBotCreated} />
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-3">
        {nav.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => { onNavigate(id); setOpen(false); }}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors cursor-pointer',
              route === id ? 'bg-accent text-accent-fg font-medium' : 'text-muted hover:bg-bg hover:text-fg',
            )}
            aria-current={route === id ? 'page' : undefined}
          >
            <Icon className="h-4 w-4 shrink-0" />
            {label}
          </button>
        ))}
      </nav>

      <div className="border-t border-border p-3">
        <p className="truncate px-2 pb-2 text-xs text-muted" title={email ?? ''}>{email}</p>
        <Button variant="ghost" className="w-full justify-start text-muted" onClick={onSignOut}>
          <LogOut className="h-4 w-4" /> Sign out
        </Button>
      </div>
    </div>
  );

  return (
    <div className="flex h-full">
      {/* Desktop rail */}
      <aside className="hidden w-60 shrink-0 border-r border-border bg-surface md:block">{sidebar}</aside>

      {/* Mobile drawer — the vanilla dashboard had no responsive story
          at all, which made it unusable on the phone people actually
          check leads from. */}
      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/50 md:hidden" onClick={() => setOpen(false)} />
          <aside className="fixed inset-y-0 left-0 z-50 w-64 border-r border-border bg-surface md:hidden">
            {sidebar}
          </aside>
        </>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3 md:hidden">
          <Button variant="ghost" size="icon" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu className="h-5 w-5" />
          </Button>
          <span className="font-semibold">{bots.find((b) => b.id === botId)?.name ?? 'ConverseKit'}</span>
        </header>

        <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-8">
          <div className="mx-auto w-full max-w-4xl space-y-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

function NewBotDialog({ orgs, onCreated }: { orgs: Org[]; onCreated: (b: Bot) => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', business_name: '', allowed_origin: '', org_id: '' });

  const orgId = form.org_id || orgs[0]?.id || '';

  async function submit() {
    if (!form.name || !form.business_name || !form.allowed_origin) {
      toast.error('All fields are required');
      return;
    }
    setBusy(true);
    try {
      const { allowed_origin, ...rest } = form;
      const bot = await endpoints.createBot({
        ...rest,
        org_id: orgId,
        // A list from the start: apex + www is the common case, and the
        // API normalises and validates each entry.
        allowed_origins: allowed_origin.split(/[\s,]+/).map((o) => o.trim()).filter(Boolean),
      });
      onCreated(bot);
      setOpen(false);
      setForm({ name: '', business_name: '', allowed_origin: '', org_id: '' });
      toast.success('Bot created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create bot');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="w-full justify-start text-accent">
          <Plus className="h-4 w-4" /> New bot
        </Button>
      </DialogTrigger>
      <DialogContent title="Create a bot" description="You can change any of this later.">
        <Field label="Bot name">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Front Desk" />
        </Field>
        <Field label="Business name">
          <Input value={form.business_name} onChange={(e) => setForm({ ...form, business_name: e.target.value })} placeholder="Acme Dental" />
        </Field>
        <Field label="Allowed origins" hint="comma or space separated — add www and apex if both are used">
          <Input
            value={form.allowed_origin}
            onChange={(e) => setForm({ ...form, allowed_origin: e.target.value })}
            placeholder="https://acme.com https://www.acme.com"
          />
        </Field>
        {orgs.length > 1 && (
          <Field label="Organization">
            <Select value={orgId} onValueChange={(v) => setForm({ ...form, org_id: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {orgs.map((o) => <SelectItem key={o.id} value={o.id}>{o.name ?? o.slug}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={busy}>{busy ? 'Creating…' : 'Create'}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
