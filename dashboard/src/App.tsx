import { useCallback, useEffect, useState } from 'react';
import { Toaster, toast } from 'sonner';
import {
  LayoutDashboard,
  BookText, Building2, Cable, Coins, Cpu, HelpCircle, MessageSquareText, MessagesSquare, Plug, Search, Settings2, Target,
} from 'lucide-react';
import { clearSession, currentSession } from '@/lib/auth';
import { endpoints, type Bot, type Me } from '@/lib/api';
import { SignIn } from '@/screens/SignIn';
import { Shell, NewBotDialog, type NavItem } from '@/components/Shell';
import { BotConfiguration } from '@/screens/BotConfiguration';
import { BusinessProfile } from '@/screens/BusinessProfile';
import { Knowledge, TAB_ROUTES, knowledgeTabFor } from '@/screens/Knowledge';
import { Retrieval } from '@/screens/Retrieval';
import { Providers } from '@/screens/Providers';
import { Usage } from '@/screens/Usage';
import { Leads } from '@/screens/Leads';
import { Conversations } from '@/screens/Conversations';
import { Install } from '@/screens/Install';
import { Playground } from '@/screens/Playground';
import { Overview } from '@/screens/Overview';
import { NoOrg } from '@/screens/NoOrg';
import { EmptyState, Spinner } from '@/components/ui';
import { CommandPalette, buildCommands, useCommandPalette } from '@/components/CommandPalette';
import { readTheme, setTheme } from '@/lib/theme';

/**
 * Two entries for two questions: what the bot knows (Knowledge Base,
 * whose Sources and FAQ are tabs of one screen) and how it finds it
 * (Retrieval, which is also where the questions it missed are
 * reported).
 *
 * Business Profile sits directly above Bot Configuration because the
 * two answer adjacent questions — what the business IS, and how the bot
 * behaves — and because the Contact section used to live on the second
 * one. Anyone going looking for it should find the new home before the
 * old place it was not.
 */
const NAV: NavItem[] = [
  { id: 'overview',      label: 'Overview',          icon: LayoutDashboard },
  { id: 'playground',    label: 'Playground',        icon: MessagesSquare },
  { id: 'profile',       label: 'Business Profile',  icon: Building2 },
  { id: 'configuration', label: 'Bot Configuration', icon: Settings2 },
  { id: 'knowledge',     label: 'Knowledge Base',    icon: BookText },
  { id: 'retrieval',     label: 'Retrieval',         icon: Search },
  { id: 'providers',     label: 'AI Providers',      icon: Cpu },
  // Directly under AI Providers, because it is the same question one
  // step later: which model answers, and what that model costs.
  { id: 'usage',         label: 'Usage',             icon: Coins },
  { id: 'leads',         label: 'Leads',             icon: Target },
  { id: 'conversations', label: 'Conversations',     icon: MessageSquareText },
  { id: 'install',       label: 'Install',           icon: Plug },
];

/** The routes the Knowledge Base owns — one per tab. #knowledge is
 *  the nav entry and lands on Sources; #sources is the older name for
 *  it and still works, because bookmarks are public surface. */
const KNOWLEDGE_ROUTES = new Set<string>(Object.values(TAB_ROUTES));

/** Screens whose content is a table or a chart grid rather than a form.
 *  Both Knowledge Base tabs are wide together: a page that changes
 *  width as you switch tabs reads as a rendering bug. */
const WIDE_ROUTES = new Set([
  'overview', 'leads', 'conversations', 'retrieval', 'usage', ...KNOWLEDGE_ROUTES,
]);

/** Routes that were renamed. The old id stays a working URL: #settings and
 *  #sources are bookmarked, and a rename is not a reason to break
 *  someone's link. */
const ALIASES: Record<string, string> = {
  settings: 'configuration',
  sources: TAB_ROUTES.sources,
  // The Contact section moved off Bot Configuration and onto its own
  // screen in 015. Nobody linked to #contact, but the two names people
  // guess for the new one are worth catching.
  'business-profile': 'profile',
  contact: 'profile',
};

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
  /** An org has exactly one bot (supabase/014), so there is no
   *  selection to hold and nothing to remember across reloads — the
   *  `ck_bot_id` localStorage key this replaced is dead, and stale
   *  copies of it are harmless because nothing reads it any more.
   *  Null is the recovery case: the org's bot was deleted. */
  const [bot, setBot] = useState<Bot | null>(null);
  const [loading, setLoading] = useState(true);
  const [route, navigate] = useHashRoute('overview');
  const palette = useCommandPalette();
  /**
   * A question carried from the miss report on Retrieval to the editor
   * on the Knowledge Base. It lives here because it crosses screens —
   * the point of the action is that it lands you in the FAQ tab with
   * the question already typed.
   */
  const [faqDraft, setFaqDraft] = useState<string | null>(null);

  const addAsFaq = (question: string) => {
    setFaqDraft(question);
    navigate(TAB_ROUTES.faq);
  };
  /** Stable, because the editor's prefill effect depends on it. */
  const clearFaqDraft = useCallback(() => setFaqDraft(null), []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [meRes, botsRes] = await Promise.all([endpoints.me(), endpoints.bots()]);
      setMe(meRes);
      setBot(botsRes.bots[0] ?? null);
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

  /** Take the saved row after a screen writes one, so the sidebar label
   *  and every screen see the update without a full refetch. */
  const patchBot = useCallback((updated: Bot) => setBot(updated), []);

  /** Cycling beats a submenu for a three-state setting. */
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
    setBot(null);
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
        route={KNOWLEDGE_ROUTES.has(route) ? TAB_ROUTES.sources : route}
        onNavigate={navigate}
        bot={bot}
        email={me?.email ?? null}
        onSignOut={onSignOut}
        wide={WIDE_ROUTES.has(route)}
        onOpenPalette={() => palette.setOpen(true)}
      >
        {!bot ? (
          // Signup provisions a bot and 014 backfilled the orgs that
          // predate it, so reaching this means the bot was deleted.
          // The dialog is the only create path left in the UI.
          <div className="flex flex-col items-center gap-4 py-24">
            <EmptyState
              icon={Cable}
              title="This workspace has no bot"
              description="Your organization is set up but its bot is gone — deleted, most likely. Create one to get back to a working widget."
            />
            <NewBotDialog orgs={me?.orgs ?? []} onCreated={setBot} />
          </div>
        ) : (
          <div key={route} className="ck-route space-y-6">
            {route === 'overview'      && <Overview bot={bot} onNavigate={navigate} />}
            {route === 'playground'    && <Playground bot={bot} />}
            {route === 'profile'       && <BusinessProfile bot={bot} onSaved={patchBot} />}
            {route === 'configuration' && <BotConfiguration bot={bot} onSaved={patchBot} />}
            {KNOWLEDGE_ROUTES.has(route) && (
              <Knowledge
                bot={bot}
                tab={knowledgeTabFor(route)}
                draftQuestion={faqDraft}
                onDraftTaken={clearFaqDraft}
                onNavigate={navigate}
                onSaved={patchBot}
              />
            )}
            {route === 'retrieval'     && <Retrieval bot={bot} onSaved={patchBot} onAddFaq={addAsFaq} />}
            {route === 'providers'     && <Providers bot={bot} onSaved={patchBot} />}
            {route === 'usage'         && <Usage bot={bot} onNavigate={navigate} />}
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
          nav: NAV, route,
          // The Knowledge Base tab that is not a nav entry of its own.
          // Someone who knows the product still types "faq".
          extra: [
            { id: TAB_ROUTES.faq, label: 'Knowledge Base · FAQ', icon: HelpCircle },
          ],
          onNavigate: navigate,
          onCycleTheme: cycleTheme,
        })}
      />
      <Toaster richColors position="top-center" />
    </>
  );
}
