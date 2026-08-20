import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2, ArrowUp, ArrowDown, Upload, ImageOff } from 'lucide-react';
import {
  endpoints, uploadLogo, type Bot, type WidgetPosition, type WidgetTheme,
  type LeadConfig, type LeadTrigger, type LeadFieldMode, type WebhookFormat,
} from '@/lib/api';
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Textarea,
} from '@/components/ui';
import { Header } from '@/screens/Providers';

// ── Limits ────────────────────────────────────────────────────────
// Mirrors of what the Worker enforces (src/config.ts, src/origin.ts).
// The Worker stays the authority. These exist so a mistake is caught
// while it is being typed rather than after a round trip.
const MAX_SUGGESTIONS = 6;
const MAX_SUGGESTION_LEN = 80;
const MAX_ORIGINS = 20;
const MAX_GREETING = 300;
const MAX_LEAD_EMAILS = 5;
// The two fields still pasted into every system prompt (011). The
// Worker truncates past these; the counters exist so nobody discovers
// that after the fact.
const MAX_BUSINESS_DESCRIPTION = 600;
const MAX_CUSTOM_INSTRUCTIONS = 2000;

/** Curated brand safe colours, taken from the dashboard's own tokens so
 *  the two products stay related. */
const SWATCHES: { value: string; label: string }[] = [
  { value: '#EEBA2B', label: 'Gold' },
  { value: '#2563EB', label: 'Blue' },
  { value: '#1D5FA8', label: 'Deep blue' },
  { value: '#157347', label: 'Green' },
  { value: '#0F766E', label: 'Teal' },
  { value: '#7C3AED', label: 'Violet' },
  { value: '#C2410C', label: 'Orange' },
  { value: '#B42318', label: 'Red' },
];

const BROWSER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
})();

/** Every zone the browser knows, falling back to just the detected one
 *  on anything that does not implement supportedValuesOf. */
const TIME_ZONES: string[] = (() => {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    const all = fn ? fn.call(Intl, 'timeZone') : [];
    return all.length ? all : [BROWSER_TZ];
  } catch { return [BROWSER_TZ]; }
})();

type Form = {
  name: string; business_name: string; timezone: string;
  business_description: string;
  custom_instructions: string;
  allowed_origins: string[];
  suggestions: string[];
  primary_color: string;
  position: WidgetPosition;
  theme: WidgetTheme;
  greeting: string;
  greeting_delay_ms: string;
  show_typing: boolean;
  show_citations: boolean;
  max_messages: string;
  fallback_message: string;
  escalate_after_misses: string;
  lead_enabled: boolean;
  lead_trigger: LeadTrigger;
  lead_after: string;
  lead_phone: LeadFieldMode;
  lead_company: LeadFieldMode;
  lead_inquiry: LeadFieldMode;
  lead_consent: string;
  lead_success: string;
  lead_booking: string;
  lead_tag: string;
  webhook_format: WebhookFormat;
  lead_emails: string[];
  /**
   * Always starts empty and is never populated from the bot — the API
   * does not send the stored URL back, because it is a credential.
   * Empty on save therefore means "leave the stored one alone", which
   * is what the Worker's mergeConfigs does with an absent key.
   */
  webhook_url: string;
};

const from = (b: Bot): Form => ({
  name: b.name ?? '',
  business_name: b.business_name ?? '',
  // Not stored yet. Defaults to whatever the admin's browser reports so
  // the field is never empty when it does get wired up.
  timezone: BROWSER_TZ,
  business_description: b.business_description ?? '',
  custom_instructions: b.custom_instructions ?? '',
  // Falls back to the legacy single origin column for rows predating 006.
  allowed_origins: b.allowed_origins?.length
    ? b.allowed_origins
    : b.allowed_origin ? [b.allowed_origin] : [''],
  suggestions: b.suggestions?.length ? b.suggestions : [],
  primary_color: (b.primary_color ?? '#2563EB').toUpperCase(),

  position: b.widget_config?.position ?? 'bottom-right',
  theme: b.widget_config?.theme ?? 'light',
  greeting: b.widget_config?.greeting ?? '',
  greeting_delay_ms: String(b.widget_config?.greeting_delay_ms ?? ''),
  show_typing: b.widget_config?.show_typing !== false,
  show_citations: b.widget_config?.show_citations === true,

  max_messages: String(b.behavior_config?.max_messages ?? ''),
  fallback_message: b.behavior_config?.fallback_message ?? '',
  escalate_after_misses: String(b.behavior_config?.escalate_after_misses ?? ''),

  // Absent lead_config is the behaviour that shipped before 010, so
  // every default here has to match src/prompt.ts exactly — capture on,
  // intent trigger, phone and inquiry optional, company off.
  lead_enabled: b.lead_config?.enabled !== false,
  lead_trigger: b.lead_config?.trigger ?? 'intent',
  lead_after: String(b.lead_config?.trigger_after_messages ?? ''),
  lead_phone: b.lead_config?.fields?.phone ?? 'optional',
  lead_company: b.lead_config?.fields?.company ?? 'off',
  lead_inquiry: b.lead_config?.fields?.inquiry ?? 'optional',
  lead_consent: b.lead_config?.consent_text ?? '',
  lead_success: b.lead_config?.success_message ?? '',
  lead_booking: b.lead_config?.booking_url ?? '',
  lead_tag: b.lead_config?.tag ?? '',
  webhook_format: b.lead_config?.webhook_format ?? 'json',
  lead_emails: b.lead_config?.email_recipients ?? [],
  webhook_url: '',
});

/** Empty reads as "off" or "unset", never as NaN. */
const num = (value: string): number => {
  const n = Number(value.trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

/**
 * The same rules as validateOrigins in the Worker, reproduced for the
 * error message rather than for the gate. The save still goes through
 * the Worker's copy, which is the authority.
 */
function originError(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/\/+$/, '');
  if (!value) return null;
  if (!/^https?:\/\//.test(value)) return 'Start with https:// or http://';

  let url: URL;
  try { url = new URL(value); } catch { return 'Not a valid URL'; }
  if (url.pathname !== '/' || url.search || url.hash) return 'An origin only, with no path or query';
  if (value !== url.origin.toLowerCase()) return `Write it as ${url.origin.toLowerCase()}`;
  return null;
}

/**
 * Which form fields each section owns.
 *
 * Load bearing, not documentation. Sections save independently, and
 * widget_config is a jsonb column the API replaces wholesale, so a save
 * has to send every field in it. Sending them straight from `form`
 * would quietly save a neighbouring section's unsaved edits too, so a
 * save builds its payload from the last saved values with only its own
 * keys overlaid. See saveSection.
 */
const OWNED = {
  general:    ['name', 'business_name', 'business_description'],
  instructions: ['custom_instructions'],
  access:     ['allowed_origins'],
  appearance: ['primary_color', 'position', 'theme'],
  greeting:   ['greeting', 'greeting_delay_ms', 'suggestions'],
  behaviour:  ['show_typing', 'show_citations', 'max_messages', 'fallback_message', 'escalate_after_misses'],
  leads:      [
    'lead_enabled', 'lead_trigger', 'lead_after', 'lead_phone', 'lead_company',
    'lead_inquiry', 'lead_consent', 'lead_success', 'lead_booking', 'lead_tag',
    'webhook_format', 'webhook_url', 'lead_emails',
  ],
} satisfies Record<string, (keyof Form)[]>;

type SectionId = keyof typeof OWNED;

/** The form fields that are lists of strings edited as rows. */
type RowKey = 'allowed_origins' | 'suggestions' | 'lead_emails';

/** Only what differs from the widget's own defaults is stored, so a bot
 *  does not carry a frozen copy of them. */
const widgetConfig = (f: Form) => ({
  ...(f.position !== 'bottom-right' && { position: f.position }),
  ...(f.theme !== 'light' && { theme: f.theme }),
  ...(f.greeting.trim() && { greeting: f.greeting }),
  ...(num(f.greeting_delay_ms) > 0 && { greeting_delay_ms: num(f.greeting_delay_ms) }),
  ...(f.show_typing === false && { show_typing: false }),
  ...(f.show_citations === true && { show_citations: true }),
});

const behaviorConfig = (f: Form) => ({
  ...(num(f.max_messages) > 0 && { max_messages: num(f.max_messages) }),
  ...(f.fallback_message.trim() && { fallback_message: f.fallback_message }),
  ...(num(f.escalate_after_misses) > 0 && { escalate_after_misses: num(f.escalate_after_misses) }),
});

/**
 * Same "only store what differs from the default" rule as the two
 * above, and here it is load bearing rather than tidy: an empty object
 * is stored as NULL, and NULL is what makes the prompt byte-identical
 * to a bot that predates 010.
 *
 * webhook_url is included only when the admin actually typed one.
 * Omitting it means "keep the stored webhook", which is what every save
 * that is not about the webhook needs to mean.
 */
const leadConfig = (f: Form): LeadConfig => ({
  ...(f.lead_enabled === false && { enabled: false }),
  ...(f.lead_trigger !== 'intent' && { trigger: f.lead_trigger }),
  ...(f.lead_trigger === 'after_messages' && num(f.lead_after) > 0
    && { trigger_after_messages: num(f.lead_after) }),
  ...((f.lead_phone !== 'optional' || f.lead_company !== 'off' || f.lead_inquiry !== 'optional') && {
    fields: {
      ...(f.lead_phone !== 'optional' && { phone: f.lead_phone }),
      ...(f.lead_company !== 'off' && { company: f.lead_company }),
      ...(f.lead_inquiry !== 'optional' && { inquiry: f.lead_inquiry }),
    },
  }),
  ...(f.lead_consent.trim() && { consent_text: f.lead_consent.trim() }),
  ...(f.lead_success.trim() && { success_message: f.lead_success.trim() }),
  ...(f.lead_booking.trim() && { booking_url: f.lead_booking.trim() }),
  ...(f.lead_tag.trim() && { tag: f.lead_tag.trim() }),
  ...(f.webhook_format !== 'json' && { webhook_format: f.webhook_format }),
  ...(f.lead_emails.filter((v) => v.trim()).length && {
    email_recipients: f.lead_emails.map((v) => v.trim()).filter(Boolean),
  }),
  ...(f.webhook_url.trim() && { webhook_url: f.webhook_url.trim() }),
});

// ── Layout ────────────────────────────────────────────────────────

/** A titled group with its heading OUTSIDE the card, so the page reads
 *  as sections rather than as one undifferentiated stack of boxes. */
function Section({
  title, description, children,
}: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <div>
        <h2 className="font-display text-xl leading-tight">{title}</h2>
        {description && <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** Label and its explanation on the left, the control on the right.
 *  Stacks on narrow screens, where side by side would leave the input
 *  too cramped to type in. */
function SettingRow({
  label, description, htmlFor, children, align = 'center',
}: {
  label: string; description?: string; htmlFor?: string;
  children: React.ReactNode; align?: 'center' | 'start';
}) {
  return (
    <div className={`flex flex-col gap-3 py-6 sm:flex-row sm:gap-10 ${align === 'center' ? 'sm:items-center' : 'sm:items-start'}`}>
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="block text-sm font-medium leading-none">{label}</label>
        {description && <p className="mt-2 text-sm leading-relaxed text-muted">{description}</p>}
      </div>
      <div className="w-full shrink-0 sm:w-75">{children}</div>
    </div>
  );
}

function Rows({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-border">{children}</div>;
}

/** Per section save. The page is long enough that one button at the top
 *  means scrolling back to it, and disabling until something changes
 *  makes it obvious which sections are still unsaved. */
function SaveBar({ busy, dirty, onSave }: { busy: boolean; dirty: boolean; onSave: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-b-xl border-t border-border bg-sunk px-6 py-4">
      <span className="text-xs text-muted">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
      <Button onClick={onSave} disabled={busy || !dirty}>{busy ? 'Saving...' : 'Save'}</Button>
    </div>
  );
}

export function BotConfiguration({ bot, onSaved }: { bot: Bot; onSaved: (b: Bot) => void }) {
  const [form, setForm] = useState<Form>(() => from(bot));
  /** The last saved values. Sections diff against this to know whether
   *  they are dirty, and build their payloads from it. */
  const [saved, setSaved] = useState<Form>(() => from(bot));
  const [busy, setBusy] = useState<SectionId | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Keyed on the bot id, NOT on the bot object. A save replaces the bot
  // prop, and resetting the whole form there would throw away every
  // other section's unsaved edits.
  useEffect(() => {
    setForm(from(bot));
    setSaved(from(bot));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  const set = (patch: Partial<Form>) => setForm((f) => ({ ...f, ...patch }));

  const setRow = (key: RowKey, i: number, value: string) =>
    setForm((f) => ({ ...f, [key]: f[key].map((v, n) => (n === i ? value : v)) }));

  const addRow = (key: RowKey) =>
    setForm((f) => ({ ...f, [key]: [...f[key], ''] }));

  const removeRow = (key: RowKey, i: number) =>
    setForm((f) => ({ ...f, [key]: f[key].filter((_, n) => n !== i) }));

  const moveRow = (key: 'suggestions', i: number, by: -1 | 1) =>
    setForm((f) => {
      const next = [...f[key]];
      const target = i + by;
      if (target < 0 || target >= next.length) return f;
      [next[i], next[target]] = [next[target], next[i]];
      return { ...f, [key]: next };
    });

  const originErrors = form.allowed_origins.map(originError);
  const filledOrigins = form.allowed_origins.map((v) => v.trim()).filter(Boolean);
  const suggestions = form.suggestions.map((v) => v.trim()).filter(Boolean);

  const isDirty = (id: SectionId) =>
    (OWNED[id] as (keyof Form)[]).some((k) => JSON.stringify(form[k]) !== JSON.stringify(saved[k]));

  async function saveSection(id: SectionId) {
    if (id === 'access') {
      if (originErrors.some(Boolean)) { toast.error('Fix the highlighted origins first'); return; }
      if (filledOrigins.length === 0) { toast.error('At least one allowed origin is required'); return; }
    }

    // Last saved values, with only this section's fields overlaid.
    const keys = OWNED[id] as (keyof Form)[];
    const merged = { ...saved } as Form;
    for (const k of keys) (merged as Record<string, unknown>)[k] = form[k];

    const payload: Record<string, unknown> =
      id === 'general'    ? {
          name: merged.name,
          business_name: merged.business_name,
          business_description: merged.business_description,
        }
      : id === 'instructions' ? { custom_instructions: merged.custom_instructions }
      : id === 'access'   ? { allowed_origins: filledOrigins }
      : id === 'appearance' ? { primary_color: merged.primary_color, widget_config: widgetConfig(merged) }
      : id === 'greeting' ? { suggestions, widget_config: widgetConfig(merged) }
      : id === 'behaviour' ? { widget_config: widgetConfig(merged), behavior_config: behaviorConfig(merged) }
      : { lead_config: leadConfig(merged) };

    setBusy(id);
    try {
      const updated = await endpoints.updateBot(bot.id, payload);
      onSaved(updated);
      // The webhook field is cleared on both sides after a save. It is
      // write-only, so leaving the typed URL on screen would show a
      // credential the API will never send back — and would make the
      // section read as dirty forever once `saved` no longer matches.
      const settled = id === 'leads' ? { ...merged, webhook_url: '' } : merged;
      if (id === 'leads') set({ webhook_url: '' });
      setSaved(settled);
      toast.success('Saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Clearing the webhook is its own action rather than an empty text
   * field, because empty already means "leave the stored one alone" —
   * the form is never given the URL, so it cannot express removal by
   * showing nothing. `null` is the explicit clear the Worker looks for.
   */
  async function removeWebhook() {
    setBusy('leads');
    try {
      const updated = await endpoints.updateBot(bot.id, {
        lead_config: { ...leadConfig(saved), webhook_url: null },
      });
      onSaved(updated);
      set({ webhook_url: '' });
      setSaved({ ...saved, webhook_url: '' });
      toast.success('Webhook removed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove the webhook');
    } finally {
      setBusy(null);
    }
  }

  async function onPickLogo(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try {
      const updated = await uploadLogo(bot.id, file);
      onSaved(updated);
      toast.success('Logo updated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not upload that image');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function removeLogo() {
    try {
      const updated = await endpoints.deleteLogo(bot.id);
      onSaved(updated);
      toast.success('Logo removed');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove the logo');
    }
  }

  // A bot saved before this list existed can hold a colour that is not
  // on it. Showing it keeps the dropdown honest instead of rendering
  // blank and silently repainting the widget on the next save.
  const colours = useMemo(() => {
    const known = SWATCHES.some((s) => s.value === form.primary_color);
    return known ? SWATCHES : [{ value: form.primary_color, label: form.primary_color }, ...SWATCHES];
  }, [form.primary_color]);

  return (
    <div className="space-y-10">
      <Header
        title="Bot Configuration"
        subtitle="How your assistant looks, where it is allowed to run, and when it should hand a visitor over to a person."
      />

      <Section
        title="General settings"
        description="The names your visitors see, and the clock this bot works against."
      >
        <Card>
          <CardContent className="pb-0">
            <Rows>
              <SettingRow label="Bot name" description="Shown in the widget header and in the opening message.">
                <Input value={form.name} onChange={(e) => set({ name: e.target.value })} />
              </SettingRow>

              <SettingRow label="Business name" description="Used throughout the bot's answers, and in the prompt that keeps it on topic.">
                <Input value={form.business_name} onChange={(e) => set({ business_name: e.target.value })} />
              </SettingRow>

              {/* One of only two tenant-written fields still pasted into
                  every single message, which is why it is capped and why
                  the counter is visible. Anything longer belongs in
                  Knowledge, where it is searched rather than always sent. */}
              <SettingRow
                label="What the business does"
                align="start"
                description="Two or three sentences, included in every message the bot sends. For anything longer, add it under Knowledge instead — that material is searched, not sent every time."
              >
                <Textarea
                  rows={4}
                  maxLength={MAX_BUSINESS_DESCRIPTION}
                  value={form.business_description}
                  onChange={(e) => set({ business_description: e.target.value })}
                  placeholder="A family dental practice in central Leeds, open six days a week."
                />
                <p className="mt-1.5 text-right text-xs text-muted">
                  {form.business_description.length} / {MAX_BUSINESS_DESCRIPTION}
                </p>
              </SettingRow>

              <SettingRow
                label="Time zone"
                description="Detected from your browser. Nothing reads it yet, so changing it has no effect until opening hours become schedule aware."
              >
                <Select value={form.timezone} onValueChange={(v) => set({ timezone: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TIME_ZONES.map((tz) => <SelectItem key={tz} value={tz}>{tz}</SelectItem>)}
                  </SelectContent>
                </Select>
              </SettingRow>
            </Rows>
          </CardContent>
          <SaveBar busy={busy === 'general'} dirty={isDirty('general')} onSave={() => void saveSection('general')} />
        </Card>
      </Section>

      <Section
        title="Access and security"
        description="Where this bot is allowed to run."
      >
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Allowed origins</CardTitle>
              <CardDescription>
                The widget only answers on the origins listed here. Requests from anywhere else are refused.
                <br />
                A browser counts acme.com and www.acme.com as different origins, so add both. No trailing slash, no path.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {form.allowed_origins.map((value, i) => (
                <div key={i}>
                  <div className="flex items-center gap-2">
                    <Input
                      className={`font-mono text-xs ${originErrors[i] ? 'border-danger' : ''}`}
                      value={value}
                      onChange={(e) => setRow('allowed_origins', i, e.target.value)}
                      placeholder="https://acme.com"
                      aria-invalid={!!originErrors[i]}
                      aria-label={`Origin ${i + 1}`}
                    />
                    <Button
                      variant="ghost" size="icon"
                      onClick={() => removeRow('allowed_origins', i)}
                      disabled={form.allowed_origins.length === 1}
                      aria-label={`Remove origin ${i + 1}`}
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                  {originErrors[i] && <p className="mt-1.5 text-xs text-danger">{originErrors[i]}</p>}
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between gap-4 pt-1">
              <span className="text-xs text-muted">{filledOrigins.length} of {MAX_ORIGINS} used</span>
              <Button
                variant="outline" size="sm"
                onClick={() => addRow('allowed_origins')}
                disabled={form.allowed_origins.length >= MAX_ORIGINS}
              >
                <Plus size={14} className="mr-1.5" /> Add origin
              </Button>
            </div>
          </CardContent>
          <SaveBar busy={busy === 'access'} dirty={isDirty('access')} onSave={() => void saveSection('access')} />
        </Card>
      </Section>

      <Section title="Appearance" description="How the widget looks on your site.">
        <Card>
          <CardContent className="pb-0">
            <Rows>
              <SettingRow label="Primary colour" description="Paints the launcher, the header and the visitor's own messages.">
                <Select value={form.primary_color} onValueChange={(v) => set({ primary_color: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {colours.map((s) => (
                      <SelectItem key={s.value} value={s.value}>
                        <span className="flex items-center gap-2.5">
                          <span className="h-3.5 w-7 shrink-0 rounded" style={{ background: s.value }} />
                          {s.label}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>

              <SettingRow label="Position" description="Which corner the launcher sits in.">
                <Select value={form.position} onValueChange={(v) => set({ position: v as WidgetPosition })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bottom-right">Bottom right</SelectItem>
                    <SelectItem value="bottom-left">Bottom left</SelectItem>
                  </SelectContent>
                </Select>
              </SettingRow>

              <SettingRow label="Theme" description="Auto follows each visitor's own system setting, and keeps following it while the panel is open.">
                <Select value={form.theme} onValueChange={(v) => set({ theme: v as WidgetTheme })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="light">Light</SelectItem>
                    <SelectItem value="dark">Dark</SelectItem>
                    <SelectItem value="auto">Auto</SelectItem>
                  </SelectContent>
                </Select>
              </SettingRow>

              <SettingRow
                label="Logo"
                align="start"
                description="Replaces the default mark on the launcher and in the panel header. PNG, JPEG or WebP, up to 512 KB. Saves on its own, without waiting for Save."
              >
                <div className="flex items-center gap-4">
                  <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-bg">
                    {bot.logo_url
                      ? <img src={bot.logo_url} alt="Current logo" className="h-full w-full object-cover" />
                      : <ImageOff size={18} className="text-faint" />}
                  </div>
                  <input
                    ref={fileInput}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="hidden"
                    onChange={(e) => void onPickLogo(e.target.files?.[0])}
                  />
                  <div className="flex flex-col items-start gap-1.5">
                    <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
                      <Upload size={14} className="mr-1.5" />
                      {uploading ? 'Uploading...' : bot.logo_url ? 'Replace' : 'Upload'}
                    </Button>
                    {bot.logo_url && (
                      <Button variant="ghost" size="sm" onClick={() => void removeLogo()}>Remove</Button>
                    )}
                  </div>
                </div>
              </SettingRow>
            </Rows>
          </CardContent>
          <SaveBar busy={busy === 'appearance'} dirty={isDirty('appearance')} onSave={() => void saveSection('appearance')} />
        </Card>
      </Section>

      <Section title="Greeting" description="What the widget says before a visitor has typed anything.">
        <Card>
          <CardContent className="pb-0">
            <Rows>
              <SettingRow
                label="Opening message"
                align="start"
                description={`Leave this empty to use the built in line. ${form.greeting.length} of ${MAX_GREETING} characters used.`}
              >
                <Textarea
                  rows={3}
                  maxLength={MAX_GREETING}
                  value={form.greeting}
                  onChange={(e) => set({ greeting: e.target.value })}
                  placeholder="Hi, I can help with bookings and questions."
                />
              </SettingRow>

              <SettingRow
                label="Greeting delay"
                description="Milliseconds to wait before the opening message appears, up to 10000. A visitor who types first never sees it."
              >
                <Input
                  type="number" min={0} max={10000} step={250}
                  value={form.greeting_delay_ms}
                  onChange={(e) => set({ greeting_delay_ms: e.target.value })}
                  placeholder="0"
                />
              </SettingRow>

              <SettingRow
                label="Starter suggestions"
                align="start"
                description="The chips offered under the opening message. Leave the list empty to fall back to neutral defaults."
              >
                <div className="space-y-3">
                  {form.suggestions.map((value, i) => (
                    <div key={i} className="flex items-center gap-1.5">
                      <Input
                        value={value}
                        maxLength={MAX_SUGGESTION_LEN}
                        onChange={(e) => setRow('suggestions', i, e.target.value)}
                        placeholder="Do you take walk ins?"
                        aria-label={`Suggestion ${i + 1}`}
                      />
                      <Button variant="ghost" size="icon" onClick={() => moveRow('suggestions', i, -1)} disabled={i === 0} aria-label="Move up">
                        <ArrowUp size={15} />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => moveRow('suggestions', i, 1)} disabled={i === form.suggestions.length - 1} aria-label="Move down">
                        <ArrowDown size={15} />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => removeRow('suggestions', i)} aria-label="Remove suggestion">
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  ))}

                  <div className="flex items-center justify-between gap-4">
                    <span className="text-xs text-muted">{suggestions.length} of {MAX_SUGGESTIONS} used</span>
                    <Button
                      variant="outline" size="sm"
                      onClick={() => addRow('suggestions')}
                      disabled={form.suggestions.length >= MAX_SUGGESTIONS}
                    >
                      <Plus size={14} className="mr-1.5" /> Add suggestion
                    </Button>
                  </div>
                </div>
              </SettingRow>
            </Rows>
          </CardContent>
          <SaveBar busy={busy === 'greeting'} dirty={isDirty('greeting')} onSave={() => void saveSection('greeting')} />
        </Card>
      </Section>

      <Section
        title="Behaviour"
        description="When the bot should stop trying to answer and offer a person instead."
      >
        <Card>
          <CardContent className="pb-0">
            <Rows>
              <SettingRow label="Typing indicator" description="The animated dots shown while a reply is being generated.">
                <div className="sm:flex sm:justify-end">
                  <Switch checked={form.show_typing} onCheckedChange={(v) => set({ show_typing: v })} aria-label="Typing indicator" />
                </div>
              </SettingRow>

              <SettingRow label="Source citations" description="Names the document a reply drew on, whenever retrieval was used.">
                <div className="sm:flex sm:justify-end">
                  <Switch checked={form.show_citations} onCheckedChange={(v) => set({ show_citations: v })} aria-label="Source citations" />
                </div>
              </SettingRow>

              <SettingRow
                label="Offer a person after"
                description="Total messages in one conversation before the bot offers to hand over. Leave empty or set 0 to switch this off."
              >
                <Input
                  type="number" min={0} max={100}
                  value={form.max_messages}
                  onChange={(e) => set({ max_messages: e.target.value })}
                  placeholder="Off"
                />
              </SettingRow>

              <SettingRow
                label="Escalate after"
                align="start"
                description="Questions in a row that found nothing in your knowledge base. Best effort, not a guarantee: there is no confidence score, so this counts retrieval misses. A bot with no sources indexed never triggers it."
              >
                <Input
                  type="number" min={0} max={10}
                  value={form.escalate_after_misses}
                  onChange={(e) => set({ escalate_after_misses: e.target.value })}
                  placeholder="Off"
                />
              </SettingRow>

              <SettingRow
                label="Fallback message"
                align="start"
                description="Preferred wording when nothing in your sources answers the question. The bot adapts it to the visitor's language rather than quoting it."
              >
                <Textarea
                  rows={3}
                  maxLength={300}
                  value={form.fallback_message}
                  onChange={(e) => set({ fallback_message: e.target.value })}
                  placeholder="I could not find that in our material. Call us on 555 0100 and we will help."
                />
              </SettingRow>
            </Rows>
          </CardContent>
          <SaveBar busy={busy === 'behaviour'} dirty={isDirty('behaviour')} onSave={() => void saveSection('behaviour')} />
        </Card>
      </Section>

      <Section
        title="Instructions"
        description="Standing rules for how this bot behaves. Not knowledge — knowledge goes under Knowledge."
      >
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Custom instructions</CardTitle>
              <CardDescription>
                Tone, escalation rules, anything the bot must always do. The built-in conversation
                rules — stay on topic, never invent prices, handle rudeness calmly — always apply on
                top of these.
                <br />
                These stay in the prompt on purpose. Everything the bot reads from your sources is
                explicitly labelled as facts to use and never as orders to follow, so instructions
                filed there would be ignored by design.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <Textarea
              rows={6}
              maxLength={MAX_CUSTOM_INSTRUCTIONS}
              value={form.custom_instructions}
              onChange={(e) => set({ custom_instructions: e.target.value })}
              placeholder="Always mention that first consultations are free. Never quote a price without saying it is an estimate."
            />
            <p className="mt-1.5 text-right text-xs text-muted">
              {form.custom_instructions.length} / {MAX_CUSTOM_INSTRUCTIONS}
            </p>
          </CardContent>
          <SaveBar
            busy={busy === 'instructions'}
            dirty={isDirty('instructions')}
            onSave={() => void saveSection('instructions')}
          />
        </Card>
      </Section>

      <Section
        title="Lead capture"
        description="Whether the bot collects contact details, what it asks for, and who hears about it."
      >
        <Card>
          <CardContent className="pb-0">
            <Rows>
              <SettingRow
                label="Capture leads"
                description="Off removes lead capture from the bot's instructions entirely — it will answer questions and never ask for details."
              >
                <div className="sm:flex sm:justify-end">
                  <Switch
                    checked={form.lead_enabled}
                    onCheckedChange={(v) => set({ lead_enabled: v })}
                    aria-label="Capture leads"
                  />
                </div>
              </SettingRow>

              {form.lead_enabled && (
                <>
                  <SettingRow
                    label="When to ask"
                    align="start"
                    description="“On buying intent” and “From the start” are instructions the bot follows, not rules it is held to. “After a set number of messages” is counted server-side and does fire reliably."
                  >
                    <Select value={form.lead_trigger} onValueChange={(v) => set({ lead_trigger: v as LeadTrigger })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="intent">On buying intent</SelectItem>
                        <SelectItem value="always">From the start</SelectItem>
                        <SelectItem value="after_messages">After a set number of messages</SelectItem>
                      </SelectContent>
                    </Select>
                  </SettingRow>

                  {form.lead_trigger === 'after_messages' && (
                    <SettingRow
                      label="Messages first"
                      description="Total messages in the conversation before the bot offers to take their details."
                    >
                      <Input
                        type="number" min={2} max={50}
                        value={form.lead_after}
                        onChange={(e) => set({ lead_after: e.target.value })}
                        placeholder="6"
                      />
                    </SettingRow>
                  )}

                  <SettingRow
                    label="Details to collect"
                    align="start"
                    description="Name and email are always collected — a lead without them is not saved. Required is an instruction to the bot; a visitor who never gives one is still saved with the rest."
                  >
                    <div className="space-y-2">
                      {([
                        ['Phone', 'lead_phone', form.lead_phone],
                        ['Company', 'lead_company', form.lead_company],
                        ['Inquiry', 'lead_inquiry', form.lead_inquiry],
                      ] as const).map(([label, key, value]) => (
                        <div key={key} className="flex items-center gap-3">
                          <span className="w-20 shrink-0 text-sm text-muted">{label}</span>
                          <Select value={value} onValueChange={(v) => set({ [key]: v as LeadFieldMode } as Partial<Form>)}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="off">Do not ask</SelectItem>
                              <SelectItem value="optional">Optional</SelectItem>
                              <SelectItem value="required">Required</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      ))}
                    </div>
                  </SettingRow>

                  <SettingRow
                    label="Ask permission first"
                    align="start"
                    description="Spoken before any details are requested, adapted to the visitor's language. Leave empty to skip it. Leads captured while this is set are marked as asked — which records that the bot asked, not that the visitor agreed."
                  >
                    <Textarea
                      rows={2}
                      maxLength={200}
                      value={form.lead_consent}
                      onChange={(e) => set({ lead_consent: e.target.value })}
                      placeholder="I'll just take a few details so the team can get back to you — is that okay?"
                    />
                  </SettingRow>

                  <SettingRow
                    label="Confirmation"
                    align="start"
                    description="What the bot says once it has their details. Reworded into the visitor's language rather than quoted."
                  >
                    <Textarea
                      rows={2}
                      maxLength={300}
                      value={form.lead_success}
                      onChange={(e) => set({ lead_success: e.target.value })}
                      placeholder="Thanks! I've passed your details to the team — they'll be in touch shortly."
                    />
                  </SettingRow>

                  <SettingRow
                    label="Booking link"
                    align="start"
                    description="Offered once after the details are collected, so a visitor can book without waiting for a reply."
                  >
                    <Input
                      type="url"
                      value={form.lead_booking}
                      onChange={(e) => set({ lead_booking: e.target.value })}
                      placeholder="https://cal.com/your-team"
                    />
                  </SettingRow>

                  <SettingRow
                    label="Label"
                    description="Attached to every lead this bot captures, so leads from different sites or pages stay tellable apart."
                  >
                    <Input
                      maxLength={40}
                      value={form.lead_tag}
                      onChange={(e) => set({ lead_tag: e.target.value })}
                      placeholder="Website chat"
                    />
                  </SettingRow>

                  <SettingRow
                    label="Email these people"
                    align="start"
                    description="Each captured lead is emailed to everyone listed. Replying to that email goes straight to the visitor. Up to 5 addresses."
                  >
                    <div className="space-y-2">
                      {form.lead_emails.map((address, i) => (
                        <div key={i} className="flex gap-2">
                          <Input
                            type="email"
                            value={address}
                            onChange={(e) => setRow('lead_emails', i, e.target.value)}
                            placeholder="sales@yourcompany.com"
                          />
                          <Button
                            variant="outline" size="sm"
                            onClick={() => removeRow('lead_emails', i)}
                            aria-label="Remove recipient"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                      {form.lead_emails.length < MAX_LEAD_EMAILS && (
                        <Button variant="outline" size="sm" onClick={() => addRow('lead_emails')}>
                          <Plus className="h-3.5 w-3.5" /> Add recipient
                        </Button>
                      )}
                    </div>
                  </SettingRow>

                  <SettingRow
                    label="Notify a webhook"
                    align="start"
                    description={
                      form.webhook_format === 'slack' ? 'Paste a Slack incoming-webhook URL.'
                      : form.webhook_format === 'teams' ? 'Paste the URL from a Teams "webhook request received" workflow.'
                      : 'Any HTTPS endpoint — your CRM, an automation, your own API. It receives a JSON POST for each lead.'
                    }
                  >
                    <div className="space-y-2">
                      <Select
                        value={form.webhook_format}
                        onValueChange={(v) => set({ webhook_format: v as WebhookFormat })}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="json">Generic JSON</SelectItem>
                          <SelectItem value="slack">Slack</SelectItem>
                          <SelectItem value="teams">Microsoft Teams</SelectItem>
                        </SelectContent>
                      </Select>
                      <Input
                        type="url"
                        value={form.webhook_url}
                        onChange={(e) => set({ webhook_url: e.target.value })}
                        placeholder={bot.lead_config?.has_webhook ? 'Enter a new URL to replace it' : 'https://…'}
                      />
                      {bot.lead_config?.has_webhook && (
                        <div className="flex items-center justify-between gap-2 text-xs text-muted">
                          <span className="truncate">
                            Posting to {bot.lead_config.webhook_host ?? 'a configured endpoint'}
                          </span>
                          <button
                            type="button"
                            className="shrink-0 underline hover:text-fg"
                            onClick={() => void removeWebhook()}
                            disabled={busy === 'leads'}
                          >
                            Remove
                          </button>
                        </div>
                      )}
                    </div>
                  </SettingRow>
                </>
              )}
            </Rows>
          </CardContent>
          <SaveBar busy={busy === 'leads'} dirty={isDirty('leads')} onSave={() => void saveSection('leads')} />
        </Card>
      </Section>

      {/* The Contact section lived here until 015. It edited four
          legacy columns — contact_phone, contact_email, address, hours
          — that `bots.profile` now supersedes, and it is the Business
          Profile screen that owns them. The columns themselves are read
          -through deprecated rather than dropped, so a bot that has
          never been backfilled still renders exactly the prompt it did
          before; there is simply no longer a form pointing at them. */}
    </div>
  );
}
