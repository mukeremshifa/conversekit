import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { endpoints, type Bot } from '@/lib/api';
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Textarea,
} from '@/components/ui';
import { Header } from '@/screens/Providers';

type Form = {
  business_description: string; services: string; faq: string; custom_instructions: string;
};

const from = (b: Bot): Form => ({
  business_description: b.business_description ?? '',
  services: b.services ?? '',
  faq: b.faq ?? '',
  custom_instructions: b.custom_instructions ?? '',
});

export function KnowledgeBase({ bot, onSaved }: { bot: Bot; onSaved: (b: Bot) => void }) {
  const [form, setForm] = useState<Form>(() => from(bot));
  const [busy, setBusy] = useState(false);

  useEffect(() => setForm(from(bot)), [bot]);

  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });

  async function save() {
    setBusy(true);
    try {
      onSaved(await endpoints.updateBot(bot.id, form));
      toast.success('Knowledge base saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Header
        title="Knowledge Base"
        subtitle="Always included in the prompt, on every message. For anything longer, use Knowledge Sources instead — those are searched, not always sent."
        action={<Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>}
      />

      <Card>
        <CardContent className="pt-5">
          <Field label="Business description" hint="a few sentences on what the business does">
            <Textarea rows={4} value={form.business_description} onChange={(e) => set({ business_description: e.target.value })} />
          </Field>
          <Field label="Services" hint="one per line">
            <Textarea rows={6} value={form.services} onChange={(e) => set({ services: e.target.value })} />
          </Field>
          <Field label="FAQ" hint="Q: … / A: … pairs work well">
            <Textarea rows={10} value={form.faq} onChange={(e) => set({ faq: e.target.value })} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Custom instructions</CardTitle>
            <CardDescription>
              Appended to the system prompt. Tone, escalation rules, anything the bot must always do.
              The built-in conversation rules — stay on topic, never invent prices, handle rudeness calmly — always apply.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <Textarea rows={5} value={form.custom_instructions} onChange={(e) => set({ custom_instructions: e.target.value })} />
        </CardContent>
      </Card>
    </>
  );
}
