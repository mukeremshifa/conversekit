import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { endpoints, type Bot } from '@/lib/api';
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, Textarea,
} from '@/components/ui';
import { Header } from '@/screens/Providers';

type Form = {
  name: string; business_name: string;
  /** Newline-separated in the form, an array over the wire. */
  allowed_origins: string;
  suggestions: string;
  contact_phone: string; contact_email: string; address: string;
  hours: string; primary_color: string;
};

const NL = '\n';

const from = (b: Bot): Form => ({
  name: b.name ?? '',
  business_name: b.business_name ?? '',
  // Falls back to the legacy single-origin column for rows predating 006.
  allowed_origins: (b.allowed_origins?.length
    ? b.allowed_origins
    : b.allowed_origin ? [b.allowed_origin] : []).join(NL),
  suggestions: (b.suggestions ?? []).join(NL),
  // The pre-tenancy columns are still populated on older rows.
  contact_phone: b.contact_phone ?? b.contact ?? '',
  contact_email: b.contact_email ?? '',
  address: b.address ?? b.location ?? '',
  hours: b.hours ?? '',
  primary_color: b.primary_color ?? '#2563eb',
});

const lines = (value: string) => value.split(NL).map((v) => v.trim()).filter(Boolean);

export function BotSettings({ bot, onSaved }: { bot: Bot; onSaved: (b: Bot) => void }) {
  const [form, setForm] = useState<Form>(() => from(bot));
  const [busy, setBusy] = useState(false);

  useEffect(() => setForm(from(bot)), [bot]);

  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });

  async function save() {
    setBusy(true);
    try {
      const { allowed_origins, suggestions, ...rest } = form;
      const updated = await endpoints.updateBot(bot.id, {
        ...rest,
        // The API normalises and validates each origin; a trailing slash
        // or a path is rejected there rather than silently 403-ing later.
        allowed_origins: lines(allowed_origins),
        // Empty means "use the widget's neutral defaults".
        suggestions: lines(suggestions),
      });
      onSaved(updated);
      toast.success('Settings saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header
        title="Bot Settings"
        action={<Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>}
      />

      <Card>
        <CardHeader><div><CardTitle>Identity</CardTitle></div></CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Bot name" hint="shown in the widget header">
              <Input value={form.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Business name">
              <Input value={form.business_name} onChange={(e) => set({ business_name: e.target.value })} />
            </Field>
          </div>
          <Field label="Allowed origins" hint="one per line — requests from anywhere else are refused">
            <Textarea
              rows={3}
              className="font-mono text-xs"
              value={form.allowed_origins}
              onChange={(e) => set({ allowed_origins: e.target.value })}
              placeholder={`https://acme.com${NL}https://www.acme.com`}
            />
          </Field>
          <p className="text-xs leading-relaxed text-muted">
            A browser treats <code>acme.com</code> and <code>www.acme.com</code> as different
            origins, so add both if the site answers on both. No trailing slash, no path.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Appearance</CardTitle>
            <CardDescription>The widget bubble, header and visitor messages use this colour.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-3">
            <Field label="Primary colour">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  className="h-9 w-14 cursor-pointer rounded-lg border border-border bg-surface p-1"
                  value={form.primary_color}
                  onChange={(e) => set({ primary_color: e.target.value })}
                  aria-label="Primary colour"
                />
                <Input
                  className="w-28 font-mono"
                  value={form.primary_color}
                  onChange={(e) => set({ primary_color: e.target.value })}
                  maxLength={7}
                />
              </div>
            </Field>
            <div
              className="mb-0.5 flex h-11 w-11 items-center justify-center rounded-full text-white shadow"
              style={{ background: /^#[0-9a-f]{6}$/i.test(form.primary_color) ? form.primary_color : '#2563eb' }}
              aria-hidden
            >
              ✦
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Starter suggestions</CardTitle>
            <CardDescription>
              The chips a visitor sees before they type anything. Leave empty for neutral
              defaults — these used to be hardcoded, so every bot on the platform asked
              its visitors about dental insurance.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <Field label="Suggestions" hint="one per line, up to 6, 80 characters each">
            <Textarea
              rows={4}
              value={form.suggestions}
              onChange={(e) => set({ suggestions: e.target.value })}
              placeholder={`Do you take walk-ins?${NL}Where are you located?${NL}How much is a consultation?`}
            />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Contact</CardTitle>
            <CardDescription>Offered to visitors when the bot cannot answer, and shown if the widget errors.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Phone"><Input value={form.contact_phone} onChange={(e) => set({ contact_phone: e.target.value })} /></Field>
            <Field label="Email"><Input type="email" value={form.contact_email} onChange={(e) => set({ contact_email: e.target.value })} /></Field>
          </div>
          <Field label="Address"><Input value={form.address} onChange={(e) => set({ address: e.target.value })} /></Field>
          <Field label="Opening hours"><Input value={form.hours} onChange={(e) => set({ hours: e.target.value })} placeholder="Mon–Fri 8am–6pm" /></Field>
        </CardContent>
      </Card>
    </>
  );
}
