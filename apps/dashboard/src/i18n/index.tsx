import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { ar, type Dict } from './ar';
import { en } from './en';

export type Lang = 'ar' | 'en';

const DICTS: Record<Lang, Dict> = { ar, en };
const LANG_KEY = 'wa.lang';

function readLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === 'ar' || saved === 'en') return saved;
  } catch {
    // storage unavailable
  }
  return 'ar';
}

let current: Lang = readLang();

/** For code outside React (API errors, formatters). Components should use `useI18n`. */
export const getLang = () => current;
export const getDict = () => DICTS[current];

const LOCALES: Record<Lang, string> = { ar: 'ar-u-nu-latn', en: 'en-US' };

export function formatters(lang: Lang) {
  const locale = LOCALES[lang];
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const date = new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'long', day: 'numeric' });
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' });
  const dayLong = new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return {
    number: new Intl.NumberFormat('en-US'),
    date: (iso: string | Date) => date.format(new Date(iso)),
    dateTime: (iso: string | Date) => dateTime.format(new Date(iso)),
    time: (iso: string | Date) => time.format(new Date(iso)),
    dayShort: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }),
    dayLong,
    /** "Today", "Yesterday", else the weekday and date — for day separators. */
    day(iso: string | Date): string {
      const days = Math.round((startOfDay(new Date(iso)) - startOfDay(new Date())) / 86_400_000);
      if (days !== 0 && days !== -1) return dayLong.format(new Date(iso));
      const label = relative.format(days, 'day');
      return label.charAt(0).toUpperCase() + label.slice(1);
    },
    timeAgo(iso: string | null): string {
      if (!iso) return '—';
      const seconds = Math.round((new Date(iso).getTime() - Date.now()) / 1000);
      const abs = Math.abs(seconds);
      if (abs < 60) return relative.format(seconds, 'second');
      if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
      if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
      if (abs < 7 * 86_400) return relative.format(Math.round(seconds / 86_400), 'day');
      return dateTime.format(new Date(iso));
    },
  };
}

type I18n = { lang: Lang; dir: 'rtl' | 'ltr'; t: Dict; fmt: ReturnType<typeof formatters>; setLang: (lang: Lang) => void };

const I18nContext = createContext<I18n | null>(null);

function applyToDocument(lang: Lang) {
  const t = DICTS[lang];
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  document.title = t.meta.title;
  document.querySelector('meta[name="description"]')?.setAttribute('content', t.meta.description);
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current);

  useEffect(() => applyToDocument(lang), [lang]);

  const setLang = useCallback((next: Lang) => {
    current = next;
    try {
      localStorage.setItem(LANG_KEY, next);
    } catch {
      // per-tab only
    }
    setLangState(next);
  }, []);

  const value = useMemo<I18n>(() => ({ lang, dir: lang === 'ar' ? 'rtl' : 'ltr', t: DICTS[lang], fmt: formatters(lang), setLang }), [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n outside I18nProvider');
  return ctx;
}
