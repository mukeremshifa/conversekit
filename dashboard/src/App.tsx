import { useCallback, useEffect, useState } from 'react';
import { Toaster, toast } from 'sonner';
import {
  LayoutDashboard,
  BookText, Boxes, Cable, Cpu, MessageSquareText, MessagesSquare, Plug, Settings2, Target, Search,
} from 'lucide-react';
import { clearSession, currentSession } from '@/lib/auth';
import { endpoints, type Bot, type Me } from '@/lib/api';
import { SignIn } from '@/screens/SignIn';
import { Shell, type NavItem } from '@/components/Shell';
import { BotConfiguration } from '@/screens/BotConfiguration';
import { KnowledgeBase } from '@/screens/KnowledgeBase';
import { Providers } from '@/screens/Providers';
import { Retrieval } from '@/screens/Retrieval';
import { Sources } from '@/screens/Sources';
import { Leads } from '@/screens/Leads';
import { Conversations } from '@/screens/Conversations';
import { Install } from '@/screens/Install';
import { Playground } from '@/screens/Playground';
import { Overview } from '@/screens/Overview';
import { NoOrg } from '@/screens/NoOrg';
import { EmptyState, Spinner } from '@/components/ui';
import { CommandPalette, buildCommands, useCommandPalette } from '@/components/CommandPalette';
import { readTheme, setTheme } from '@/lib/theme';

const NAV: NavItem[] = [
  { id: 'overview',      label: 'Overview',          icon: LayoutDashboard },
  { id: 'playground',    label: 'Playground',        icon: MessagesSquare },
  { id: 'configuration', label: 'Bot Configuration', icon: Settings2 },
  { id: 'knowledge',     label: 'Knowledge Base',    icon: BookText },
  { id: 'sources',       label: 'Knowledge Sources', icon: Boxes },
  { id: 'retrieval',     label: 'Retrieval',         icon: Search },
  { id: 'providers',     label: 'AI Providers',      icon: Cpu },
  { id: 'leads',         label: 'Leads',             icon: Target },
  { id: 'conversations', label: 'Conversations',     icon: MessageSquareText },
  { id: 'install',       label: 'Install',           icon: Plug },
];

/** Screens whose content is a table or a chart grid rather than a form. */
const WIDE_ROUTES = new Set(['overview', 'leads', 'conversations', 'sources']);

/** Routes that were renamed. The old id stays a working URL: #settings is
 *  bookmarked, and a rename is not a reason to break someone's link. */
const ALIASES: Record<string, string> = { settings: 'configuration' };

const resolveRoute = (hash: string, fallback: string) => {
  const id = hash.slice(1) || fallback;
  return ALIASES[id] ?? id;
};

/** Hash routing: deep links work with no server rewrite rules, which
 *  matters on Pages where the app is one static index.html. */
function useHashRoute(fallback: string) {
  const [route, setRoute] = useState(() => resolveRoute(window.location.hash, fallback));
  useEffect(() => {
    const onHash = () => setRoute(resolveRoute(window.location.hash, fallback));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [fallback]);
  return [route, (r: string) => { window.location.hash = r; }] as const;
}

export default function App() {
  const [authed, setAuthed] = useState(() => !!currentSession());
  const [me, setMe] = useState<Me | null>(null);
  const [bots, setBots] = useState<Bot[]>([]);
  const [botId, setBotId] = useState<string>(() => localStorage.getItem('ck_bot_id') ?? '');
  const [loading, setLoading] = useState(true);
  const [route, navigate] = useHashRoute('overview');
  const palette = useCommandPalette();

  const bot = bots.find((b) => b.id === botId) ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [meRes, botsRes] = await Promise.all([endpoints.me(), endpoints.bots()]);
      setMe(meRes);
      setBots(botsRes.bots);
      setBotId((current) => {
        const stillExists = botsRes.bots.some((b) => b.id === current);
        return stillExists ? current : (botsRes.bots[0]?.id ?? '');
      });
    } catch (err) {
      // A failure here is almost always an expired session.
      toast.error(err instanceof Error ? err.message : 'Could not load your account');
      if (!currentSession()) setAuthed(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authed) void load();
  }, [authed, load]);

  useEffect(() => {
    if (botId) localStorage.setItem('ck_bot_id', botId);
  }, [botId]);

  /** Replace one bot in place after a save, so the switcher label and
   *  every screen see the update without a full refetch. */
  const patchBot = useCallback((updated: Bot) => {
    setBots((prev) => prev.map((b) => (b.id === updated.id ? updated : b)));
  }, []);

  /** The palette cannot open Shell's dialog directly, so it routes to the
   *  place that has one. Cycling beats a submenu for a three-state setting. */
  const cycleTheme = () => {
    const order = ['system', 'light', 'dark'] as const;
    const next = order[(order.indexOf(readTheme()) + 1) % order.length];
    setTheme(next);
    toast.success(`Theme: ${next}`);
  };

  const onSignOut = () => {
    clearSession();
    setAuthed(false);
    setMe(null);
    setBots([]);
  };

  if (!authed) {
    return (
      <>
        <SignIn onAuthed={() => setAuthed(true)} />
        <Toaster richColors position="top-center" />
      </>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-3 text-muted">
        <Spinner /> Loading your workspace…
      </div>
    );
  }

  // Signing up provisions an org via a Postgres trigger, but that only
  // fires once. An account that loses its last org would otherwise be
  // permanently unable to do anything — including create a bot.
  if (me && me.orgs.length === 0) {
    return (
      <>
        <NoOrg email={me.email} onCreated={load} onSignOut={onSignOut} />
        <Toaster richColors position="top-center" />
      </>
    );
  }

  return (
    <>
      <Shell
        nav={NAV}
        route={route}
        onNavigate={navigate}
        bots={bots}
        botId={botId}
        onSelectBot={setBotId}
        email={me?.email ?? null}
        orgs={me?.orgs ?? []}
        onBotCreated={(b) => { setBots((prev) => [b, ...prev]); setBotId(b.id); }}
        onSignOut={onSignOut}
        wide={WIDE_ROUTES.has(route)}
        onOpenPalette={() => palette.setOpen(true)}
      >
        {!bot ? (
          <EmptyState
            className="py-24"
            icon={Cable}
            title="No bots yet"
            description="A bot is one row: give it a name, tell it what your business does, and paste the script tag on your site."
            action={{ label: 'Create your first bot', onClick: () => document.querySelector<HTMLElement>('[aria-label="Select bot"]')?.focus() }}
          />
        ) : (
          <div key={route} className="ck-route space-y-6">
            {route === 'overview'      && <Overview bot={bot} onNavigate={navigate} />}
            {route === 'playground'    && <Playground bot={bot} />}
            {route === 'configuration' && <BotConfiguration bot={bot} onSaved={patchBot} />}
            {route === 'knowledge'     && <KnowledgeBase bot={bot} onSaved={patchBot} />}
            {route === 'sources'       && <Sources bot={bot} />}
            {route === 'retrieval'     && <Retrieval bot={bot} onSaved={patchBot} />}
            {route === 'providers'     && <Providers bot={bot} onSaved={patchBot} />}
            {route === 'leads'         && <Leads bot={bot} />}
            {route === 'conversations' && <Conversations bot={bot} />}
            {route === 'install'       && <Install bot={bot} />}
          </div>
        )}
      </Shell>

      <CommandPalette
        open={palette.open}
        onOpenChange={palette.setOpen}
        commands={buildCommands({
          nav: NAV, route, bots, botId,
          onNavigate: navigate,
          onSelectBot: setBotId,
          onNewBot: () => navigate('configuration'),
          onCycleTheme: cycleTheme,
        })}
      />
      <Toaster richColors position="top-center" />
    </>
  );
}
