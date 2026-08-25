// ----------------------------------------------------------------
// FAQ editor
//
// The discrete, editable half of the knowledge unification. What used
// to be one textarea of `Q: … / A: …` text is now a list of rows, and
// the difference matters for a reason that is not cosmetic: each item
// becomes exactly one chunk, embedded with its question attached, so
// retrieval matches a visitor's phrasing against the question a tenant
// actually wrote rather than against an arbitrary 800-character window
// of prose.
//
// Every save re-indexes the whole FAQ in the background. The document
// row's status is the progress indicator, which is why this screen
// polls it the same way Sources does.
// ----------------------------------------------------------------
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, HelpCircle, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { endpoints, type Bot, type Doc, type FaqItem } from '@/lib/api';
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle,
  EmptyState, Field, Input, Muted, RowsSkeleton, Switch, Textarea,
} from '@/components/ui';

const STATUS = {
  pending:    { tone: 'wait' as const, label: 'queued' },
  processing: { tone: 'wait' as const, label: 'indexing…' },
  ready:      { tone: 'ok' as const,   label: 'indexed' },
  failed:     { tone: 'bad' as const,  label: 'failed' },
};

/** Mirrors LIMITS in src/config.ts. The Worker stays the authority;
 *  these exist so a mistake is caught while it is being typed. */
const FALLBACK_LIMITS = { items: 200, question: 300, answer: 2000 };

export function FaqEditor({
  bot, draftQuestion = null, onDraftTaken,
}: {
  bot: Bot;
  /**
   * A question handed over from the miss report — something a visitor
   * actually asked that the bot could not answer. Fills the Question
   * field so the tenant only has to write the answer, which is the
   * whole point of the loop: seeing the gap and closing it are one
   * action rather than two screens and a copy-paste.
   */
  draftQuestion?: string | null;
  /** Called once the draft has been taken, so returning to this tab
   *  later does not re-fill a question already dealt with. */
  onDraftTaken?: () => void;
}) {
  const [items, setItems] = useState<FaqItem[] | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [limits, setLimits] = useState(FALLBACK_LIMITS);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await endpoints.faq(bot.id);
      setItems(res.items);
      setDoc(res.document);
      if (res.limits) setLimits(res.limits);

      // Indexing is asynchronous, so poll while it is in flight — and
      // stop the moment it is not, rather than polling forever.
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      if (res.document && (res.document.status === 'pending' || res.document.status === 'processing')) {
        timer.current = window.setTimeout(load, 3000);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not load the FAQ');
    }
  }, [bot.id]);

  useEffect(() => {
    setItems(null);
    setEditing(null);
    void load();
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [load]);

  async function add(question: string, answer: string) {
    setBusy(true);
    try {
      await endpoints.addFaqItem(bot.id, { question, answer });
      toast.success('Added — indexing now');
      await load();
      return true;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add that item');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(item: FaqItem, question: string, answer: string) {
    setBusy(true);
    try {
      await endpoints.updateFaqItem(item.id, { question, answer });
      setEditing(null);
      toast.success('Saved — reindexing');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not save that item');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Optimistic, unlike every other write here. A toggle that waits for
   * a round trip before moving reads as broken, and the cost of being
   * wrong is one switch snapping back — which `load` does anyway.
   */
  async function toggle(item: FaqItem, enabled: boolean) {
    setItems((prev) => prev?.map((i) => (i.id === item.id ? { ...i, enabled } : i)) ?? prev);
    try {
      await endpoints.updateFaqItem(item.id, { enabled });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not change that item');
      void load();
    }
  }

  async function remove(item: FaqItem) {
    if (!confirm(`Delete “${item.question}”?`)) return;
    try {
      await endpoints.deleteFaqItem(item.id);
      toast.success('Deleted');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not delete that item');
    }
  }

  async function move(index: number, by: -1 | 1) {
    if (!items) return;
    const target = index + by;
    if (target < 0 || target >= items.length) return;

    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next);
    try {
      await endpoints.reorderFaq(bot.id, next.map((i) => i.id));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not reorder');
      void load();
    }
  }

  const enabled = items?.filter((i) => i.enabled).length ?? 0;

  return (
    <>
      <AddFaqItem
        limits={limits}
        disabled={busy || (items?.length ?? 0) >= limits.items}
        onAdd={add}
        draftQuestion={draftQuestion}
        onDraftTaken={onDraftTaken}
      />

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Questions and answers</CardTitle>
            <CardDescription>
              {items?.length
                ? `${items.length} of ${limits.items} used, ${enabled} switched on`
                : 'Nothing here yet.'}
              {doc?.status && (
                <> · <Badge tone={STATUS[doc.status].tone}>{STATUS[doc.status].label}</Badge></>
              )}
              {doc?.status === 'failed' && doc.error && (
                <span className="mt-1 block text-danger">{doc.error}</span>
              )}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </CardHeader>
        <CardContent>
          {items === null ? (
            // A question over its answer, with the row's four icon
            // buttons out to the right — the shape FaqRow renders.
            <RowsSkeleton rows={3} lines={2} row="gap-4 py-4" actions={['icon', 'icon', 'icon', 'icon']} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={HelpCircle}
              title="No questions yet"
              description="Add the questions visitors actually ask. Each one is indexed on its own, so the bot matches a visitor's wording against yours instead of hunting through a wall of text."
              action={{ label: 'Add a question', onClick: () => document.getElementById('ck-faq-question')?.focus() }}
            />
          ) : (
            <div className="divide-y divide-border">
              {items.map((item, i) => (
                <FaqRow
                  key={item.id}
                  item={item}
                  limits={limits}
                  editing={editing === item.id}
                  busy={busy}
                  first={i === 0}
                  last={i === items.length - 1}
                  onEdit={() => setEditing(item.id)}
                  onCancel={() => setEditing(null)}
                  onSave={(q, a) => save(item, q, a)}
                  onToggle={(v) => toggle(item, v)}
                  onRemove={() => remove(item)}
                  onMove={(by) => move(i, by)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function AddFaqItem({
  limits, disabled, onAdd, draftQuestion = null, onDraftTaken,
}: {
  limits: { items: number; question: number; answer: number };
  disabled: boolean;
  onAdd: (q: string, a: string) => Promise<boolean>;
  draftQuestion?: string | null;
  onDraftTaken?: () => void;
}) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');

  // Prefill from the miss report, then hand focus to the Answer field —
  // the question is already written, and the cursor should be where the
  // work is. Truncated to the limit rather than rejected: a visitor's
  // question is not obliged to fit, and losing it here would undo the
  // one action this whole loop exists for.
  useEffect(() => {
    if (!draftQuestion) return;
    setQuestion(draftQuestion.slice(0, limits.question));
    onDraftTaken?.();
    document.getElementById('ck-faq-answer')?.focus();
  }, [draftQuestion, limits.question, onDraftTaken]);

  async function submit() {
    if (!question.trim() || !answer.trim()) {
      toast.error('A question and an answer are both required');
      return;
    }
    if (await onAdd(question.trim(), answer.trim())) {
      setQuestion('');
      setAnswer('');
    }
  }

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Add a question</CardTitle>
          <CardDescription>
            Write the question the way a visitor would ask it, not the way you would title it —
            that phrasing is what the search matches against.
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <Field label="Question" hint={`${question.length} / ${limits.question}`}>
          <Input
            id="ck-faq-question"
            maxLength={limits.question}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Do you accept insurance?"
          />
        </Field>
        <Field label="Answer" hint={`${answer.length} / ${limits.answer}`}>
          <Textarea
            id="ck-faq-answer"
            rows={4}
            maxLength={limits.answer}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Yes — we work with most major providers. Bring your card to your first visit."
          />
        </Field>
        <Button onClick={submit} disabled={disabled}>
          <Plus className="h-3.5 w-3.5" /> Add and index
        </Button>
        {disabled && (
          <Muted className="mt-2 text-xs">
            You have reached the {limits.items}-item limit. Longer material belongs in Sources, where
            it is chunked automatically.
          </Muted>
        )}
      </CardContent>
    </Card>
  );
}

function FaqRow({
  item, limits, editing, busy, first, last,
  onEdit, onCancel, onSave, onToggle, onRemove, onMove,
}: {
  item: FaqItem;
  limits: { question: number; answer: number };
  editing: boolean;
  busy: boolean;
  first: boolean;
  last: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (question: string, answer: string) => void;
  onToggle: (enabled: boolean) => void;
  onRemove: () => void;
  onMove: (by: -1 | 1) => void;
}) {
  const [question, setQuestion] = useState(item.question);
  const [answer, setAnswer] = useState(item.answer);

  // Reset the draft whenever the row leaves edit mode, so Cancel
  // really is a cancel rather than a hidden pending change.
  useEffect(() => {
    if (!editing) { setQuestion(item.question); setAnswer(item.answer); }
  }, [editing, item.question, item.answer]);

  if (editing) {
    return (
      <div className="py-4">
        <Field label="Question" hint={`${question.length} / ${limits.question}`}>
          <Input maxLength={limits.question} value={question} onChange={(e) => setQuestion(e.target.value)} />
        </Field>
        <Field label="Answer" hint={`${answer.length} / ${limits.answer}`}>
          <Textarea rows={4} maxLength={limits.answer} value={answer} onChange={(e) => setAnswer(e.target.value)} />
        </Field>
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => onSave(question.trim(), answer.trim())}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="outline" size="sm" onClick={onCancel}>
            <X className="h-3.5 w-3.5" /> Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-start gap-4 py-4 ${item.enabled ? '' : 'opacity-55'}`}>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{item.question}</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-muted">
          {item.answer}
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost" size="icon"
          onClick={() => onMove(-1)} disabled={first}
          aria-label={`Move “${item.question}” up`}
        >
          <ArrowUp size={15} />
        </Button>
        <Button
          variant="ghost" size="icon"
          onClick={() => onMove(1)} disabled={last}
          aria-label={`Move “${item.question}” down`}
        >
          <ArrowDown size={15} />
        </Button>
        <Button variant="ghost" size="icon" onClick={onEdit} aria-label={`Edit “${item.question}”`}>
          <Pencil size={15} />
        </Button>
        <Button
          variant="ghost" size="icon" className="text-danger"
          onClick={onRemove} aria-label={`Delete “${item.question}”`}
        >
          <Trash2 size={15} />
        </Button>
        <Switch
          className="ml-2"
          checked={item.enabled}
          onCheckedChange={onToggle}
          aria-label={`Include “${item.question}” in answers`}
        />
      </div>
    </div>
  );
}
