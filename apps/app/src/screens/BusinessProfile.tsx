// ----------------------------------------------------------------
// Business Profile — the facts the bot is told on every single message
//
// Tier 0 of the knowledge model (supabase/015). Everything on this
// screen is in the prompt on every turn and is never searched for,
// which is the opposite of the Knowledge Base: bounded and always
// relevant, rather than unbounded and sometimes relevant.
//
// THE ONE THING THAT WILL BITE WHOEVER EDITS THIS FILE NEXT (R3):
// `profile` IS ONE JSONB COLUMN AND THE API REPLACES IT WHOLESALE.
// Six sections save independently against it, so every save must send
// the WHOLE object — built from the last SAVED profile with only that
// section's keys overlaid. Sending the live form state instead would
// quietly persist a neighbouring section's unsaved edits, which is
// invisible in testing and obvious in production. That is what
// `sectionPayload` below is for; do not bypass it.
//
// The same pattern BotConfiguration.tsx uses for widget_config, for the
// same reason and with the same shape.
// ----------------------------------------------------------------
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, Trash2 } from 'lucide-react';
import {
  endpoints,
  type Bot, type BusinessProfile as Profile, type DayKey,
  type HoursException, type HoursInterval, type ProfileLink,
} from '@/lib/api';
import {
  Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input,
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Textarea,
} from '@/components/ui';
import { Header } from '@/screens/Providers';

// ── Limits ────────────────────────────────────────────────────────
// Mirrors of LIMITS.profile in src/config.ts. The Worker stays the
// authority; these exist so a mistake is caught while it is being typed
// rather than after a round trip.
const MAX_TEXT = 300;
const MAX_SOCIALS = 6;
const MAX_CUSTOM_LINKS = 6;
const MAX_EXCEPTIONS = 20;
const MAX_LABELS = 12;

const DAYS: { key: DayKey; label: string }[] = [
  { key: 'mon', label: 'Monday' },
  { key: 'tue', label: 'Tuesday' },
  { key: 'wed', label: 'Wednesday' },
  { key: 'thu', label: 'Thursday' },
  { key: 'fri', label: 'Friday' },
  { key: 'sat', label: 'Saturday' },
  { key: 'sun', label: 'Sunday' },
];

const BROWSER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
  catch { return 'UTC'; }
})();

/**
 * Every zone the browser knows, falling back to just the detected one.
 *
 * The same guard BotConfiguration.tsx uses, and the Worker's validator
 * guards `supportedValuesOf` the same way — it is a separate proposal
 * from the ICU data itself, so a runtime can have the zones and not the
 * list of them.
 */
const TIME_ZONES: string[] = (() => {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    const all = fn ? fn.call(Intl, 'timeZone') : [];
    return all.length ? all : [BROWSER_TZ];
  } catch { return [BROWSER_TZ]; }
})();

// ----------------------------------------------------------------
// Sections
//
// OWNED is load bearing, not documentation: it is the list of top-level
// profile keys each save is allowed to write. See sectionPayload.
// ----------------------------------------------------------------
const OWNED = {
  identity: ['identity'],
  location: ['location'],
  hours:    ['hours'],
  contact:  ['contact'],
  links:    ['links'],
  policies: ['policies'],
} satisfies Record<string, (keyof Profile)[]>;

type SectionId = keyof typeof OWNED;

/**
 * Strip everything empty, recursively, and return undefined for what is
 * left of an object with nothing in it.
 *
 * This is what makes "cleared back to defaults" store as NULL rather
 * than as a tree of empty strings — the Worker's `orNull` only sees the
 * top level, so a `{ identity: { tagline: '' } }` would survive it and
 * `profileFor` would then take the structured path for a profile that
 * says nothing. The prompt would lose the legacy block and gain an
 * empty heading.
 */
function prune<T>(value: T): T | undefined {
  if (typeof value === 'string') {
    const v = value.trim();
    return (v ? (v as unknown as T) : undefined);
  }
  if (Array.isArray(value)) {
    const rows = value.map(prune).filter((v) => v !== undefined);
    return rows.length ? (rows as unknown as T) : undefined;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      const kept = prune(v);
      if (kept !== undefined) out[key] = kept;
    }
    return Object.keys(out).length ? (out as unknown as T) : undefined;
  }
  // Booleans and numbers pass through; `false` is a real value on an
  // exception's `closed`, and dropping it would turn a holiday into an
  // ordinary day.
  return value === undefined || value === null ? undefined : value;
}

const empty = (): Profile => ({});

/** The row shapes the form edits, which are the profile's own shapes
 *  with the optional bits made concrete so an input always has a value
 *  to bind to. */
type LinkRow = ProfileLink;
type ExceptionRow = Required<Pick<HoursException, 'date'>> & HoursException;

export function BusinessProfile({ bot, onSaved }: { bot: Bot; onSaved: (b: Bot) => void }) {
  const [form, setForm] = useState<Profile>(() => bot.profile ?? empty());
  /** The last SAVED profile. Sections diff against this to know whether
   *  they are dirty, and build their payloads from it. */
  const [saved, setSaved] = useState<Profile>(() => bot.profile ?? empty());
  const [busy, setBusy] = useState<SectionId | 'backfill' | null>(null);

  // Keyed on the bot id, NOT the bot object: a save replaces the prop,
  // and resetting the whole form there would throw away every other
  // section's unsaved edits. Same rule BotConfiguration.tsx follows.
  useEffect(() => {
    setForm(bot.profile ?? empty());
    setSaved(bot.profile ?? empty());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  const patch = (part: Partial<Profile>) => setForm((f) => ({ ...f, ...part }));

  const isDirty = (id: SectionId) =>
    OWNED[id].some((k) => JSON.stringify(form[k] ?? null) !== JSON.stringify(saved[k] ?? null));

  /**
   * The whole profile, from `saved`, with only this section's keys
   * overlaid. R3 lives here.
   */
  function sectionPayload(id: SectionId): Profile | null {
    const merged: Profile = { ...saved };
    for (const key of OWNED[id]) {
      (merged as Record<string, unknown>)[key] = form[key];
    }
    return prune(merged) ?? null;
  }

  async function saveSection(id: SectionId) {
    setBusy(id);
    try {
      const updated = await endpoints.updateBot(bot.id, { profile: sectionPayload(id) });
      onSaved(updated);
      // Take the server's copy rather than the local one: validation
      // clamps text and sorts opening-hours intervals, so what was
      // stored is not always what was sent — and a form that keeps the
      // unclamped version reads as dirty forever.
      setSaved(updated.profile ?? empty());
      setForm(updated.profile ?? empty());
      toast.success('Saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Move the old single-line hours, address and contact fields in here.
   *
   * Offered only while the profile is empty. It is a plan first (the
   * dry run) and a write second, because the one thing a tenant needs
   * to know before pressing it is what it will and will not touch.
   */
  async function backfill() {
    setBusy('backfill');
    try {
      const plan = await endpoints.profileBackfillPlan(bot.id);
      const moving = Object.entries(plan.plan).filter(([, n]) => n > 0);
      if (!moving.length) {
        toast.error('There is nothing to move — fill this page in directly.');
        return;
      }
      const result = await endpoints.profileBackfill(bot.id);
      onSaved(result.bot);
      setSaved(result.bot.profile ?? empty());
      setForm(result.bot.profile ?? empty());
      toast.success(`Moved ${moving.length} field${moving.length === 1 ? '' : 's'} into your profile`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not import');
    } finally {
      setBusy(null);
    }
  }

  const legacy = [bot.hours, bot.address ?? bot.location, bot.contact_phone, bot.contact_email, bot.contact]
    .some((v) => typeof v === 'string' && v.trim());
  const showImport = !bot.profile && legacy;

  return (
    <div className="space-y-10">
      <Header
        title="Business Profile"
        subtitle="The facts your bot is given on every single message — hours, address, contact details, links. These are never searched for, so they are never missed."
      />

      {showImport && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Bring across what you already have</CardTitle>
              <CardDescription>
                Your opening hours, address and contact details are still stored as plain lines of
                text. Move them here and your bot can be told them properly — including working out
                whether you are open right now, which it cannot do from a sentence.
                <br />
                Nothing is deleted, and nothing changes for your visitors until you save a section
                below.
              </CardDescription>
            </div>
            <Button onClick={() => void backfill()} disabled={busy === 'backfill'}>
              {busy === 'backfill' ? 'Importing…' : 'Import'}
            </Button>
          </CardHeader>
        </Card>
      )}

      <IdentitySection
        value={form.identity ?? {}}
        onChange={(identity) => patch({ identity })}
        busy={busy === 'identity'}
        dirty={isDirty('identity')}
        onSave={() => void saveSection('identity')}
      />

      <LocationSection
        value={form.location ?? {}}
        onChange={(location) => patch({ location })}
        busy={busy === 'location'}
        dirty={isDirty('location')}
        onSave={() => void saveSection('location')}
      />

      <HoursSection
        value={form.hours ?? {}}
        onChange={(hours) => patch({ hours })}
        busy={busy === 'hours'}
        dirty={isDirty('hours')}
        onSave={() => void saveSection('hours')}
      />

      <ContactSection
        value={form.contact ?? {}}
        onChange={(contact) => patch({ contact })}
        busy={busy === 'contact'}
        dirty={isDirty('contact')}
        onSave={() => void saveSection('contact')}
      />

      <LinksSection
        value={form.links ?? {}}
        onChange={(links) => patch({ links })}
        busy={busy === 'links'}
        dirty={isDirty('links')}
        onSave={() => void saveSection('links')}
      />

      <PoliciesSection
        value={form.policies ?? {}}
        onChange={(policies) => patch({ policies })}
        busy={busy === 'policies'}
        dirty={isDirty('policies')}
        onSave={() => void saveSection('policies')}
      />
    </div>
  );
}

// ----------------------------------------------------------------
// Layout — the same three primitives BotConfiguration.tsx uses, so the
// two screens read as one product rather than as two.
// ----------------------------------------------------------------
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

function SettingRow({
  label, description, children, align = 'center',
}: {
  label: string; description?: string;
  children: React.ReactNode; align?: 'center' | 'start';
}) {
  return (
    <div className={`flex flex-col gap-3 py-6 sm:flex-row sm:gap-10 ${align === 'center' ? 'sm:items-center' : 'sm:items-start'}`}>
      <div className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-none">{label}</span>
        {description && <p className="mt-2 text-sm leading-relaxed text-muted">{description}</p>}
      </div>
      <div className="w-full shrink-0 sm:w-75">{children}</div>
    </div>
  );
}

function Rows({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-border">{children}</div>;
}

function SaveBar({ busy, dirty, onSave }: { busy: boolean; dirty: boolean; onSave: () => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-b-xl border-t border-border bg-sunk px-6 py-4">
      <span className="text-xs text-muted">{dirty ? 'Unsaved changes' : 'All changes saved'}</span>
      <Button onClick={onSave} disabled={busy || !dirty}>{busy ? 'Saving…' : 'Save'}</Button>
    </div>
  );
}

type SectionProps<T> = {
  value: T;
  onChange: (next: T) => void;
  busy: boolean;
  dirty: boolean;
  onSave: () => void;
};

/** A text input bound to one key of a section object. */
function textField<T extends object>(
  value: T, onChange: (next: T) => void, key: keyof T,
) {
  return {
    value: (value[key] as string | undefined) ?? '',
    maxLength: MAX_TEXT,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) =>
      onChange({ ...value, [key]: e.target.value }),
  };
}

// ----------------------------------------------------------------
// Identity
// ----------------------------------------------------------------
function IdentitySection({ value, onChange, busy, dirty, onSave }: SectionProps<NonNullable<Profile['identity']>>) {
  const f = (key: keyof NonNullable<Profile['identity']>) => textField(value, onChange, key);
  return (
    <Section
      title="Identity"
      description="Who the business is, in the words it would use itself."
    >
      <Card>
        <CardContent className="pb-0">
          <Rows>
            <SettingRow label="Legal name" description="Only if it differs from the trading name — for invoices, contracts and anyone who asks.">
              <Input {...f('legal_name')} placeholder="Northgate Dental Care Ltd" />
            </SettingRow>
            <SettingRow label="Tagline" description="One line. What you would put under the logo.">
              <Input {...f('tagline')} placeholder="Gentle dentistry in central Leeds" />
            </SettingRow>
            <SettingRow label="Industry" description="Helps the bot judge what is and is not a question about you.">
              <Input {...f('industry')} placeholder="Dental practice" />
            </SettingRow>
          </Rows>
        </CardContent>
        <SaveBar busy={busy} dirty={dirty} onSave={onSave} />
      </Card>
    </Section>
  );
}

// ----------------------------------------------------------------
// Location
// ----------------------------------------------------------------
function LocationSection({ value, onChange, busy, dirty, onSave }: SectionProps<NonNullable<Profile['location']>>) {
  const f = (key: keyof NonNullable<Profile['location']>) => textField(value, onChange, key);
  return (
    <Section
      title="Location"
      description="Where you are, and what someone needs to know before setting off."
    >
      <Card>
        <CardContent className="pb-0">
          <Rows>
            <SettingRow label="Address line 1"><Input {...f('line1')} placeholder="12 Northgate" /></SettingRow>
            <SettingRow label="Address line 2"><Input {...f('line2')} /></SettingRow>
            <SettingRow label="City"><Input {...f('city')} placeholder="Leeds" /></SettingRow>
            <SettingRow label="Region or county"><Input {...f('region')} /></SettingRow>
            <SettingRow label="Postcode"><Input {...f('postal')} placeholder="LS1 4AB" /></SettingRow>
            <SettingRow label="Country"><Input {...f('country')} /></SettingRow>
            <SettingRow
              label="Map link"
              description="Given to visitors as a link rather than read out as an address."
            >
              <Input {...f('map_url')} placeholder="https://maps.app.goo.gl/…" />
            </SettingRow>
            <SettingRow
              label="Areas you serve"
              description="For anyone who comes to the customer rather than the other way round."
              align="start"
            >
              <Input {...f('service_area')} placeholder="Leeds and within 15 miles" />
            </SettingRow>
            <SettingRow label="Parking" align="start">
              <Input {...f('parking')} placeholder="Free parking on Cardigan Street, two minutes away" />
            </SettingRow>
            <SettingRow
              label="Anything else about getting here"
              description="Entrance round the back, second floor, ring the bell — the things people ask twice."
              align="start"
            >
              <Textarea
                rows={3}
                maxLength={MAX_TEXT}
                value={value.notes ?? ''}
                onChange={(e) => onChange({ ...value, notes: e.target.value })}
              />
            </SettingRow>
          </Rows>
        </CardContent>
        <SaveBar busy={busy} dirty={dirty} onSave={onSave} />
      </Card>
    </Section>
  );
}

// ----------------------------------------------------------------
// Hours — the only non-trivial control on this screen
//
// Seven rows, each an open/closed toggle plus one or more time pairs.
// A day with no intervals IS closed: the toggle adds a default pair and
// removing every pair closes the day, so there is one representation of
// "shut on Sunday" rather than two.
// ----------------------------------------------------------------
function HoursSection({ value, onChange, busy, dirty, onSave }: SectionProps<NonNullable<Profile['hours']>>) {
  const regular = value.regular ?? {};
  const exceptions = (value.exceptions ?? []) as ExceptionRow[];

  const setDay = (day: DayKey, spans: HoursInterval[] | undefined) => {
    const next = { ...regular };
    if (spans && spans.length) next[day] = spans;
    else delete next[day];
    onChange({ ...value, regular: Object.keys(next).length ? next : undefined });
  };

  const setException = (i: number, part: Partial<ExceptionRow>) =>
    onChange({ ...value, exceptions: exceptions.map((e, n) => (n === i ? { ...e, ...part } : e)) });

  return (
    <Section
      title="Opening hours"
      description="Fill in the week and your bot can work out whether you are open right now — something it cannot do from a sentence, because it does not know what time it is where you are."
    >
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Time zone</CardTitle>
            <CardDescription>
              Which clock the times below are on. Without it the bot can still read your hours out,
              but it cannot say whether you are open at this moment.
            </CardDescription>
          </div>
          <div className="w-full sm:w-75">
            <Select
              value={value.timezone ?? BROWSER_TZ}
              onValueChange={(v) => onChange({ ...value, timezone: v })}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {TIME_ZONES.map((tz) => <SelectItem key={tz} value={tz}>{tz}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </CardHeader>

        <CardContent>
          <div className="divide-y divide-border">
            {DAYS.map(({ key, label }) => {
              const spans = regular[key] ?? [];
              const open = spans.length > 0;
              return (
                <div key={key} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:gap-6">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Switch
                      checked={open}
                      onCheckedChange={(v) => setDay(key, v ? [{ open: '09:00', close: '17:00' }] : undefined)}
                      aria-label={`${label} open`}
                    />
                    <span className="text-sm font-medium">{label}</span>
                  </div>

                  <div className="w-full space-y-2 sm:w-100">
                    {!open && <p className="py-2 text-sm text-muted">Closed</p>}
                    {spans.map((span, i) => (
                      <div key={i} className="flex items-center gap-2">
                        <Input
                          type="time"
                          className="font-mono text-xs"
                          value={span.open}
                          aria-label={`${label} opens`}
                          onChange={(e) => setDay(key, spans.map((s, n) => (n === i ? { ...s, open: e.target.value } : s)))}
                        />
                        <span className="text-xs text-muted">to</span>
                        <Input
                          type="time"
                          className="font-mono text-xs"
                          value={span.close}
                          aria-label={`${label} closes`}
                          onChange={(e) => setDay(key, spans.map((s, n) => (n === i ? { ...s, close: e.target.value } : s)))}
                        />
                        <Button
                          variant="ghost" size="icon"
                          aria-label={`Remove ${label} hours ${i + 1}`}
                          onClick={() => setDay(key, spans.filter((_, n) => n !== i))}
                        >
                          <Trash2 size={15} />
                        </Button>
                      </div>
                    ))}
                    {open && (
                      <Button
                        variant="outline" size="sm"
                        onClick={() => setDay(key, [...spans, { open: '09:00', close: '17:00' }])}
                      >
                        <Plus size={14} className="mr-1.5" /> Add a second span
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <p className="text-xs leading-relaxed text-muted">
            Two spans on one day is how you say &ldquo;closed for lunch&rdquo;. Spans must not
            overlap, and each one has to end after it starts — the save will tell you which day if
            they do not.
          </p>
        </CardContent>

        <CardContent>
          <div>
            <CardTitle>Dates that are different</CardTitle>
            <CardDescription>
              Bank holidays, a late opening, the week you are closed in August. These win over the
              week above.
            </CardDescription>
          </div>

          <div className="space-y-3 pt-3">
            {exceptions.map((e, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Input
                  type="date"
                  className="w-40 font-mono text-xs"
                  value={e.date}
                  aria-label={`Exception date ${i + 1}`}
                  onChange={(ev) => setException(i, { date: ev.target.value })}
                />
                <div className="flex items-center gap-2">
                  <Switch
                    checked={!e.closed}
                    onCheckedChange={(v) => setException(i, v
                      ? { closed: undefined, open: '09:00', close: '17:00' }
                      : { closed: true, open: undefined, close: undefined })}
                    aria-label={`Open on exception ${i + 1}`}
                  />
                  <span className="text-xs text-muted">{e.closed ? 'Closed' : 'Open'}</span>
                </div>
                {!e.closed && (
                  <>
                    <Input
                      type="time" className="w-28 font-mono text-xs"
                      value={e.open ?? ''}
                      aria-label={`Exception ${i + 1} opens`}
                      onChange={(ev) => setException(i, { open: ev.target.value })}
                    />
                    <span className="text-xs text-muted">to</span>
                    <Input
                      type="time" className="w-28 font-mono text-xs"
                      value={e.close ?? ''}
                      aria-label={`Exception ${i + 1} closes`}
                      onChange={(ev) => setException(i, { close: ev.target.value })}
                    />
                  </>
                )}
                <Input
                  className="min-w-40 flex-1"
                  maxLength={MAX_TEXT}
                  placeholder="Christmas Day"
                  value={e.label ?? ''}
                  aria-label={`Exception ${i + 1} label`}
                  onChange={(ev) => setException(i, { label: ev.target.value })}
                />
                <Button
                  variant="ghost" size="icon"
                  aria-label={`Remove exception ${i + 1}`}
                  onClick={() => onChange({ ...value, exceptions: exceptions.filter((_, n) => n !== i) })}
                >
                  <Trash2 size={15} />
                </Button>
              </div>
            ))}
          </div>

          <div className="flex items-center justify-between gap-4 pt-1">
            <span className="text-xs text-muted">{exceptions.length} of {MAX_EXCEPTIONS} used</span>
            <Button
              variant="outline" size="sm"
              disabled={exceptions.length >= MAX_EXCEPTIONS}
              onClick={() => onChange({
                ...value,
                exceptions: [...exceptions, { date: '', closed: true } as ExceptionRow],
              })}
            >
              <Plus size={14} className="mr-1.5" /> Add a date
            </Button>
          </div>
        </CardContent>

        <CardContent className="pb-0">
          <Rows>
            <SettingRow
              label="Anything else about your hours"
              description="Free text, used as-is. If you have not filled in the week above, this is what the bot is told instead."
              align="start"
            >
              <Textarea
                rows={3}
                maxLength={MAX_TEXT}
                value={value.notes ?? ''}
                placeholder="Closed on bank holidays. Last appointment 30 minutes before closing."
                onChange={(e) => onChange({ ...value, notes: e.target.value })}
              />
            </SettingRow>
          </Rows>
        </CardContent>
        <SaveBar busy={busy} dirty={dirty} onSave={onSave} />
      </Card>
    </Section>
  );
}

// ----------------------------------------------------------------
// Contact
// ----------------------------------------------------------------
function ContactSection({ value, onChange, busy, dirty, onSave }: SectionProps<NonNullable<Profile['contact']>>) {
  const f = (key: keyof NonNullable<Profile['contact']>) => textField(value, onChange, key);
  const socials = (value.socials ?? []) as LinkRow[];

  return (
    <Section
      title="Contact"
      description="Offered when the bot cannot answer, and shown if the widget itself has a problem."
    >
      <Card>
        <CardContent className="pb-0">
          <Rows>
            <SettingRow label="Phone"><Input {...f('phone')} placeholder="0113 555 0100" /></SettingRow>
            <SettingRow label="WhatsApp"><Input {...f('whatsapp')} /></SettingRow>
            <SettingRow label="Email"><Input {...f('email')} placeholder="hello@example.com" /></SettingRow>
            <SettingRow
              label="Support email"
              description="Only if enquiries and support go to different inboxes."
            >
              <Input {...f('support_email')} />
            </SettingRow>
            <SettingRow
              label="Anything else"
              description="Free text. Whatever does not fit the fields above."
              align="start"
            >
              <Textarea
                rows={2}
                maxLength={MAX_TEXT}
                value={value.notes ?? ''}
                onChange={(e) => onChange({ ...value, notes: e.target.value })}
              />
            </SettingRow>
          </Rows>
        </CardContent>

        <CardContent>
          <div>
            <CardTitle>Social profiles</CardTitle>
            <CardDescription>Given out by name, so label them the way you would say them.</CardDescription>
          </div>
          <LinkRows
            rows={socials}
            max={MAX_SOCIALS}
            noun="profile"
            labelPlaceholder="Instagram"
            onChange={(next) => onChange({ ...value, socials: next.length ? next : undefined })}
          />
        </CardContent>
        <SaveBar busy={busy} dirty={dirty} onSave={onSave} />
      </Card>
    </Section>
  );
}

// ----------------------------------------------------------------
// Links
// ----------------------------------------------------------------
function LinksSection({ value, onChange, busy, dirty, onSave }: SectionProps<NonNullable<Profile['links']>>) {
  const f = (key: keyof NonNullable<Profile['links']>) => textField(value, onChange, key);
  const custom = (value.custom ?? []) as LinkRow[];

  return (
    <Section
      title="Links"
      description="The pages you would send someone to rather than describe."
    >
      <Card>
        <CardContent className="pb-0">
          <Rows>
            <SettingRow
              label="Booking"
              description="Also used by lead capture. A booking link set on the Bot Configuration screen overrides this one."
            >
              <Input {...f('booking_url')} placeholder="https://example.com/book" />
            </SettingRow>
            <SettingRow label="Prices"><Input {...f('pricing_url')} /></SettingRow>
            <SettingRow label="Customer portal"><Input {...f('portal_url')} /></SettingRow>
          </Rows>
        </CardContent>

        <CardContent>
          <div>
            <CardTitle>Other links</CardTitle>
            <CardDescription>Anything else worth sending a visitor to.</CardDescription>
          </div>
          <LinkRows
            rows={custom}
            max={MAX_CUSTOM_LINKS}
            noun="link"
            labelPlaceholder="Patient forms"
            onChange={(next) => onChange({ ...value, custom: next.length ? next : undefined })}
          />
        </CardContent>
        <SaveBar busy={busy} dirty={dirty} onSave={onSave} />
      </Card>
    </Section>
  );
}

// ----------------------------------------------------------------
// Policies
// ----------------------------------------------------------------
function PoliciesSection({ value, onChange, busy, dirty, onSave }: SectionProps<NonNullable<Profile['policies']>>) {
  const f = (key: keyof NonNullable<Profile['policies']>) => textField(value, onChange, key);

  return (
    <Section
      title="Policies"
      description="The questions that come up after someone has decided to book."
    >
      <Card>
        <CardContent className="pb-0">
          <Rows>
            <SettingRow label="Payment methods" description="One per row." align="start">
              <LabelRows
                rows={value.payment_methods ?? []}
                max={MAX_LABELS}
                noun="method"
                placeholder="Card"
                onChange={(next) => onChange({ ...value, payment_methods: next.length ? next : undefined })}
              />
            </SettingRow>
            <SettingRow label="Cancellation" align="start">
              <Textarea
                rows={2} maxLength={MAX_TEXT}
                value={value.cancellation ?? ''}
                placeholder="24 hours' notice, or a 30 pound fee applies."
                onChange={(e) => onChange({ ...value, cancellation: e.target.value })}
              />
            </SettingRow>
            <SettingRow label="Deposit"><Input {...f('deposit')} /></SettingRow>
            <SettingRow label="Accessibility" align="start">
              <Textarea
                rows={2} maxLength={MAX_TEXT}
                value={value.accessibility ?? ''}
                placeholder="Step-free entrance, accessible toilet on the ground floor."
                onChange={(e) => onChange({ ...value, accessibility: e.target.value })}
              />
            </SettingRow>
            <SettingRow label="Languages spoken" description="One per row." align="start">
              <LabelRows
                rows={value.languages ?? []}
                max={MAX_LABELS}
                noun="language"
                placeholder="Polish"
                onChange={(next) => onChange({ ...value, languages: next.length ? next : undefined })}
              />
            </SettingRow>
          </Rows>
        </CardContent>
        <SaveBar busy={busy} dirty={dirty} onSave={onSave} />
      </Card>
    </Section>
  );
}

// ----------------------------------------------------------------
// Row editors — the same add/remove shape suggestions and lead_emails
// use on the Bot Configuration screen.
// ----------------------------------------------------------------
function LinkRows({
  rows, max, noun, labelPlaceholder, onChange,
}: {
  rows: LinkRow[]; max: number; noun: string; labelPlaceholder: string;
  onChange: (next: LinkRow[]) => void;
}) {
  return (
    <>
      <div className="space-y-2 pt-3">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              className="w-40"
              maxLength={MAX_TEXT}
              placeholder={labelPlaceholder}
              value={row.label}
              aria-label={`${noun} ${i + 1} label`}
              onChange={(e) => onChange(rows.map((r, n) => (n === i ? { ...r, label: e.target.value } : r)))}
            />
            <Input
              className="flex-1 font-mono text-xs"
              placeholder="https://…"
              value={row.url}
              aria-label={`${noun} ${i + 1} URL`}
              onChange={(e) => onChange(rows.map((r, n) => (n === i ? { ...r, url: e.target.value } : r)))}
            />
            <Button
              variant="ghost" size="icon"
              aria-label={`Remove ${noun} ${i + 1}`}
              onClick={() => onChange(rows.filter((_, n) => n !== i))}
            >
              <Trash2 size={15} />
            </Button>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between gap-4 pt-1">
        <span className="text-xs text-muted">{rows.length} of {max} used</span>
        <Button
          variant="outline" size="sm"
          disabled={rows.length >= max}
          onClick={() => onChange([...rows, { label: '', url: '' }])}
        >
          <Plus size={14} className="mr-1.5" /> Add {noun}
        </Button>
      </div>
    </>
  );
}

function LabelRows({
  rows, max, noun, placeholder, onChange,
}: {
  rows: string[]; max: number; noun: string; placeholder: string;
  onChange: (next: string[]) => void;
}) {
  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            maxLength={MAX_TEXT}
            placeholder={placeholder}
            value={row}
            aria-label={`${noun} ${i + 1}`}
            onChange={(e) => onChange(rows.map((r, n) => (n === i ? e.target.value : r)))}
          />
          <Button
            variant="ghost" size="icon"
            aria-label={`Remove ${noun} ${i + 1}`}
            onClick={() => onChange(rows.filter((_, n) => n !== i))}
          >
            <Trash2 size={15} />
          </Button>
        </div>
      ))}
      <Button
        variant="outline" size="sm"
        disabled={rows.length >= max}
        onClick={() => onChange([...rows, ''])}
      >
        <Plus size={14} className="mr-1.5" /> Add {noun}
      </Button>
    </div>
  );
}
