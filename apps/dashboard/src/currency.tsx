import { convertUsd, CURRENCY_CODE, type CurrencyRates, DEFAULT_CURRENCY_RATES, POPULAR_CURRENCIES } from '@wa/shared/currency';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { Check, ChevronDown, Coins, Search } from './icons';
import { type Lang, useI18n } from './i18n';
import { qk } from './queries';
import { cx } from './ui';

/**
 * The currency the visitor sees prices in, remembered per browser. Visitors in Egypt start in EGP
 * (the Central Bank asks for prices in pounds), everyone else in USD; anyone can switch.
 */
const CURRENCY_KEY = 'wa.currency';

function readCurrency(): string {
  try {
    const saved = localStorage.getItem(CURRENCY_KEY);
    if (saved && CURRENCY_CODE.test(saved)) return saved;
  } catch {
    // storage unavailable
  }
  try {
    if (Intl.DateTimeFormat().resolvedOptions().timeZone === 'Africa/Cairo') return 'EGP';
  } catch {
    // no Intl time zones
  }
  return 'USD';
}

let current = readCurrency();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Another tab switched: follow it.
  const onStorage = (e: StorageEvent) => {
    if (e.key === CURRENCY_KEY && e.newValue && CURRENCY_CODE.test(e.newValue) && e.newValue !== current) {
      current = e.newValue;
      listener();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function setCurrency(code: string) {
  if (!CURRENCY_CODE.test(code) || code === current) return;
  current = code;
  try {
    localStorage.setItem(CURRENCY_KEY, code);
  } catch {
    // per-tab only
  }
  for (const listener of listeners) listener();
}

/** USD plus every currency with a rate: EGP at the admin's rate, the rest at the day's market rate. */
export function useCurrencyRates() {
  return useQuery({
    queryKey: qk.currencyRates,
    queryFn: ({ signal }) => api<CurrencyRates>('/api/currency-rates', { signal }),
    staleTime: 30 * 60_000,
  });
}

/** An amount in `code`; EGP is written the way Egyptian price tags are. */
export function formatMoney(amount: number, code: string, lang: Lang): string {
  if (code === 'EGP') {
    const n = amount.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return lang === 'ar' ? `${n} ج.م` : `EGP ${n}`;
  }
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${code} ${amount.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  }
}

/** Prices in the chosen currency. Until its rate has loaded (or when there is none) they stay in USD. */
export function useMoney() {
  const { lang } = useI18n();
  const chosen = useSyncExternalStore(subscribe, () => current);
  const rates = useCurrencyRates().data ?? DEFAULT_CURRENCY_RATES;
  const code = chosen === 'USD' || rates.rates[chosen] ? chosen : 'USD';
  return {
    /** What the visitor picked (may still be loading). */
    chosen,
    /** What prices are shown in right now. */
    code,
    rates,
    /** A USD amount in the shown currency (rounded as price tags are). */
    amount: (usd: number) => convertUsd(usd, code, rates.rates) ?? usd,
    /** An amount already in the shown currency, as text. */
    format: (n: number) => formatMoney(n, code, lang),
    /** A USD amount in the shown currency, as text. */
    money: (usd: number) => formatMoney(convertUsd(usd, code, rates.rates) ?? usd, code, lang),
  };
}

function useCurrencyNames(lang: Lang) {
  return useMemo(() => {
    const make = (l: string) => {
      try {
        return new Intl.DisplayNames([l], { type: 'currency' });
      } catch {
        return null;
      }
    };
    const local = make(lang);
    const english = lang === 'en' ? local : make('en');
    return { name: (code: string) => local?.of(code) ?? code, english: (code: string) => english?.of(code) ?? code };
  }, [lang]);
}

/** Currency picker: the popular ones first, then every currency with a rate, searchable by code or name. */
export function CurrencySwitch({ className, align = 'end', withLabel }: { className?: string; align?: 'start' | 'end'; withLabel?: boolean }) {
  const { t, lang } = useI18n();
  const c = t.currency;
  const { code } = useMoney();
  const rates = useCurrencyRates().data ?? DEFAULT_CURRENCY_RATES;
  const names = useCurrencyNames(lang);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const { popular, others } = useMemo(() => {
    const available = Object.keys(rates.rates);
    const needle = q.trim().toLowerCase();
    const matches = (code: string) => !needle || code.toLowerCase().includes(needle) || names.name(code).toLowerCase().includes(needle) || names.english(code).toLowerCase().includes(needle);
    const top = POPULAR_CURRENCIES.filter((code) => available.includes(code) && matches(code));
    const rest = available
      .filter((code) => !(POPULAR_CURRENCIES as readonly string[]).includes(code) && matches(code))
      .sort((a, b) => names.name(a).localeCompare(names.name(b), lang));
    return { popular: top, others: rest };
  }, [rates, q, names, lang]);

  const pick = (next: string) => {
    setCurrency(next);
    setOpen(false);
    setQ('');
  };

  const item = (option: string) => {
    const selected = option === code;
    return (
      <li key={option}>
        <button
          type="button"
          role="menuitemradio"
          aria-checked={selected}
          onClick={() => pick(option)}
          className={cx(
            'flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-raised hover:text-ink',
            selected ? 'font-medium text-ink' : 'text-ink-2',
          )}
        >
          <span className="ltr w-10 shrink-0 text-start font-mono text-xs text-muted">{option}</span>
          <span className="min-w-0 flex-1 truncate text-start">{names.name(option)}</span>
          {selected && <Check className="size-4 shrink-0 text-brand" />}
        </button>
      </li>
    );
  };

  return (
    <div ref={ref} className={cx('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={c.aria}
        aria-haspopup="menu"
        aria-expanded={open}
        title={names.name(code)}
        className={cx(
          'inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-ink-2 transition-colors hover:bg-raised hover:text-ink',
          withLabel && 'border border-line bg-card',
        )}
      >
        <Coins className="size-4" />
        {withLabel && <span className="text-muted">{c.label}</span>}
        <span className="ltr font-mono text-xs font-semibold">{code}</span>
        <ChevronDown className="size-3.5 text-muted" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={c.aria}
          className={cx(
            'animate-scale-in absolute top-full z-50 mt-1.5 w-72 max-w-[calc(100vw-2rem)] origin-top rounded-md border border-line bg-card p-1 shadow-xl shadow-black/50 light:shadow-black/15',
            align === 'end' ? 'end-0' : 'start-0',
          )}
        >
          <label className="flex items-center gap-2 border-b border-line px-2 pb-1.5">
            <Search className="size-4 shrink-0 text-muted" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                const first = popular[0] ?? others[0];
                if (e.key === 'Enter' && first) {
                  e.preventDefault();
                  pick(first);
                }
              }}
              placeholder={c.search}
              aria-label={c.search}
              className="h-8 w-full bg-transparent text-sm outline-none placeholder:text-faint"
            />
          </label>
          <ul className="max-h-72 overflow-y-auto overscroll-contain py-1">
            {popular.map(item)}
            {popular.length > 0 && others.length > 0 && <li aria-hidden className="mx-2 my-1 h-px bg-line" />}
            {others.map(item)}
            {popular.length === 0 && others.length === 0 && <li className="px-2 py-3 text-center text-sm text-muted">{c.noMatch}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
