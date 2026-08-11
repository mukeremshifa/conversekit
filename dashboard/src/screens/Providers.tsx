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
import { CircleAlert, KeyRound } from 'lucide-react';
import { endpoints, type Bot, type Vendor, type VendorConfig } from '@/lib/api';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  Field, Input, ListSkeleton, Muted, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui';

const TIER_TONE = { 'free-tier': 'ok', local: 'neutral', paid: 'wait' } as const;

/** The chunks column is vector(768). These vendors can be asked for a
 *  narrower vector than their native width; the rest cannot, so their
 *  output has to already be 768 or ingestion will reject it. */
const CAN_TRUNCATE = new Set(['openai', 'google']);
const REQUIRED_DIMENSIONS = 768;
const TIER_LABEL = { 'free-tier': 'free tier', local: 'local', paid: 'paid' } as const;

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

  if (!vendors) {
    return <ListSkeleton rows={4} />;
  }

  const embedVendors = vendors.filter((v) => v.supportsEmbeddings);

  return (
    <>
      <Header
        title="AI Providers"
        subtitle="Which model answers, and which one embeds. Leave a field blank to inherit the platform default."
        action={<Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</Button>}
      />

      <VendorCard
        title="Chat model"
        description="Generates the replies visitors see."
        vendors={vendors}
        config={chat}
        onChange={setChat}
      />

      <VendorCard
        title="Embedding model"
        description="Turns your knowledge sources into vectors for retrieval. Changing this requires re-indexing every source."
        vendors={embedVendors}
        config={embed}
        onChange={setEmbed}
        showDimensions
      />
    </>
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
  title, description, vendors, config, onChange, showDimensions,
}: {
  title: string;
  description: string;
  vendors: Vendor[];
  config: VendorConfig;
  onChange: (c: VendorConfig) => void;
  showDimensions?: boolean;
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
        <Field label="Vendor" hint="blank = platform default">
          <Select value={config.vendor ?? ''} onValueChange={(v) => set({ vendor: v, model: undefined })}>
            <SelectTrigger><SelectValue placeholder="Platform default" /></SelectTrigger>
            <SelectContent>
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
        <h1 className="font-display text-[22px] leading-tight">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
