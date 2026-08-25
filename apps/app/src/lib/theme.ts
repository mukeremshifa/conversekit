// ----------------------------------------------------------------
// Theme.
//
// Three states, not two. "System" is the default and stays live — it
// keeps following the OS if that changes while the tab is open, which a
// stored "light"/"dark" deliberately does not.
//
// The CSS side already exists: index.css defines the dark palette both
// under prefers-color-scheme (guarded by :not([data-theme="light"])) and
// under [data-theme="dark"], so all this has to do is stamp the
// attribute. See also the pre-paint script in index.html, which runs the
// same logic before the bundle loads so dark users get no white flash.
// ----------------------------------------------------------------
export type Theme = 'system' | 'light' | 'dark';

export const THEME_KEY = 'ck_theme';
const VALID: Theme[] = ['system', 'light', 'dark'];

export function readTheme(): Theme {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    return VALID.includes(raw as Theme) ? (raw as Theme) : 'system';
  } catch {
    // Private mode, or storage disabled. Following the OS is the safe default.
    return 'system';
  }
}

/** Stamps the root element. "system" removes the attribute entirely so the
 *  media query in index.css takes over again. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* nothing to do */ }
}

/** What the user actually sees right now — needed for the theme-color meta
 *  tag and for anything that has to branch on the resolved value. */
export function resolvedTheme(theme: Theme): 'light' | 'dark' {
  if (theme !== 'system') return theme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
