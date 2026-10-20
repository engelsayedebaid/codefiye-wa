import { Check, ChevronDown, Search } from '../icons';
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { cx } from '../ui';
import { type Country, countryByIso, countryGroups } from './countries';

/**
 * A phone field with the calling code inside it: a small menu on the start side, the national
 * number beside it. The whole control is left-to-right, because a phone number is.
 */
export function DialField({
  label,
  value,
  onChange,
  country,
  onCountry,
  placeholder,
  error,
  hint,
  autoFocus,
  required,
  autoComplete = 'tel-national',
  name,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  country: string;
  onCountry: (iso: string) => void;
  placeholder?: string;
  error?: string[];
  hint?: ReactNode;
  autoFocus?: boolean;
  required?: boolean;
  autoComplete?: string;
  /** Accessible name when there is no visible label (the method switch already names the field). */
  name?: string;
}) {
  const { t, lang } = useI18n();
  const id = useId();
  const selected = countryByIso(country);
  return (
    <div className="grid gap-2">
      {label && (
        <span id={`${id}-label`} className="text-sm leading-none font-medium">
          {label}
        </span>
      )}
      <div
        dir="ltr"
        className={cx(
          'flex h-9 w-full min-w-0 items-stretch rounded-md border border-line bg-card text-ink shadow-xs transition-[color,box-shadow,border-color]',
          'focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
          error && 'border-destructive-ink ring-destructive-ink/30',
        )}
      >
        <CountryMenu selected={selected} onPick={onCountry} />
        <span aria-hidden className="my-2 w-px shrink-0 bg-line" />
        <input
          aria-labelledby={label ? `${id}-label` : undefined}
          aria-label={label ? undefined : name}
          aria-invalid={error ? true : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          inputMode="tel"
          autoComplete={autoComplete}
          autoFocus={autoFocus}
          required={required}
          className="min-w-0 flex-1 bg-transparent px-3 text-base outline-none placeholder:text-muted md:text-sm"
        />
      </div>
      {error ? (
        <span className="block text-sm text-destructive-ink">{error.join(lang === 'ar' ? '، ' : ', ')}</span>
      ) : (
        hint && <span className="block text-sm text-muted">{hint}</span>
      )}
    </div>
  );
}

function CountryMenu({ selected, onPick }: { selected: Country; onPick: (iso: string) => void }) {
  const { t, lang } = useI18n();
  const c = t.auth.country;
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const groups = countryGroups(lang, query);
  const flat = groups.flatMap((g) => g.items);
  const labels = { common: c.common, all: c.all };

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const items = countryGroups(lang, '').flatMap((g) => g.items);
    setActive(Math.max(0, items.findIndex((item) => item.iso === selected.iso)));
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    const onDown = (e: MouseEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, lang, selected.iso]);

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const pick = (iso: string) => {
    onPick(iso);
    setOpen(false);
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') setActive((i) => Math.min(flat.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
    else if (e.key === 'Enter') {
      const item = flat[active];
      if (item) pick(item.iso);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
    } else return;
    e.preventDefault();
  };

  let index = 0;
  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={c.label}
        onClick={() => setOpen((o) => !o)}
        className="flex h-full items-center gap-1 rounded-s-md ps-2 pe-1.5 text-sm font-medium transition-colors hover:bg-raised"
      >
        <span className="flex h-5 min-w-6 items-center justify-center rounded bg-brand/10 px-1 text-[10px] font-semibold tracking-wide text-brand">{selected.iso}</span>
        <span className="font-mono text-[13px] tabular-nums">{selected.dial}</span>
        <ChevronDown className={cx('size-3.5 text-muted transition-transform duration-200', open && 'rotate-180')} />
      </button>
      {open && (
        <div className="animate-scale-in absolute start-0 top-full z-50 mt-1.5 w-72 max-w-[calc(100vw-3rem)] origin-top overflow-hidden rounded-lg border border-line bg-card shadow-xl shadow-black/40 light:shadow-black/10">
          <div dir={lang === 'ar' ? 'rtl' : 'ltr'}>
          <div className="border-b border-line p-1.5">
            <div className="relative">
              <Search className="pointer-events-none absolute inset-y-0 start-2.5 my-auto size-3.5 text-muted" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onSearchKey}
                placeholder={c.search}
                aria-label={c.search}
                className="h-8 w-full rounded-md border border-line bg-bg ps-8 pe-2 text-sm text-ink outline-none placeholder:text-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              />
            </div>
          </div>
          <ul ref={listRef} id={`${id}-list`} role="listbox" aria-label={c.label} className="max-h-64 overflow-auto p-1">
            {flat.length === 0 && <li className="px-2 py-3 text-center text-sm text-muted">{c.empty}</li>}
            {groups.map((group) => {
              if (group.items.length === 0) return null;
              const heading = group.label ? labels[group.label] : null;
              return (
                <li key={group.label ?? 'results'}>
                  {heading && <div className="px-2 pt-2 pb-1 text-xs font-medium text-faint">{heading}</div>}
                  <ul>
                    {group.items.map((item) => {
                      const i = index++;
                      const on = item.iso === selected.iso;
                      return (
                        <li
                          key={item.iso}
                          data-index={i}
                          role="option"
                          aria-selected={on}
                          onMouseEnter={() => setActive(i)}
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => pick(item.iso)}
                          className={cx(
                            'flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                            i === active ? 'bg-raised text-ink' : 'text-ink-2',
                            on && 'font-medium text-ink',
                          )}
                        >
                          <span className="flex h-5 w-7 shrink-0 items-center justify-center rounded bg-brand/10 text-[10px] font-semibold text-brand">{item.iso}</span>
                          <span className="min-w-0 flex-1 truncate">{lang === 'ar' ? item.ar : item.en}</span>
                          <span className="font-mono text-xs text-muted tabular-nums">{item.dial}</span>
                          {on && <Check className="size-3.5 shrink-0 text-brand" />}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
          </div>
        </div>
      )}
    </div>
  );
}
