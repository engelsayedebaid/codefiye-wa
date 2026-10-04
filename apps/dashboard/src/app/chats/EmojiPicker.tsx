import { Car, Clock, Flag, Heart, Lightbulb, PawPrint, Search, Smile, Trophy, UtensilsCrossed, X, Hand } from 'lucide-react';
import { type KeyboardEvent, memo, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { cx } from '../../ui';

type Emoji = { u: string; label: string; tags: string[]; group: number; skins?: string[] };
type Data = { byGroup: Map<number, Emoji[]>; all: Emoji[]; byChar: Map<string, Emoji> };

/** Shown groups, in order (2 = skin-tone components, not offered on their own). */
const GROUPS = [0, 1, 3, 4, 5, 6, 7, 8, 9] as const;
const GROUP_ICONS: Record<number, typeof Smile> = { 0: Smile, 1: Hand, 3: PawPrint, 4: UtensilsCrossed, 5: Car, 6: Trophy, 7: Lightbulb, 8: Heart, 9: Flag };
/** Fitzpatrick modifiers, light → dark; index 0 = no modifier (yellow). */
const TONES = ['', '1F3FB', '1F3FC', '1F3FD', '1F3FE', '1F3FF'];
const TONE_SWATCH = ['#ffc83d', '#f7d7c4', '#e6b98f', '#c68e5d', '#a0663d', '#5c3a26'];
const RECENT_KEY = 'wa.emoji.recent';
const TONE_KEY = 'wa.emoji.tone';
const RECENT_MAX = 32;

/** Arabic words for the emoji people look for most (the emoji data itself is English-only). */
const ARABIC: Record<string, string> = {
  '😀': 'ضحك ابتسامة سعيد', '😂': 'ضحك دموع هههه', '🤣': 'ضحك هههه', '😊': 'ابتسامة خجل سعيد', '😍': 'حب قلوب عيون', '🥰': 'حب قلوب',
  '😘': 'بوسة قبلة حب', '😉': 'غمزة', '😎': 'نظارة رائع', '🤔': 'تفكير', '😢': 'بكاء حزن', '😭': 'بكاء حزن دموع', '😡': 'غضب زعل',
  '😱': 'صدمة خوف', '😴': 'نوم', '🙄': 'ملل', '😅': 'إحراج عرق', '🙏': 'دعاء شكرا رجاء من فضلك', '👍': 'تمام موافق لايك اعجاب',
  '👎': 'رفض لا', '👏': 'تصفيق برافو', '👋': 'سلام مرحبا اهلا', '🤝': 'اتفاق مصافحة', '💪': 'قوة عضلات', '✌️': 'سلام نصر', '👌': 'تمام ممتاز',
  '❤️': 'قلب حب احمر', '💔': 'قلب مكسور حزن', '💯': 'مية ممتاز', '🔥': 'نار رائع', '✨': 'لمعان', '🎉': 'احتفال مبروك', '🎂': 'عيد ميلاد كيك',
  '🎁': 'هدية', '🌹': 'وردة ورد', '🌙': 'هلال رمضان قمر', '⭐': 'نجمة', '☀️': 'شمس', '☕': 'قهوة شاي', '🍕': 'بيتزا اكل', '🍔': 'برجر اكل',
  '✅': 'صح تم', '❌': 'خطأ غلط لا', '⚠️': 'تحذير انتباه', '📞': 'اتصال تليفون', '📱': 'موبايل جوال هاتف', '💰': 'فلوس مال', '💵': 'فلوس دولار',
  '📍': 'مكان موقع', '🕌': 'مسجد', '🤲': 'دعاء', '😇': 'ملاك', '🥳': 'احتفال', '😋': 'لذيذ', '🤗': 'حضن', '😔': 'حزن', '😏': 'خبث',
  '👀': 'عيون نظر', '🙈': 'خجل قرد', '💐': 'باقة ورد', '🚗': 'عربية سيارة', '✈️': 'طيارة سفر', '🏠': 'بيت منزل', '⚽': 'كورة كرة قدم',
};

let dataPromise: Promise<Data> | null = null;
function loadData(): Promise<Data> {
  dataPromise ??= Promise.all([import('emojibase-data/en/compact.json'), import('emojibase-data/versions/emoji.json')]).then(([{ default: list }, { default: versions }]) => {
    // Newer emoji draw as empty boxes on many phones and computers: leave them out.
    const tooNew = new Set(Object.entries(versions as Record<string, string[]>).flatMap(([v, codes]) => (Number.parseFloat(v) > 15 ? codes : [])));
    const byGroup = new Map<number, Emoji[]>();
    const all: Emoji[] = [];
    const byChar = new Map<string, Emoji>();
    const sorted = [...list].filter((e) => e.group !== undefined && e.group !== 2 && !tooNew.has(e.hexcode)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const e of sorted) {
      const skins = e.skins?.length ? TONES.slice(1).map((tone) => e.skins!.find((s) => s.hexcode.split('-').filter((h) => TONES.includes(h) && h).every((h) => h === tone))?.unicode ?? e.unicode) : undefined;
      const emoji: Emoji = { u: e.unicode, label: e.label, tags: [...(e.tags ?? []), ...(ARABIC[e.unicode]?.split(' ') ?? [])], group: e.group!, skins };
      all.push(emoji);
      byChar.set(e.unicode, emoji);
      byGroup.set(emoji.group, [...(byGroup.get(emoji.group) ?? []), emoji]);
    }
    return { byGroup, all, byChar };
  });
  return dataPromise;
}

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // per-tab only
  }
};

const withTone = (e: Emoji, tone: number) => (tone > 0 && e.skins ? (e.skins[tone - 1] ?? e.u) : e.u);

const COLS = 8;

const Grid = memo(function Grid({ emojis, tone, onPick }: { emojis: Emoji[]; tone: number; onPick: (emoji: string) => void }) {
  return (
    <div role="grid" className="grid grid-cols-8 gap-0.5 px-1.5">
      {emojis.map((e) => {
        const u = withTone(e, tone);
        return (
          <button
            key={e.u}
            type="button"
            role="gridcell"
            data-emoji
            title={e.label}
            aria-label={e.label}
            // Keeps the caret (and the keyboard on phones) in the message field.
            onMouseDown={(ev) => ev.preventDefault()}
            onClick={() => onPick(u)}
            className="flex aspect-square items-center justify-center rounded-lg text-[1.55rem] leading-none transition-[transform,background-color] duration-100 outline-none hover:scale-110 hover:bg-raised focus-visible:bg-raised focus-visible:ring-2 focus-visible:ring-ring active:scale-95"
          >
            {u}
          </button>
        );
      })}
    </div>
  );
});

export function EmojiPicker({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  const { t } = useI18n();
  const e = t.chats.emoji;
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [tone, setTone] = useState(() => Number(read(TONE_KEY)) || 0);
  const [toneOpen, setToneOpen] = useState(false);
  const [recent, setRecent] = useState<string[]>(() => read(RECENT_KEY)?.split(' ').filter(Boolean) ?? []);
  const [active, setActive] = useState<number>(-1);
  const root = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    loadData().then(
      (d) => live && setData(d),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);

  // Closes on a click outside (the button that opened it handles its own toggle) or Escape.
  useEffect(() => {
    const onDown = (ev: PointerEvent) => {
      const target = ev.target as Element;
      if (!root.current?.contains(target) && !target.closest?.('[data-emoji-toggle]')) onClose();
    };
    // Capture phase, so the page's own Escape (close the chat) doesn't run too.
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();
      onClose();
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  // Desktop: straight into search. Phones keep the message field (and their keyboard) focused.
  useEffect(() => {
    if (matchMedia('(pointer: fine)').matches) search.current?.focus({ preventScroll: true });
  }, []);

  const pick = (u: string) => {
    onPick(u);
    const base = data?.all.find((x) => x.u === u || x.skins?.includes(u))?.u ?? u;
    setRecent((list) => {
      const next = [base, ...list.filter((x) => x !== base)].slice(0, RECENT_MAX);
      write(RECENT_KEY, next.join(' '));
      return next;
    });
  };

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!data || !q) return null;
    const words = q.split(/\s+/);
    return data.all.filter((x) => words.every((w) => x.label.toLowerCase().includes(w) || x.tags.some((tag) => tag.toLowerCase().startsWith(w)))).slice(0, 160);
  }, [data, q]);
  const recentEmojis = useMemo(() => (data ? recent.map((u) => data.byChar.get(u)).filter((x): x is Emoji => Boolean(x)) : []), [data, recent]);

  // The tab bar follows the scroll position.
  useEffect(() => {
    const el = body.current;
    if (!el || !data || results) return;
    const onScroll = () => {
      const sections = [...el.querySelectorAll<HTMLElement>('[data-group]')];
      const top = el.scrollTop + 8;
      const current = sections.filter((s) => s.offsetTop <= top).at(-1) ?? sections[0];
      setActive(Number(current?.dataset.group ?? -1));
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [data, results]);

  const jumpTo = (group: number) => {
    setQuery('');
    requestAnimationFrame(() => {
      const section = body.current?.querySelector<HTMLElement>(`[data-group="${group}"]`);
      if (section && body.current) body.current.scrollTo({ top: section.offsetTop - 4 });
    });
  };

  // Arrow keys move between emoji.
  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(body.current?.querySelectorAll<HTMLButtonElement>('[data-emoji]') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const rtl = getComputedStyle(ev.currentTarget).direction === 'rtl';
    const step = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: COLS, ArrowUp: -COLS }[ev.key];
    if (step === undefined) return;
    if (at === -1) {
      if (ev.key === 'ArrowDown' && document.activeElement === search.current) {
        ev.preventDefault();
        buttons[0]?.focus();
      }
      return;
    }
    ev.preventDefault();
    const next = at + step;
    if (next < 0) search.current?.focus();
    else buttons[Math.min(buttons.length - 1, next)]?.focus();
  };

  const section = (group: number, label: string, emojis: Emoji[]) => (
    <section key={group} data-group={group} className="pb-2 [contain-intrinsic-size:auto_320px] [content-visibility:auto]">
      <h3 className="sticky top-0 z-[1] bg-card/95 px-3 pt-2 pb-1.5 text-[11px] font-semibold tracking-wide text-muted backdrop-blur">{label}</h3>
      <Grid emojis={emojis} tone={tone} onPick={pick} />
    </section>
  );

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={t.chats.composer.emoji}
      onKeyDown={onKeyDown}
      className="animate-scale-in absolute start-0 bottom-full z-30 mb-2 flex h-[min(24rem,60svh)] w-[min(22rem,calc(100vw-1rem))] origin-bottom flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-2xl shadow-black/40 light:shadow-black/15"
    >
      <div className="flex items-center gap-1.5 border-b border-line/70 p-2">
        <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl bg-raised px-2.5 text-sm transition-shadow focus-within:ring-2 focus-within:ring-ring/50">
          <Search className="size-4 shrink-0 text-muted" />
          <input
            ref={search}
            value={query}
            onChange={(ev) => setQuery(ev.target.value)}
            placeholder={e.search}
            aria-label={e.search}
            dir="auto"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
          />
          {query && (
            <button type="button" onClick={() => setQuery('')} className="rounded p-0.5 text-muted hover:text-ink" aria-label={t.common.close}>
              <X className="size-3.5" />
            </button>
          )}
        </label>
        <div className="relative">
          <button
            type="button"
            onClick={() => setToneOpen((o) => !o)}
            aria-label={e.skin}
            aria-expanded={toneOpen}
            title={e.skin}
            className="flex size-9 items-center justify-center rounded-xl text-xl transition-colors hover:bg-raised"
          >
            <span className="size-4 rounded-full ring-2 ring-card" style={{ background: TONE_SWATCH[tone] }} />
          </button>
          {toneOpen && (
            <div role="radiogroup" aria-label={e.skin} className="animate-scale-in absolute end-0 top-full z-10 mt-1 flex gap-1 rounded-full border border-line bg-card p-1 shadow-lg">
              {TONE_SWATCH.map((color, i) => (
                <button
                  key={color}
                  type="button"
                  role="radio"
                  aria-checked={tone === i}
                  aria-label={`${e.skin} ${i + 1}`}
                  onClick={() => {
                    setTone(i);
                    write(TONE_KEY, String(i));
                    setToneOpen(false);
                  }}
                  className={cx('size-6 rounded-full transition-transform hover:scale-110', tone === i && 'ring-2 ring-brand ring-offset-2 ring-offset-card')}
                  style={{ background: color }}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      <div ref={body} className="code-scroll relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {failed ? (
          <p className="p-6 text-center text-sm text-muted">{t.common.networkError}</p>
        ) : !data ? (
          <div className="grid grid-cols-8 gap-1.5 p-3" aria-label={e.loading}>
            {Array.from({ length: 40 }, (_, i) => (
              <span key={i} className="aspect-square animate-pulse rounded-lg bg-raised" style={{ animationDelay: `${(i % 8) * 40}ms` }} />
            ))}
          </div>
        ) : results ? (
          results.length ? (
            <div className="pt-2">
              <Grid emojis={results} tone={tone} onPick={pick} />
            </div>
          ) : (
            <p className="p-8 text-center text-sm text-muted">{e.none}</p>
          )
        ) : (
          <>
            {recentEmojis.length > 0 && section(-1, e.recent, recentEmojis)}
            {GROUPS.map((g) => section(g, e.groups[g] ?? '', data.byGroup.get(g) ?? []))}
          </>
        )}
      </div>

      <nav aria-label={t.chats.composer.emoji} className="flex items-center justify-between gap-0.5 border-t border-line/70 px-1.5 py-1">
        {[-1, ...GROUPS].map((g) => {
          const Icon = g === -1 ? Clock : GROUP_ICONS[g]!;
          const label = g === -1 ? e.recent : (e.groups[g] ?? '');
          if (g === -1 && !recentEmojis.length) return null;
          const on = !results && active === g;
          return (
            <button
              key={g}
              type="button"
              onClick={() => jumpTo(g)}
              aria-label={label}
              title={label}
              aria-current={on || undefined}
              className={cx('relative flex size-8 items-center justify-center rounded-lg transition-colors hover:bg-raised', on ? 'text-brand' : 'text-muted hover:text-ink')}
            >
              <Icon className="size-[18px]" />
              {on && <span className="absolute inset-x-2 -bottom-1 h-0.5 rounded-full bg-brand" />}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/** Starts loading the emoji data (e.g. when the button is hovered), so the picker opens filled. */
export const preloadEmoji = () => void loadData().catch(() => {});
