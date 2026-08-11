// ----------------------------------------------------------------
// Command palette (Cmd/Ctrl-K).
//
// Built on the Radix Dialog already in the bundle rather than a
// dedicated cmdk dependency — the matching here is a substring test over
// a list that is never longer than a few dozen entries, and Radix
// already handles the focus trap, the escape key and the overlay.
//
// Navigation, bot switching and a couple of actions live in one list so
// there is a single thing to learn.
// ----------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Check, CornerDownLeft, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { NavItem } from '@/components/Shell';
import type { Bot } from '@/lib/api';
import { cn } from '@/lib/utils';

export interface Command {
  id: string;
  label: string;
  group: string;
  icon?: LucideIcon;
  hint?: string;
  active?: boolean;
  run: () => void;
}

/** Substring match across the label and its group, so "lead" finds
 *  "Leads" and "bot" finds every bot under "Switch bot". */
function match(commands: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase();
  if (!q) return commands;
  return commands.filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(q));
}

export function useCommandPalette() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return { open, setOpen };
}

export function buildCommands(opts: {
  nav: NavItem[];
  route: string;
  bots: Bot[];
  botId: string;
  onNavigate: (route: string) => void;
  onSelectBot: (id: string) => void;
  onNewBot: () => void;
  onCycleTheme: () => void;
}): Command[] {
  const { nav, route, bots, botId, onNavigate, onSelectBot, onNewBot, onCycleTheme } = opts;
  return [
    ...nav.map((n): Command => ({
      id: `go:${n.id}`, group: 'Go to', label: n.label, icon: n.icon,
      active: route === n.id, run: () => onNavigate(n.id),
    })),
    ...bots.map((b): Command => ({
      id: `bot:${b.id}`, group: 'Switch bot', label: b.name,
      active: b.id === botId, run: () => onSelectBot(b.id),
    })),
    { id: 'act:new-bot', group: 'Actions', label: 'Create a bot', run: onNewBot },
    { id: 'act:theme', group: 'Actions', label: 'Change theme', run: onCycleTheme },
  ];
}

export function CommandPalette({
  open, onOpenChange, commands,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: Command[];
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => match(commands, query), [commands, query]);

  // A stale highlight after filtering would run the wrong command.
  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => { if (!open) setQuery(''); }, [open]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const cmd = results[index];
      if (cmd) { cmd.run(); onOpenChange(false); }
    }
  }

  // Group headings, in the order the groups first appear.
  const groups: { name: string; items: Command[] }[] = [];
  for (const c of results) {
    const g = groups.find((x) => x.name === c.group);
    if (g) g.items.push(c);
    else groups.push({ name: c.group, items: [c] });
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Content
          onKeyDown={onKeyDown}
          className="fixed left-1/2 top-[15%] z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2
                     overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
          aria-label="Command palette"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Search for a screen, a bot, or an action.
          </DialogPrimitive.Description>

          <div className="flex items-center gap-2.5 border-b border-border px-4">
            <Search className="h-4 w-4 shrink-0 text-faint" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search screens, bots and actions…"
              className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-faint"
              aria-label="Search commands"
            />
          </div>

          <div ref={listRef} className="max-h-80 overflow-y-auto p-2" role="listbox">
            {results.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted">No matches.</p>
            ) : (
              groups.map((g) => (
                <div key={g.name} className="mb-1">
                  <p className="px-2 py-1.5 text-[10.5px] font-bold uppercase tracking-wider text-faint">
                    {g.name}
                  </p>
                  {g.items.map((c) => {
                    const i = results.indexOf(c);
                    const on = i === index;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        role="option"
                        aria-selected={on}
                        data-active={on}
                        onMouseMove={() => setIndex(i)}
                        onClick={() => { c.run(); onOpenChange(false); }}
                        className={cn(
                          'flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm',
                          on ? 'bg-bg' : 'hover:bg-bg',
                        )}
                      >
                        {c.icon && <c.icon className="h-4 w-4 shrink-0 text-muted" />}
                        <span className="min-w-0 flex-1 truncate">{c.label}</span>
                        {c.active && <Check className="h-3.5 w-3.5 shrink-0 text-accent-ink" />}
                        {on && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-faint" />}
                      </button>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-faint">
            <span><Kbd>↑</Kbd><Kbd>↓</Kbd> navigate</span>
            <span><Kbd>↵</Kbd> select</span>
            <span><Kbd>esc</Kbd> close</span>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mr-1 inline-flex h-4 min-w-4 items-center justify-center rounded border border-border
                    bg-sunk px-1 font-sans text-[10px] text-muted">
      {children}
    </kbd>
  );
}
