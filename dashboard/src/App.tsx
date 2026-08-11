import { useCallback, useEffect, useState } from 'react';
import { Toaster, toast } from 'sonner';
import {
  BookText, Boxes, Cable, Cpu, MessageSquareText, MessagesSquare, Plug, Settings2, Target, Search,
} from 'lucide-react';
import { clearSession, currentSession } from '@/lib/auth';
import { endpoints, type Bot, type Me } from '@/lib/api';
import { SignIn } from '@/screens/SignIn';
import { Shell, type NavItem } from '@/components/Shell';
import { BotSettings } from '@/screens/BotSettings';
import { KnowledgeBase } from '@/screens/KnowledgeBase';
import { Providers } from '@/screens/Providers';
import { Retrieval } from '@/screens/Retrieval';
import { Sources } from '@/screens/Sources';
import { Leads } from '@/screens/Leads';
import { Conversations } from '@/screens/Conversations';
import { Install } from '@/screens/Install';
import { Playground } from '@/screens/Playground';
import { NoOrg } from '@/screens/NoOrg';
import { Spinner } from '@/components/ui';

const NAV: NavItem[] = [
  { id: 'playground',    label: 'Playground',        icon: MessagesSquare },
  { id: 'settings',      label: 'Bot Settings',      icon: Settings2 },
  { id: 'knowledge',     label: 'Knowledge Base',    icon: BookText },
  { id: 'sources',       label: 'Knowledge Sources', icon: Boxes },
  { id: 'retrieval',     label: 'Retrieval',         icon: Search },
  { id: 'providers',     label: 'AI Providers',      icon: Cpu },
  { id: 'leads',         label: 'Leads',             icon: Target },
  { id: 'conversations', label: 'Conversations',     icon: MessageSquareText },
  { id: 'install',       label: 'Install',           icon: Plug },
];

/** Hash routing: deep links work with no server rewrite rules, which
 *  matters on Pages where the app is one static index.html. */
function useHashRoute(fallback: string) {
  const [route, setRoute] = useState(() => window.location.hash.slice(1) || fallback);
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash.slice(1) || fallback);
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
  const [route, navigate] = useHashRoute('playground');

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
      >
        {!bot ? (
          <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
            <Cable className="h-8 w-8 text-muted" />
            <p className="font-medium">No bots yet</p>
            <p className="text-sm text-muted">Create one from the sidebar to get started.</p>
          </div>
        ) : (
          <>
            {route === 'playground'    && <Playground bot={bot} />}
            {route === 'settings'      && <BotSettings bot={bot} onSaved={patchBot} />}
            {route === 'knowledge'     && <KnowledgeBase bot={bot} onSaved={patchBot} />}
            {route === 'sources'       && <Sources bot={bot} />}
            {route === 'retrieval'     && <Retrieval bot={bot} onSaved={patchBot} />}
            {route === 'providers'     && <Providers bot={bot} onSaved={patchBot} />}
            {route === 'leads'         && <Leads bot={bot} />}
            {route === 'conversations' && <Conversations bot={bot} />}
            {route === 'install'       && <Install bot={bot} />}
          </>
        )}
      </Shell>
      <Toaster richColors position="top-center" />
    </>
  );
}
