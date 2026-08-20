// ----------------------------------------------------------------
// AI Providers
//
// The screen that finally exposes the Phase 0 adapter. Chat and
// embedding vendors are configured separately on purpose: a tenant
// will often want a strong hosted chat model alongside cheap local
// embeddings, and re-embedding a whole corpus just to follow a
// chat-model change would be pointless.
// ----------------------------------------------------------------
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, CircleAlert, KeyRound, Plug, XCircle } from 'lucide-react';
import { endpoints, type Bot, type ProviderTest, type Vendor, type VendorConfig } from '@/lib/api';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Field, FormCardSkeleton, Input, Muted, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui';

const TIER_TONE = { 'free-tier': 'ok', local: 'neutral', paid: 'wait' } as const;

/** The chunks column is vector(768). These vendors can be asked for a
 *  narrower vector than their native width; the rest cannot, so their
 *  output has to already be 768 or ingestion will reject it. */
const CAN_TRUNCATE = new Set(['openai', 'google']);
const REQUIRED_DIMENSIONS = 768;
const TIER_LABEL = { 'free-tier': 'free tier', local: 'local', paid: 'paid' } as const;

/**
 * "Inherit the platform default" as a selectable option.
 *
 * The placeholder alone was not one: it shows only while nothing has
 * been chosen, so once a tenant picked a vendor there was no way back
 * to blank and the card's own instruction — "leave a field blank to
 * inherit the platform default" — could not be followed. Radix forbids
 * an empty-string item value, hence a sentinel that maps back to no
 * config at all.
 */
const PLATFORM_DEFAULT = '__platform__';

/** Each card's copy, shared with the skeleton that stands in for it
 *  while the vendor list is in flight, so the two cannot drift. */
const CHAT_CARD = {
  title: 'Chat model',
  description: 'Generates the replies visitors see.',
};
const EMBED_CARD = {
  title: 'Embedding model',
  description: 'Turns your knowledge sources into vectors for retrieval. Changing this requires re-indexing every source.',
};

export function Providers({ bot, onSaved }: { bot: Bot; onSaved: (b: Bot) => void }) {
  const [vendors, setVendors] = useState<Vendor[] | null>(null);
  const [chat, setChat] = useState<VendorConfig>({});
  const [embed, setEmbed] = useState<VendorConfig>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    endpoints.vendors()
      .then((r) => setVendors(r.vendors))
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Could not load vendors'));
  }, []);

  useEffect(() => {
    setChat(bot.provider_config ?? {});
    setEmbed(bot.embedding_config ?? {});
  }, [bot.id, bot.provider_config, bot.embedding_config]);

  async function save() {
    setBusy(true);
    try {
      // Only send apiKey when the user actually typed one. An absent
      // key means "keep what is stored" — the API never returns it.
      const updated = await endpoints.updateBot(bot.id, {
        provider_config:  clean(chat),
        embedding_config: clean(embed),
      });
      onSaved(updated);
      toast.success('Providers saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  // Only the vendor list is being waited on, so only the two forms that
  // need it stand in. The heading and the test card — which reads the
  // saved bot, not the list — are real from the first paint. Replacing
  // the whole screen with a stack of tiles threw the heading away and
  // previewed a shape this screen never renders.
  //
  // A bot on the platform default shows the vendor picker alone; one
  // with a vendor of its own also has a model, a key and a setting or
  // two under it, and that is known from the bot before the list lands.
  const fields = (cfg: VendorConfig | null | undefined) => (cfg?.vendor ? 4 : 1);

  return (
    <>
      <Header
        title="AI Providers"
        subtitle="Which model answers, and which one embeds. Leave a field blank to inherit the platform default."
        action={
          <Button onClick={save} disabled={busy || !vendors}>{busy ? 'Saving…' : 'Save changes'}</Button>
        }
      />

      {vendors ? (
        <VendorCard
          {...CHAT_CARD}
          vendors={vendors}
          config={chat}
          onChange={setChat}
          storedKey={!!bot.provider_config?.hasApiKey}
        />
      ) : (
        <FormCardSkeleton {...CHAT_CARD} fields={fields(bot.provider_config)} />
      )}

      <TestConnection bot={bot} />

      {vendors ? (
        <VendorCard
          {...EMBED_CARD}
          vendors={vendors.filter((v) => v.supportsEmbeddings)}
          config={embed}
          onChange={setEmbed}
          showDimensions
          storedKey={!!bot.embedding_config?.hasApiKey}
        />
      ) : (
        <FormCardSkeleton {...EMBED_CARD} fields={fields(bot.embedding_config)} />
      )}
    </>
  );
}

/**
 * Does this vendor actually work — and does it report token counts.
 *
 * Before this, a wrong BYOK key was discovered by a real visitor's turn
 * failing, which is the worst place for anyone to find out. One
 * five-token prompt against the SAVED configuration answers it for
 * roughly nothing.
 *
 * `reportsUsage` is the second answer and the less obvious one. Three
 * of the four adapter paths on the platform default report no usage at
 * all, so a tenant looking at an "80% estimated" figure on the Usage
 * screen has no way to find out which of their providers is the silent
 * one. This is that way.
 *
 * Tests what is STORED, not what is typed above — an unsaved key has
 * not been sent anywhere, and testing the draft would report a pass on
 * a configuration the bot is not running.
 */
function TestConnection({ bot }: { bot: Bot }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ProviderTest | null>(null);

  // A saved change makes any previous verdict describe a configuration
  // that is no longer in force.
  useEffect(() => { setResult(null); }, [bot.provider_config]);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      setResult(await endpoints.testProvider(bot.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reach the provider test');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Test connection</CardTitle>
          <CardDescription>
            Sends one tiny prompt to the saved chat provider. Confirms the key works, and
            tells you whether this vendor reports token counts — which decides how much of
            your Usage screen is measured rather than estimated.
          </CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={run} disabled={busy}>
          <Plug className="h-3.5 w-3.5" /> {busy ? 'Testing…' : 'Test connection'}
        </Button>
      </CardHeader>
      <CardContent>
        {!result ? (
          <Muted className="text-xs">Not tested yet.</Muted>
        ) : result.ok ? (
          <div className="space-y-2">
            <p className="flex items-center gap-2 text-sm font-semibold text-success">
              <CheckCircle2 className="h-4 w-4" />
              {result.vendor} · {result.model} replied in {result.latencyMs} ms
            </p>
            <p className="text-xs text-muted">
              {result.reportsUsage ? (
                <>
                  Reports token counts
                  {result.usage.inputTokens !== null && <> ({result.usage.inputTokens} in
                    {result.usage.outputTokens !== null && <>, {result.usage.outputTokens} out</>})</>}
                  {' '}— your chat usage will be measured, not estimated.
                </>
              ) : (
                <>
                  Does <strong>not</strong> report token counts, so chat usage from this
                  vendor is estimated from text length. That is expected for local servers
                  and for streamed replies on some vendors.
                </>
              )}
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="flex items-center gap-2 text-sm font-semibold text-danger">
              <XCircle className="h-4 w-4" /> Failed{result.kind ? ` (${result.kind})` : ''}
            </p>
            <p className="break-words text-xs text-muted">{result.error}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function clean(cfg: VendorConfig): VendorConfig | null {
  const out: VendorConfig = { ...cfg };
  // Display-only fields must never be written back into the JSONB.
  delete out.hasApiKey;
  delete out.apiKeyLast4;
  if (!out.apiKey?.trim()) delete out.apiKey;
  for (const k of ['vendor', 'model', 'baseUrl'] as const) {
    if (!out[k]) delete out[k];
  }
  return Object.keys(out).length ? out : null;
}

function VendorCard({
  title, description, vendors, config, onChange, showDimensions, storedKey,
}: {
  title: string;
  description: string;
  vendors: Vendor[];
  config: VendorConfig;
  onChange: (c: VendorConfig) => void;
  showDimensions?: boolean;
  /** Whether the SAVED bot has a key for this slot. Local state cannot
   *  answer it: picking the platform default empties the config, which
   *  is exactly when the warning needs to appear. */
  storedKey?: boolean;
}) {
  const selected = vendors.find((v) => v.id === config.vendor);
  const set = (patch: Partial<VendorConfig>) => onChange({ ...config, ...patch });

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <Field label="Vendor" hint="pick Platform default to hand it back">
          <Select
            value={config.vendor ?? PLATFORM_DEFAULT}
            onValueChange={(v) => (v === PLATFORM_DEFAULT
              // Reset to {} rather than deleting `vendor`, because the
              // server MERGES an incoming config over the stored one
              // (mergeConfigs, src/supabase.ts) — a partial object
              // would leave the old vendor in place. An empty object is
              // what clean() turns into the explicit null that clears
              // the column, key included.
              ? onChange({})
              : set({ vendor: v, model: undefined }))}
          >
            <SelectTrigger><SelectValue placeholder="Platform default" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={PLATFORM_DEFAULT}>Platform default</SelectItem>
              {vendors.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  <span className="flex items-center gap-2">
                    {v.label}
                    <Badge tone={TIER_TONE[v.costTier]}>{TIER_LABEL[v.costTier]}</Badge>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {selected && (
          <>
            <Field label="Model" hint={`default: ${showDimensions ? selected.defaultEmbedModel : selected.defaultChatModel}`}>
              <Input
                value={config.model ?? ''}
                onChange={(e) => set({ model: e.target.value })}
                placeholder={(showDimensions ? selected.defaultEmbedModel : selected.defaultChatModel) ?? ''}
              />
            </Field>

            {selected.requiresBaseUrl && (
              <Field label="Base URL" hint="required for this vendor">
                <Input
                  value={config.baseUrl ?? ''}
                  onChange={(e) => set({ baseUrl: e.target.value })}
                  placeholder="http://localhost:11434/v1"
                />
              </Field>
            )}

            {selected.requiresKey && (
              <Field
                label="API key"
                hint={config.hasApiKey ? `stored — ends ••••${config.apiKeyLast4 ?? ''}` : undefined}
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={config.apiKey ?? ''}
                  onChange={(e) => set({ apiKey: e.target.value })}
                  placeholder={config.hasApiKey ? 'Leave blank to keep the stored key' : 'sk-…'}
                />
              </Field>
            )}

            {selected.requiresKey && !config.hasApiKey && !config.apiKey && (
              <Notice
                tone={selected.keyConfigured ? 'info' : 'warn'}
                text={
                  selected.keyConfigured
                    ? 'No key stored for this bot — the platform key will be used.'
                    : 'No key stored for this bot and none configured on the platform. Calls to this vendor will fail.'
                }
              />
            )}

            {showDimensions && selected.embedDimensions != null
              && selected.embedDimensions !== REQUIRED_DIMENSIONS
              && !CAN_TRUNCATE.has(selected.id) && (
              <Notice
                tone="warn"
                text={`${selected.label} embeddings are ${selected.embedDimensions}-dimensional and cannot be narrowed. This deployment stores ${REQUIRED_DIMENSIONS}, so indexing will fail. Pick a ${REQUIRED_DIMENSIONS}-dimension vendor.`}
              />
            )}

            {showDimensions && (
              <Field label="Dimensions" hint="must be 768 — the vector column is fixed width">
                <Input
                  type="number"
                  value={config.dimensions ?? ''}
                  onChange={(e) => set({ dimensions: e.target.value ? Number(e.target.value) : undefined })}
                  placeholder="768"
                />
              </Field>
            )}

            {!showDimensions && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Max tokens" hint="optional">
                  <Input
                    type="number"
                    value={config.maxTokens ?? ''}
                    onChange={(e) => set({ maxTokens: e.target.value ? Number(e.target.value) : undefined })}
                    placeholder="1024"
                  />
                </Field>
                <Field label="Temperature" hint="0–1, optional">
                  <Input
                    type="number" step="0.1" min="0" max="1"
                    value={config.temperature ?? ''}
                    onChange={(e) => set({ temperature: e.target.value ? Number(e.target.value) : undefined })}
                    placeholder="0.7"
                  />
                </Field>
              </div>
            )}
          </>
        )}

        {!selected && (
          <Muted className="flex items-center gap-2 text-xs">
            <KeyRound className="h-3.5 w-3.5" />
            Using the platform default vendor and key.
            {storedKey && ' Saving now also removes the key stored on this bot.'}
          </Muted>
        )}
      </CardContent>
    </Card>
  );
}

function Notice({ tone, text }: { tone: 'info' | 'warn'; text: string }) {
  return (
    <p className={`flex items-start gap-2 text-xs ${tone === 'warn' ? 'text-danger' : 'text-muted'}`}>
      <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      {text}
    </p>
  );
}

export function Header({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="font-display text-[26px] leading-tight">{title}</h1>
        {subtitle && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
