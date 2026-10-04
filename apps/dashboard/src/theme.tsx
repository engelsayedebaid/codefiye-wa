import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';
export type Theme = 'light' | 'dark';

/** Keep in sync with the pre-paint script in index.html. */
const THEME_KEY = 'wa.theme';
const DEFAULT_PREF: ThemePref = 'light';
const META_COLORS: Record<Theme, string> = { light: '#f8faf9', dark: '#0a0a0a' };

function readPref(): ThemePref {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch {
    // storage unavailable
  }
  return DEFAULT_PREF;
}

const darkQuery = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null);
const resolve = (pref: ThemePref): Theme => (pref === 'system' ? (darkQuery()?.matches ? 'dark' : 'light') : pref);

function applyToDocument(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META_COLORS[theme]);
}

type ThemeCtx = { pref: ThemePref; theme: Theme; setPref: (pref: ThemePref) => void };

const ThemeContext = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [systemDark, setSystemDark] = useState(() => resolve('system') === 'dark');
  const theme: Theme = pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;

  useEffect(() => {
    const query = darkQuery();
    if (!query) return;
    const onChange = () => setSystemDark(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => applyToDocument(theme), [theme]);

  const setPref = useCallback((next: ThemePref) => {
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // per-tab only
    }
    setPrefState(next);
  }, []);

  const value = useMemo<ThemeCtx>(() => ({ pref, theme, setPref }), [pref, theme, setPref]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme outside ThemeProvider');
  return ctx;
}
