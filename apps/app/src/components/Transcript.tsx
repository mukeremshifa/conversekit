// ----------------------------------------------------------------
// One session's messages, rendered as a chat.
//
// Lifted out of Conversations.tsx when the Leads screen grew a "view
// the conversation" drawer. Two copies of the bubble markup would have
// drifted the first time either screen was restyled, and the visitor's
// side being on the right is the kind of detail that is obviously wrong
// once the two disagree.
// ----------------------------------------------------------------
import type { Message } from '@/lib/api';

/**
 * The API returns newest-first. A transcript only reads correctly
 * oldest-first, so the ordering is fixed here rather than at each call
 * site — one screen forgetting to reverse is a silent bug that looks
 * like the bot answering before it was asked.
 */
export function orderedForReading(messages: Message[]): Message[] {
  return [...messages].reverse();
}

/** Groups a flat, newest-first list into sessions, newest session first. */
export function groupBySession(messages: Message[]): [string, Message[]][] {
  const grouped = new Map<string, Message[]>();
  for (const m of orderedForReading(messages)) {
    const list = grouped.get(m.session_id) ?? [];
    list.push(m);
    grouped.set(m.session_id, list);
  }
  return [...grouped.entries()].reverse();
}

/** @param messages Already oldest-first — pass `orderedForReading(...)`. */
export function Transcript({ messages }: { messages: Message[] }) {
  return (
    <div className="space-y-2">
      {messages.map((m) => (
        <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
          <div
            className={
              m.role === 'user'
                ? 'max-w-[80%] rounded-2xl rounded-br-sm bg-fg/8 px-3.5 py-2 text-[13px] leading-relaxed text-fg'
                : 'max-w-[80%] rounded-2xl rounded-bl-sm border border-border bg-bg px-3.5 py-2 text-[13px] leading-relaxed'
            }
          >
            <p className="whitespace-pre-wrap break-words">{m.content}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
