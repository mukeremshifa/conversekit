// ----------------------------------------------------------------
// Knowledge — one screen for everything the bot knows.
//
// Replaces three nav entries (Knowledge Base, Knowledge Sources,
// Retrieval) that were split by implementation detail rather than by
// what a tenant is trying to do. There is one question here — what
// does this bot know, and how does it find it — and it now has one
// place.
//
// The tabs are real hash routes, not local state. #knowledge,
// #sources and #retrieval are all links someone may have bookmarked,
// and a rename is not a reason to break them; keeping them also makes
// every tab deep-linkable for free.
// ----------------------------------------------------------------
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, Boxes, HelpCircle, Search } from 'lucide-react';
import { endpoints, type Bot, type EffectiveRetrieval } from '@/lib/api';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui';
import { Header } from '@/screens/Providers';
import { FaqEditor } from '@/screens/knowledge/FaqEditor';
import { MissReport } from '@/screens/knowledge/MissReport';
import { Sources } from '@/screens/Sources';
import { Retrieval } from '@/screens/Retrieval';
import { RetrievePreview } from '@/screens/knowledge/RetrievePreview';

export type KnowledgeTab = 'faq' | 'sources' | 'retrieval';

/** Tab id ↔ hash route. The route is the source of truth. */
export const TAB_ROUTES: Record<KnowledgeTab, string> = {
  faq: 'knowledge',
  sources: 'sources',
  retrieval: 'retrieval',
};

const TABS: { id: KnowledgeTab; label: string; icon: typeof HelpCircle }[] = [
  { id: 'faq', label: 'FAQ', icon: HelpCircle },
  { id: 'sources', label: 'Sources', icon: Boxes },
  { id: 'retrieval', label: 'Retrieval', icon: Search },
];

export function Knowledge({
  bot, tab, onNavigate, onSaved,
}: {
  bot: Bot;
  tab: KnowledgeTab;
  onNavigate: (route: string) => void;
  onSaved: (b: Bot) => void;
}) {
  /**
   * A question carried from the miss report on the Retrieval tab to the
   * editor on the FAQ tab. Held here because it crosses tabs — the
   * whole point of the action is that it lands you in the right place
   * with the question already typed.
   *
   * Cleared once the editor has taken it, so switching back to the FAQ
   * tab later does not re-prefill a question already dealt with.
   */
  const [faqDraft, setFaqDraft] = useState<string | null>(null);

  /** What actually governed the last preview search. Lifted out of
   *  RetrievePreview so the settings card below it can show the floor
   *  in force rather than a constant that is wrong for every bot on the
   *  platform embedder. */
  const [effective, setEffective] = useState<EffectiveRetrieval | null>(null);

  function addAsFaq(question: string) {
    setFaqDraft(question);
    onNavigate(TAB_ROUTES.faq);
  }

  return (
    <>
      <Header
        title="Knowledge"
        subtitle="What this bot knows, and how it finds the right piece of it before answering."
      />

      <MigrationBanner bot={bot} onSaved={onSaved} />

      <div role="tablist" aria-label="Knowledge" className="flex gap-1 border-b border-border">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => onNavigate(TAB_ROUTES[id])}
            className={`-mb-px flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === id
                ? 'border-accent text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            <Icon className="h-4 w-4" /> {label}
          </button>
        ))}
      </div>

      {tab === 'faq' && (
        <FaqEditor bot={bot} draftQuestion={faqDraft} onDraftTaken={() => setFaqDraft(null)} />
      )}
      {tab === 'sources' && <Sources bot={bot} embedded />}
      {tab === 'retrieval' && (
        <>
          {/* Above the preview: what visitors actually asked comes
              before what a test query would retrieve. */}
          <MissReport bot={bot} onAddFaq={addAsFaq} />
          <RetrievePreview bot={bot} onEffective={setEffective} />
          <Retrieval bot={bot} onSaved={onSaved} embedded effective={effective} />
        </>
      )}
    </>
  );
}

/**
 * The cutover, offered rather than performed.
 *
 * A bot that predates 011 has its services and FAQ pasted into every
 * system prompt. Moving them into the corpus makes the prompt small
 * and the answers searchable, but it also means the bot stops being
 * guaranteed to see them — so this is a decision someone makes, after
 * checking with the Retrieval tab that their questions still land.
 *
 * Nothing is deleted. The columns stay exactly where they are, which
 * is what makes Undo a single flag flip rather than a restore.
 */
function MigrationBanner({ bot, onSaved }: { bot: Bot; onSaved: (b: Bot) => void }) {
  const [busy, setBusy] = useState(false);
  const [plan, setPlan] = useState<{ faq_items_to_create: number; services: number; faq_notes: number } | null>(null);

  const pending = !bot.knowledge_migrated_at && !!(bot.services?.trim() || bot.faq?.trim());

  useEffect(() => {
    if (!pending) { setPlan(null); return; }
    let live = true;
    endpoints.migratePlan(bot.id)
      .then((r) => { if (live) setPlan(r.plan); })
      // A failed dry run is not worth a toast: the banner still works,
      // it just cannot say how many items it found.
      .catch(() => {});
    return () => { live = false; };
  }, [bot.id, pending]);

  async function migrate() {
    setBusy(true);
    try {
      const result = await endpoints.migrate(bot.id);
      if (result.bot) onSaved(result.bot);
      toast.success(
        result.faq_chunks
          ? `Moved — ${result.faq_chunks} FAQ passage${result.faq_chunks === 1 ? '' : 's'} indexed.`
          : 'Moved into the knowledge base.',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not move this content');
    } finally {
      setBusy(false);
    }
  }

  async function revert() {
    setBusy(true);
    try {
      onSaved(await endpoints.revertMigrate(bot.id));
      toast.success('Reverted — the FAQ is back in the prompt.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not revert');
    } finally {
      setBusy(false);
    }
  }

  if (bot.knowledge_migrated_at) {
    return (
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Using the knowledge base</CardTitle>
            <CardDescription>
              This bot&rsquo;s services and FAQ are searched rather than pasted into every message.
              Your old text is still stored — reverting puts it back in the prompt exactly as it was.
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={revert} disabled={busy}>
            {busy ? 'Working…' : 'Revert'}
          </Button>
        </CardHeader>
      </Card>
    );
  }

  if (!pending) return null;

  return (
    <Card className="border-accent/40">
      <CardHeader>
        <div>
          <CardTitle>Move your old FAQ and services here</CardTitle>
          <CardDescription>
            They are currently pasted into every single message this bot sends, which costs tokens on
            every turn and crowds out the conversation. Moving them means they are searched instead —
            and the FAQ becomes an editable list rather than one text box.
            {plan && (
              <>
                {' '}This would create{' '}
                <strong>{plan.faq_items_to_create} FAQ item{plan.faq_items_to_create === 1 ? '' : 's'}</strong>
                {plan.services > 0 && <> and a <strong>Services</strong> source</>}
                {plan.faq_notes > 0 && <> plus a <strong>FAQ notes</strong> source for the text that is not a question</>}.
              </>
            )}
            <br />
            Nothing is deleted, and you can put it back in one click.
          </CardDescription>
        </div>
        <Button onClick={migrate} disabled={busy}>
          {busy ? 'Moving…' : <>Move it <ArrowRight className="h-3.5 w-3.5" /></>}
        </Button>
      </CardHeader>
      <CardContent className="pt-0">
        <p className="text-xs text-muted">
          Check the Retrieval tab first — &ldquo;What would this retrieve?&rdquo; lets you ask a real
          question and see what comes back before you commit.
        </p>
      </CardContent>
    </Card>
  );
}

/** Which tab a hash route means. Unknown routes never reach here, so
 *  the fallback is only a type narrowing. */
export function knowledgeTabFor(route: string): KnowledgeTab {
  return (Object.keys(TAB_ROUTES) as KnowledgeTab[]).find((k) => TAB_ROUTES[k] === route) ?? 'faq';
}
