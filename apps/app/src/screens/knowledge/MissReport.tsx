// ----------------------------------------------------------------
// "Questions your bot could not answer"
//
// The half of retrieval logging a tenant actually wants. Everything
// else on this screen answers "what does my bot know"; this answers
// "what does it not", from real visitors rather than from a test query
// someone thought to type.
//
// It is also the loop that closes, and it closes both ways. A question
// worth answering gets Add as FAQ, which drops into the FAQ editor with
// the question already filled in. A question not worth answering gets
// removed, because a list that only ever grows stops being read, and
// most of what lands here is a typo or a visitor testing the widget.
//
// Presentational since the redesign: the fetch, the range and the miss
// numbers live on the Retrieval screen, which shows them as cards above
// everything else. This renders the list.
// ----------------------------------------------------------------
import { useState } from 'react';
import { toast } from 'sonner';
import { MessageCircleQuestion, Plus, Trash2 } from 'lucide-react';
import { endpoints, type Bot, type MissQuestion, type MissReport as Report } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Button, Card, CardContent, EmptyState, Muted, RowsSkeleton } from '@/components/ui';

export function MissReport({
  bot, report, unavailable, onAddFaq, onChanged,
}: {
  bot: Bot;
  /** Null while the report is still loading. */
  report: Report | null;
  /** Set when the endpoint is unavailable rather than empty. The two
   *  look identical in a bare list and mean opposite things. */
  unavailable: string | null;
  /** Hand a question to the FAQ editor, prefilled. */
  onAddFaq: (question: string) => void;
  /** Reload the report after a question is removed, so the cards above
   *  agree with the list below. */
  onChanged: () => void;
}) {
  const [removing, setRemoving] = useState<string | null>(null);

  async function remove(q: MissQuestion) {
    if (!confirm(`Remove “${q.text}” from this list?`)) return;
    setRemoving(q.text);
    try {
      await endpoints.deleteMissedQuestion(bot.id, q.text);
      toast.success('Question removed');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not remove that question');
    } finally {
      setRemoving(null);
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        {unavailable ? (
          <Muted className="text-sm">{unavailable}</Muted>
        ) : report === null ? (
          // The question and its count, with Add as FAQ and the bin
          // beside them.
          <RowsSkeleton rows={3} lines={2} actions={['button', 'icon']} />
        ) : report.totals.queries === 0 ? (
          <EmptyState
            icon={MessageCircleQuestion}
            title="No searches yet"
            description="Once visitors start asking this bot questions, the ones it could not answer show up here, with how often each was asked and a one-click way to turn it into an FAQ entry."
          />
        ) : report.questions.length === 0 ? (
          <Muted className="text-sm">
            Every search in this period found something. Nothing to write.
          </Muted>
        ) : (
          <>
            <div className="divide-y divide-border">
              {report.questions.map((q) => (
                <div key={q.text} className="flex items-start gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-[13px] font-medium leading-relaxed">{q.text}</p>
                    <p className="mt-0.5 text-xs text-muted">
                      asked {q.count} time{q.count === 1 ? '' : 's'} · last {formatDate(q.lastAsked)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button variant="outline" size="sm" onClick={() => onAddFaq(q.text)}>
                      <Plus className="h-3.5 w-3.5" /> Add as FAQ
                    </Button>
                    <Button
                      variant="ghost" size="icon"
                      onClick={() => void remove(q)}
                      disabled={removing === q.text}
                      aria-label={`Remove “${q.text}” from the list`}
                      title="Remove from the list"
                    >
                      <Trash2 size={15} />
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            <Channels report={report} />

            {report.truncated && (
              <Muted className="mt-3 text-xs">
                This bot logged more searches than one report can read, so the counts below the top
                few are partial. Choose a shorter period for exact numbers.
              </Muted>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * How the searches that DID land were answered.
 *
 * A footnote rather than a card, because it is context for the list
 * rather than a number to steer by. The merged search is counted
 * separately on purpose: those turns were answered by both methods at
 * once, and the typical-match figure in the cards above deliberately
 * excludes them, since a keyword rank averaged into a similarity median
 * is not a measurement.
 */
function Channels({ report }: { report: Report }) {
  const { lexical, hybrid, faqDirect } = report.channels;
  if (!lexical && !hybrid && !faqDirect) return null;

  return (
    <p className="mt-4 flex flex-wrap gap-x-3 gap-y-1 border-t border-border pt-3 text-xs text-muted">
      {lexical > 0 && (
        <span><strong className="text-ink tabular-nums">{lexical}</strong> rescued by keyword search</span>
      )}
      {hybrid > 0 && (
        <span><strong className="text-ink tabular-nums">{hybrid}</strong> answered by the combined search</span>
      )}
      {faqDirect > 0 && (
        <span><strong className="text-ink tabular-nums">{faqDirect}</strong> answered straight from your FAQ</span>
      )}
    </p>
  );
}
