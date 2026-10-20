import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, Bookmark, ExternalLink, Eye, Globe, Info, Layers, Link2, Loader2, Play, Plus, Search, Sparkles, X, Zap } from '../../icons';
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, ApiRequestError, errorMessage } from '../../api';
import { useI18n } from '../../i18n';
import { Button, cx, ErrorNote, flip, Select } from '../../ui';
import {
  LAUNCH_COUNTRIES,
  LIBRARY_CATEGORIES,
  LIBRARY_REACH,
  libraryLink,
  platformOf,
  strength,
  LIBRARY_PLATFORMS,
  type LibraryAd,
  type LibraryCategory,
  type LibraryPage,
  type LibraryPlatform,
  type LibraryStatus,
  PLATFORM_LOOK,
  SAMPLE_ADS,
  scoreTier,
} from './library';

const KEYS = {
  status: ['ads', 'library', 'status'] as const,
  saved: ['ads', 'library', 'saved'] as const,
  search: (params: Record<string, string>) => ['ads', 'library', 'search', params] as const,
};
const TIER_TONE = { high: 'bg-good text-bg', mid: 'bg-warning text-on-warning', low: 'bg-ink-3 text-bg' };
const COUNTRY_KEY = 'wa.ads.libraryCountry';
const LAUNCH_KEY = 'wa.ads.launchCountry';
const remembered = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: just not remembered
  }
};
const isSample = (ad: LibraryAd) => SAMPLE_ADS.some((s) => s.id === ad.id);

function PlatformMark({ platform, size = 22 }: { platform: LibraryPlatform; size?: number }) {
  const look = PLATFORM_LOOK[platform];
  return (
    <span
      aria-hidden
      className="ltr inline-grid shrink-0 place-items-center rounded-full font-bold leading-none"
      style={{ width: size, height: size, background: look.color, color: look.ink, fontSize: Math.round(size * 0.42), fontFamily: 'system-ui, sans-serif' }}
    >
      {look.mark}
    </span>
  );
}

/**
 * The ad library (/ads, admins): ads running on the platforms, mixed in one feed — search, a platform
 * row, categories, and each ad drawn the way its platform shows it, with the same strength bar under
 * every card. Real ads come from the server's sources; until one is connected, sample ads show
 * under a "preview" banner. Saved ads go to the ideas board (kept on the server).
 */
export function AdLibrary() {
  const { t, fmt } = useI18n();
  const l = t.ads.library;
  const queryClient = useQueryClient();
  const [raw, setRaw] = useState('');
  const [q, setQ] = useState('');
  const [platform, setPlatform] = useState<LibraryPlatform | 'all'>('all');
  const [category, setCategory] = useState<LibraryCategory>('all');
  const [sort, setSort] = useState<'strong' | 'new'>('strong');
  const [board, setBoard] = useState(false);
  const [country, setCountry] = useState(() => remembered(COUNTRY_KEY, 'EG'));
  const [launchCountry, setLaunchCountry] = useState(() => remembered(LAUNCH_KEY, 'EG'));
  const [demoSaved, setDemoSaved] = useState<Set<string>>(() => new Set());
  const [adding, setAdding] = useState(false);

  const pickCountry = (next: string) => {
    setCountry(next);
    remember(COUNTRY_KEY, next);
  };
  const pickLaunchCountry = (next: string) => {
    setLaunchCountry(next);
    remember(LAUNCH_KEY, next);
  };

  const status = useQuery({ queryKey: KEYS.status, queryFn: ({ signal }) => api<LibraryStatus>('/api/ads/library/status', { signal }), staleTime: 5 * 60_000 });
  const connected = Object.values(status.data?.sources ?? {}).some(Boolean);
  // Meta refused the key (not allowed yet, expired): say why, and keep showing the samples meanwhile.
  const [refused, setRefused] = useState<string | null>(null);
  const live = connected && refused === null;
  // Sample ads and the ideas board filter as you type; a real search costs credit, so it waits for
  // Enter (half-typed words would each start a paid search).
  const remote = live && !board;
  useEffect(() => {
    if (remote) return;
    const timer = setTimeout(() => setQ(raw.trim()), 300);
    return () => clearTimeout(timer);
  }, [raw, remote]);
  // After a search, the page goes down to where its ads load.
  const results = useRef<HTMLDivElement>(null);
  const toResults = () => requestAnimationFrame(() => results.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  // "Show more": the same search, bigger (a new run at the provider, so it is asked for, never automatic).
  const [size, setSize] = useState<'normal' | 'more'>('normal');
  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    setQ(raw.trim());
    setSize('normal');
    toResults();
  };
  const pickCategory = (c: LibraryCategory) => {
    setCategory(c);
    setSize('normal');
    if (remote && c !== 'all') toResults();
  };
  // A country the sources don't cover (e.g. remembered from before) falls back to the first they do.
  const countries = status.data?.countries ?? [];
  const searchCountry = countries.includes(country) ? country : (countries[0] ?? country);
  const base = { q, platform, category, country: searchCountry, active: 'true' };
  // Nothing asked yet (no words, no category): no search — a guess would cost credit and show noise.
  const asked = live && !board && Boolean(status.data) && (q !== '' || category !== 'all');
  const page = (which: 'normal' | 'more') => ({
    queryKey: KEYS.search({ ...base, size: which }),
    queryFn: ({ signal }: { signal: AbortSignal }) => api<LibraryPage>(`/api/ads/library?${new URLSearchParams({ ...base, size: which })}`, { signal, timeoutMs: 45_000 }),
    staleTime: 5 * 60_000,
    // A source still fetching (the first Facebook search takes about a minute): ask again shortly.
    refetchInterval: (query: { state: { data?: LibraryPage } }) => ((query.state.data?.pending.length ?? 0) > 0 ? 4_000 : false),
  });
  // The first batch stays as it is; "show more" is a second, bigger search whose new ads go under it.
  const search = useQuery({ ...page('normal'), enabled: asked });
  const more = useQuery({ ...page('more'), enabled: asked && size === 'more' });
  const firstBatch = useMemo(() => search.data?.ads ?? [], [search.data]);
  const extra = useMemo(() => {
    if (size !== 'more' || !more.data) return [];
    const seen = new Set(firstBatch.map((a) => a.id));
    return more.data.ads.filter((a) => !seen.has(a.id));
  }, [size, more.data, firstBatch]);
  const pending = search.data?.pending ?? [];
  const loadingMore = size === 'more' && (more.isPending || (more.data?.pending.length ?? 0) > 0);
  const saved = useQuery({
    queryKey: KEYS.saved,
    queryFn: ({ signal }) => api<(LibraryAd & { savedAt: string })[]>('/api/ads/library/saved', { signal }),
  });
  // The board keeps real and hand-added ads on the server; sample ads only for this visit.
  const savedIds = useMemo(() => new Set([...(saved.data ?? []).map((a) => a.id), ...demoSaved]), [saved.data, demoSaved]);
  const toggle = useMutation({
    mutationFn: ({ ad, on }: { ad: LibraryAd; on: boolean }) =>
      on ? api('/api/ads/library/saved', { method: 'POST', body: { ad } }) : api(`/api/ads/library/saved/${encodeURIComponent(ad.id)}`, { method: 'DELETE' }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: KEYS.saved }),
  });
  const onToggleSave = (ad: LibraryAd) => {
    const on = !savedIds.has(ad.id);
    if (!isSample(ad)) return toggle.mutate({ ad, on });
    setDemoSaved((s) => {
      const next = new Set(s);
      if (on) next.add(ad.id);
      else next.delete(ad.id);
      return next;
    });
  };

  // The pool before the platform filter (for the counts), then the platform, then the order.
  const words = q.toLowerCase();
  const matches = (a: LibraryAd) =>
    (category === 'all' || a.category === category) &&
    (!words || [a.advertiser, a.text, a.title, a.description, a.handle, a.domain].filter(Boolean).join(' ').toLowerCase().includes(words));
  const pool = useMemo(() => {
    if (board) return [...(saved.data ?? []), ...SAMPLE_ADS.filter((a) => demoSaved.has(a.id))].filter(matches);
    if (!live) return SAMPLE_ADS.filter(matches);
    return [...firstBatch, ...extra];
  }, [board, live, saved.data, demoSaved, firstBatch, extra, q, category]);
  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const a of pool) c.set(a.platform, (c.get(a.platform) ?? 0) + 1);
    return c;
  }, [pool]);
  // Each batch is ordered on its own, so ads already on screen never move when more arrive.
  const shown = useMemo(() => {
    const order = (list: LibraryAd[]) => list.filter((a) => platform === 'all' || a.platform === platform).sort((a, b) => (sort === 'strong' ? b.score - a.score : a.days - b.days));
    return remote ? [...order(firstBatch), ...order(extra)] : order(pool);
  }, [remote, firstBatch, extra, pool, platform, sort]);
  const unavailable = new Set(live ? LIBRARY_PLATFORMS.filter((p) => status.data?.sources[p] !== true) : []);
  const comingSoon = !board && live && platform !== 'all' && unavailable.has(platform);
  const loading = live && !board && ((search.isPending && search.fetchStatus !== 'idle') || (pending.length > 0 && firstBatch.length === 0));
  const sourceErrors = Object.entries({ ...search.data?.errors, ...(size === 'more' ? more.data?.errors : undefined) }).filter(
    ([, e]) => e !== 'library_not_allowed' && e !== 'library_token_expired',
  );
  const errorCode = search.error instanceof ApiRequestError ? search.error.code : null;
  useEffect(() => {
    if (errorCode === 'library_not_allowed' || errorCode === 'library_token_expired') setRefused(errorCode);
  }, [errorCode]);
  const savedCount = (saved.data?.length ?? 0) + demoSaved.size;

  return (
    <div className="space-y-5">
      {status.data && !live && (
        <div className="flex items-start gap-3 rounded-xl border border-warning/30 bg-warning/[0.07] px-4 py-3">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="min-w-0 text-sm">
            <p className="font-medium text-ink">{l.demoTitle}</p>
            <p className="mt-0.5 text-muted">{refused === 'library_token_expired' ? l.tokenExpired : refused ? l.notAllowed : l.demoText}</p>
          </div>
          {refused && (
            <button type="button" onClick={() => setRefused(null)} className="ms-auto shrink-0 cursor-pointer rounded-lg border border-line bg-card px-3 py-1.5 text-xs font-medium text-ink-2 hover:text-ink">
              {l.retry}
            </button>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2.5">
        <form onSubmit={submitSearch} className="relative min-w-0 flex-[999_1_22rem]">
          <label className="relative block">
            <Search className="pointer-events-none absolute start-4 top-1/2 size-5 -translate-y-1/2 text-muted" />
            <input
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              // The page's direction, always: an input flipped by its text would put the words under the
              // Search button (its room is kept on the page's end side). Mixed text still reads right.
              style={{ unicodeBidi: 'plaintext' }}
              placeholder={l.search}
              aria-label={l.search}
              enterKeyHint="search"
              className={cx(
                'h-12 w-full rounded-xl border border-line bg-card ps-12 text-[15px] text-ink shadow-xs outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-ring focus:ring-[3px] focus:ring-ring/30',
                // Room for what sits at the end: the clear button (2.25rem) and the Search button (≈5rem).
                remote ? (raw ? 'pe-[8rem]' : 'pe-[5.75rem]') : raw ? 'pe-11' : 'pe-4',
              )}
            />
            {/* Clear and Search side by side at the end, never over the text. */}
            <span className="absolute inset-y-0 end-1.5 flex items-center gap-1">
              {raw && (
                <button
                  type="button"
                  onClick={() => {
                    setRaw('');
                    if (remote) setQ('');
                  }}
                  className="grid size-8 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-ink"
                  aria-label={t.common.close}
                >
                  <X className="size-4" />
                </button>
              )}
              {remote && (
                <button
                  type="submit"
                  disabled={raw.trim() === q}
                  className="h-9 cursor-pointer rounded-lg bg-brand px-4 text-sm font-semibold text-on-brand transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-50"
                >
                  {l.searchButton}
                </button>
              )}
            </span>
          </label>
          {remote && raw.trim() !== q && <p className="absolute -bottom-5 start-1 text-[11px] text-muted">{l.pressEnter}</p>}
        </form>
        {live && !board && (
          <Select
            value={searchCountry}
            onChange={pickCountry}
            aria-label={l.country}
            className="w-40"
            options={countries.map((c) => ({ value: c, label: l.countries[c] ?? c }))}
          />
        )}
        <div role="radiogroup" aria-label={l.sort.strong} className="flex rounded-xl border border-line bg-card p-1">
          {(['strong', 'new'] as const).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={sort === s}
              onClick={() => setSort(s)}
              className={cx('h-9 cursor-pointer rounded-lg px-3.5 text-sm font-medium transition-colors', sort === s ? 'bg-ink text-bg' : 'text-muted hover:text-ink')}
            >
              {l.sort[s]}
            </button>
          ))}
        </div>
      </div>

      <LaunchPanel q={raw} country={launchCountry} onCountry={pickLaunchCountry} />

      <nav aria-label={l.allPlatforms} className="flex flex-wrap gap-2">
        {(['all', ...LIBRARY_PLATFORMS] as const).map((p) => {
          const active = platform === p;
          const color = p === 'all' ? undefined : PLATFORM_LOOK[p].color;
          const count = p === 'all' ? pool.length : (counts.get(p) ?? 0);
          return (
            <button
              key={p}
              type="button"
              aria-pressed={active}
              onClick={() => setPlatform(p)}
              className={cx(
                'flex h-11 cursor-pointer items-center gap-2 rounded-full border bg-card ps-2.5 pe-3.5 text-sm font-semibold transition-[border-color,box-shadow]',
                active ? 'border-2 shadow-sm' : 'border-line text-ink-2 hover:border-line-strong',
              )}
              style={active ? { borderColor: color ?? 'var(--color-ink)' } : undefined}
            >
              {p === 'all' ? (
                <span aria-hidden className="grid size-[22px] place-items-center rounded-full bg-ink text-bg">
                  <Sparkles className="size-3" />
                </span>
              ) : (
                <PlatformMark platform={p} />
              )}
              {p === 'all' ? l.allPlatforms : l.platforms[p]}
              {unavailable.has(p as LibraryPlatform) ? (
                <span className="rounded-full bg-raised px-1.5 py-0.5 text-[10px] font-medium text-muted">{l.soon}</span>
              ) : (
                <span className="text-xs font-normal text-muted tabular-nums">{fmt.number.format(count)}</span>
              )}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="ms-auto flex h-11 cursor-pointer items-center gap-2 rounded-full border border-line bg-card px-3.5 text-sm font-semibold text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
        >
          <Plus className="size-4" />
          {l.add.button}
        </button>
        <button
          type="button"
          aria-pressed={board}
          onClick={() => setBoard((b) => !b)}
          className={cx(
            'flex h-11 cursor-pointer items-center gap-2 rounded-full border px-3.5 text-sm font-semibold transition-colors',
            board ? 'border-brand bg-brand/10 text-brand' : 'border-line bg-card text-ink-2 hover:border-line-strong',
          )}
        >
          <Bookmark className={cx('size-4', board && 'fill-current')} />
          {l.saved}
          <span className="text-xs font-normal tabular-nums opacity-70">{fmt.number.format(savedCount)}</span>
        </button>
      </nav>

      <div className="flex flex-wrap gap-1.5">
        {LIBRARY_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={category === c}
            onClick={() => pickCategory(c)}
            className={cx(
              'h-9 cursor-pointer rounded-full border px-3.5 text-[13px] transition-colors',
              category === c ? 'border-brand bg-brand text-on-brand' : 'border-line text-ink-2 hover:border-line-strong hover:text-ink',
            )}
          >
            {l.categories[c]}
          </button>
        ))}
      </div>

      <div ref={results} className="flex scroll-mt-4 flex-wrap items-center justify-between gap-2 border-t border-line pt-3.5 text-xs text-muted">
        <p className="text-sm">
          <strong className="text-ink">{l.results(shown.length)}</strong>
        </p>
        <p className="flex flex-wrap items-center gap-3">
          <span className="flex items-center gap-1">
            <Info className="size-3.5" /> {l.scoreHint}
          </span>
          {(['high', 'mid', 'low'] as const).map((tier) => (
            <span key={tier} className="flex items-center gap-1.5">
              <span className={cx('size-2.5 rounded-full', TIER_TONE[tier].split(' ')[0])} />
              {l.tiers[tier]}
            </span>
          ))}
        </p>
      </div>
      {live && !board && (
        <div className="-mt-3 space-y-1 text-xs">
          <p className="text-faint">{l.sourcesNote}</p>
          {pending.length > 0 && (
            <p className="flex items-center gap-1.5 text-brand">
              <Loader2 className="size-3.5 animate-spin" /> {l.fetching(pending.map((p) => l.platforms[p as LibraryPlatform] ?? p).join(' · '))}
            </p>
          )}
          {sourceErrors.map(([source, message]) => (
            <p key={source} className="text-critical">
              {l.sourceFailed(l.platforms[source as LibraryPlatform] ?? source)}: <span className="ltr">{message}</span>
            </p>
          ))}
        </div>
      )}

      {comingSoon ? (
        <Empty title={l.soonTitle(l.platforms[platform as LibraryPlatform])} text={l.soonText} icon={<PlatformMark platform={platform as LibraryPlatform} size={40} />} />
      ) : loading ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="h-80 animate-pulse rounded-2xl bg-raised" style={{ animationDelay: `${i * 70}ms` }} />
          ))}
        </div>
      ) : search.isError && !board ? (
        <Empty
          title={l.failed}
          text={errorCode === 'library_token_expired' ? l.tokenExpired : errorCode === 'library_not_allowed' ? l.notAllowed : errorMessage(search.error)}
          icon={<Info className="size-8 text-critical" />}
        />
      ) : remote && !q && category === 'all' ? (
        <Empty title={l.startTitle} text={l.startText} icon={<Search className="size-8 text-muted" />} />
      ) : shown.length === 0 ? (
        <Empty title={board ? l.emptySaved : l.empty} />
      ) : (
        <div className="grid items-stretch gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {shown.map((ad, i) => (
            <AdCard key={ad.id} ad={ad} index={i} saved={savedIds.has(ad.id)} onToggleSave={() => onToggleSave(ad)} />
          ))}
        </div>
      )}

      {remote && !comingSoon && size === 'normal' && pending.length === 0 && firstBatch.length >= 20 && (
        <div className="flex flex-col items-center gap-1.5 pt-1">
          <Button variant="outline" onClick={() => setSize('more')} icon={<Plus className="size-4" />}>
            {l.showMore}
          </Button>
          <p className="text-xs text-muted">{l.showMoreHint}</p>
        </div>
      )}
      {remote && !comingSoon && loadingMore && (
        <div className="flex flex-col items-center gap-3 pt-1">
          <div className="grid w-full gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="h-72 animate-pulse rounded-2xl bg-raised" style={{ animationDelay: `${i * 70}ms` }} />
            ))}
          </div>
          <p className="flex items-center gap-2 text-sm text-brand">
            <Loader2 className="size-4 animate-spin" /> {l.loadingMore}
          </p>
        </div>
      )}
      {remote && size === 'more' && !loadingMore && more.data && extra.length === 0 && <p className="text-center text-sm text-muted">{l.noMore}</p>}

      {adding && (
        <AddAdDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            setBoard(true);
            void queryClient.invalidateQueries({ queryKey: KEYS.saved });
          }}
        />
      )}
    </div>
  );
}

/**
 * Each platform's own public library, opened on the words typed above and the country picked here —
 * every country, today, with no approval needed. Ads seen there come back through "Add an ad".
 */
function LaunchPanel({ q, country, onCountry }: { q: string; country: string; onCountry: (c: string) => void }) {
  const { t } = useI18n();
  const l = t.ads.library;
  return (
    <section className="rounded-2xl border border-line bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
          <Globe className="size-5" />
        </span>
        <span className="min-w-0 flex-[999_1_16rem]">
          <span className="block text-[15px] font-semibold">{l.launch.title}</span>
          <span className="block text-sm text-muted">{l.launch.text}</span>
        </span>
        <Select
          value={country}
          onChange={onCountry}
          aria-label={l.country}
          className="w-44"
          options={LAUNCH_COUNTRIES.map((c) => ({ value: c, label: l.countries[c] ?? c }))}
        />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {LIBRARY_PLATFORMS.map((p) => {
          const link = libraryLink(p, q, country);
          return (
            <a
              key={p}
              href={link.url}
              target="_blank"
              rel="noreferrer"
              title={l.launch.open(l.platforms[p])}
              className="group flex min-h-14 items-center gap-2.5 rounded-xl border border-line px-3 py-2 transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-sm"
            >
              <PlatformMark platform={p} size={28} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{l.platforms[p]}</span>
                <span className="block truncate text-[11px] text-muted">
                  {LIBRARY_REACH[p] === 'eu' ? l.launch.eu : link.typed ? l.launch.typed : l.launch.ready}
                </span>
              </span>
              <ArrowUpRight className={cx('size-4 shrink-0 text-muted transition-colors group-hover:text-ink', flip)} />
            </a>
          );
        })}
      </div>
    </section>
  );
}

/** An ad found in a platform's own library, saved by its link with a note. */
function AddAdDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const l = t.ads.library;
  const a = l.add;
  const [link, setLink] = useState('');
  const [platform, setPlatform] = useState<LibraryPlatform | null>(null);
  const [advertiser, setAdvertiser] = useState('');
  const [text, setText] = useState('');
  const [days, setDays] = useState('');
  const [category, setCategory] = useState<LibraryCategory>('all');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const detected = platformOf(link);
  const chosen = platform ?? detected;
  const validLink = /^https?:\/\/\S+\.\S+/.test(link.trim());

  const save = useMutation({
    mutationFn: () => {
      const runDays = Math.max(0, Math.min(3650, Number.parseInt(days, 10) || 0));
      const id = `manual:${crypto.randomUUID()}`;
      const ad: LibraryAd = {
        id,
        platform: chosen!,
        placements: [chosen!],
        externalId: id,
        advertiser: advertiser.trim() || new URL(link.trim()).hostname.replace(/^www\./, ''),
        advertiserId: null,
        text: text.trim() || null,
        title: null,
        description: null,
        domain: null,
        startedAt: runDays ? new Date(Date.now() - runDays * 86_400_000).toISOString() : null,
        stoppedAt: null,
        active: true,
        days: runDays,
        variants: 1,
        countries: [],
        languages: [],
        reach: null,
        category: category === 'all' ? null : category,
        score: strength(runDays),
        url: link.trim(),
        manual: true,
        ...(note.trim() ? { note: note.trim() } : {}),
      };
      return api('/api/ads/library/saved', { method: 'POST', body: { ad } });
    },
    onSuccess: onSaved,
    onError: (err) => setError(errorMessage(err)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!validLink) return setError(a.invalid);
    if (!chosen) return setError(a.pickPlatform);
    setError(null);
    save.mutate();
  };
  const field =
    'h-11 w-full rounded-xl border border-line bg-card px-3 text-sm text-ink outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-ring focus:ring-[3px] focus:ring-ring/30';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const previewDays = Number.parseInt(days, 10) || 0;
  const previewScore = strength(previewDays);
  const previewTier = scoreTier(previewScore);
  const look = chosen ? PLATFORM_LOOK[chosen] : null;

  return createPortal(
    <div className="animate-fade-in fixed inset-0 z-[65] flex items-end justify-center bg-black/55 backdrop-blur-[2px] sm:items-center sm:p-6" onClick={onClose}>
      <form
        role="dialog"
        aria-modal
        aria-label={a.title}
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="animate-scale-in flex max-h-[94svh] w-full max-w-4xl flex-col overflow-hidden rounded-t-3xl border border-line bg-card shadow-2xl sm:rounded-3xl"
      >
        <header className="flex items-start gap-3 border-b border-line px-5 py-4">
          <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand/10 text-brand">
            <Bookmark className="size-5" />
          </span>
          <span className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">{a.title}</h2>
            <p className="text-xs text-muted">{a.text}</p>
          </span>
          <button type="button" onClick={onClose} aria-label={t.common.close} className="grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-ink">
            <X className="size-5" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto md:grid md:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
          {/* The ad itself: its link, the platform (found from the link), and how its card will look. */}
          <section className="flex flex-col gap-4 border-b border-line bg-raised/40 p-5 md:border-e md:border-b-0">
            <label className="grid gap-1.5">
              <span className="text-sm font-semibold">{a.link}</span>
              <span className="relative">
                <Link2 className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                <input
                  autoFocus={typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches}
                  dir="ltr"
                  inputMode="url"
                  value={link}
                  onChange={(e) => setLink(e.target.value)}
                  placeholder="https://www.facebook.com/ads/library/?id=…"
                  className={cx(field, 'ps-9 font-mono text-[13px]')}
                />
              </span>
              <span className="text-xs text-muted">{a.linkHint}</span>
            </label>

            <div className="grid gap-1.5">
              <span className="text-sm font-semibold">{a.platform}</span>
              <div role="radiogroup" aria-label={a.platform} className="grid grid-cols-4 gap-2">
                {LIBRARY_PLATFORMS.map((p) => {
                  const active = chosen === p;
                  return (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setPlatform(p)}
                      className={cx(
                        'relative flex cursor-pointer flex-col items-center gap-1.5 rounded-xl border bg-card px-1 py-2.5 text-[11px] font-medium transition-[border-color,box-shadow]',
                        active ? 'border-2 shadow-sm' : 'border-line text-ink-2 hover:border-line-strong',
                      )}
                      style={active ? { borderColor: PLATFORM_LOOK[p].color } : undefined}
                    >
                      <PlatformMark platform={p} size={26} />
                      <span className="w-full truncate text-center">{l.platforms[p]}</span>
                      {active && !platform && detected === p && (
                        <span className="absolute -top-2 rounded-full bg-brand px-1.5 py-px text-[9px] font-semibold text-on-brand">{a.auto}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-1.5">
              <span className="text-sm font-semibold">{a.preview}</span>
              <div className="overflow-hidden rounded-2xl border border-line bg-card shadow-xs">
                <span aria-hidden className="block h-1 w-full" style={{ background: look?.color ?? 'var(--color-line)' }} />
                <div className="flex items-center gap-2.5 p-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-raised text-sm font-bold text-ink-2">{(advertiser.trim() || '؟').slice(0, 1)}</span>
                  <span className="min-w-0 flex-1">
                    <span dir="auto" className="block truncate text-sm font-semibold">{advertiser.trim() || a.advertiser}</span>
                    <span className="flex items-center gap-1.5 text-[11px] text-muted">
                      {chosen && <PlatformMark platform={chosen} size={14} />}
                      {previewDays ? l.running(previewDays) : '—'}
                    </span>
                  </span>
                  <span className={cx('flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-bold tabular-nums', TIER_TONE[previewTier])}>
                    <Zap className="size-3 fill-current" />
                    {previewScore}
                  </span>
                </div>
                {(text.trim() || note.trim()) && (
                  <div className="space-y-1.5 px-3 pb-3">
                    {text.trim() && (
                      <p dir="auto" className="line-clamp-2 text-[13px] leading-relaxed text-ink-2">
                        {text}
                      </p>
                    )}
                    {note.trim() && (
                      <p dir="auto" className="line-clamp-2 rounded-lg bg-brand/[0.07] px-2 py-1 text-xs text-ink-2">
                        <strong className="text-brand">{l.myNote}:</strong> {note}
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* The details: who, how long, what it says, its category, and why it's worth keeping. */}
          <section className="flex flex-col gap-4 p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="grid gap-1.5">
                <span className="text-sm font-semibold">{a.advertiser}</span>
                <input value={advertiser} onChange={(e) => setAdvertiser(e.target.value)} dir="auto" className={field} />
              </label>
              <label className="grid gap-1.5">
                <span className="text-sm font-semibold">{a.days}</span>
                <input value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" dir="ltr" placeholder="30" className={field} />
              </label>
            </div>
            <label className="grid gap-1.5">
              <span className="text-sm font-semibold">{a.adText}</span>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} dir="auto" className={cx(field, 'h-auto resize-none py-2.5 leading-relaxed')} />
            </label>
            <div className="grid gap-1.5">
              <span className="text-sm font-semibold">{a.category}</span>
              <div className="flex flex-wrap gap-1.5">
                {LIBRARY_CATEGORIES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={category === c}
                    onClick={() => setCategory(c)}
                    className={cx(
                      'h-8 cursor-pointer rounded-full border px-3 text-xs transition-colors',
                      category === c ? 'border-brand bg-brand text-on-brand' : 'border-line text-ink-2 hover:border-line-strong',
                    )}
                  >
                    {l.categories[c]}
                  </button>
                ))}
              </div>
            </div>
            <label className="grid gap-1.5">
              <span className="text-sm font-semibold">{a.note}</span>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} dir="auto" className={cx(field, 'h-auto resize-none py-2.5 leading-relaxed')} />
            </label>
          </section>
        </div>

        <footer className="flex flex-wrap items-center gap-3 border-t border-line px-5 py-3">
          <div className="min-w-0 flex-1">
            <ErrorNote>{error}</ErrorNote>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button type="submit" variant="brand" loading={save.isPending} icon={<Bookmark className="size-4" />}>
              {a.save}
            </Button>
          </div>
        </footer>
      </form>
    </div>,
    document.body,
  );
}

function Empty({ title, text, icon }: { title: string; text?: string; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line-strong bg-raised/30 px-6 py-14 text-center">
      {icon}
      <p className="font-medium text-ink">{title}</p>
      {text && <p className="max-w-md text-sm text-muted">{text}</p>}
    </div>
  );
}

/** Call-to-action labels as Meta returns them (English), said the way an Arabic page says them. */
const CTA_AR: Record<string, string> = {
  'send message': 'أرسل رسالة',
  'send whatsapp message': 'راسلنا واتساب',
  whatsapp: 'واتساب',
  message: 'راسلنا',
  'shop now': 'تسوق الآن',
  'buy now': 'اشترِ الآن',
  'order now': 'اطلب الآن',
  'learn more': 'اعرف المزيد',
  'sign up': 'سجّل الآن',
  'book now': 'احجز الآن',
  'visit profile': 'زيارة الصفحة',
  'like page': 'أعجبني',
  download: 'تحميل',
  'install now': 'ثبّت الآن',
  'use app': 'استخدم التطبيق',
  'contact us': 'تواصل معنا',
  'call now': 'اتصل الآن',
  'get offer': 'احصل على العرض',
  'get quote': 'اطلب عرض سعر',
  'apply now': 'قدّم الآن',
  subscribe: 'اشترك',
  'watch more': 'شاهد المزيد',
  'see menu': 'شوف المنيو',
  'get directions': 'الاتجاهات',
  'get started': 'ابدأ الآن',
  'open link': 'افتح الرابط',
  'listen now': 'استمع الآن',
  'play game': 'العب الآن',
  'donate now': 'تبرّع الآن',
};

/** Where a Meta ad also runs, as small marks (Facebook, Instagram, Messenger, Threads). */
const PLACEMENT_LOOK: Record<string, { mark: string; color: string; ink: string; name: string }> = {
  facebook: { mark: 'f', color: '#1877f2', ink: '#ffffff', name: 'Facebook' },
  instagram: { mark: 'ig', color: '#d62976', ink: '#ffffff', name: 'Instagram' },
  messenger: { mark: 'm', color: '#0084ff', ink: '#ffffff', name: 'Messenger' },
  threads: { mark: '@', color: '#111111', ink: '#ffffff', name: 'Threads' },
  audience_network: { mark: 'an', color: '#5b6b7a', ink: '#ffffff', name: 'Audience Network' },
};

function Placements({ ad }: { ad: LibraryAd }) {
  const list = ad.placements.filter((p) => PLACEMENT_LOOK[p]);
  if (list.length === 0) return <PlatformMark platform={ad.platform} size={16} />;
  return (
    <span className="flex items-center -space-x-1 rtl:space-x-reverse">
      {list.slice(0, 4).map((p) => {
        const look = PLACEMENT_LOOK[p]!;
        return (
          <span
            key={p}
            title={look.name}
            className="ltr grid size-4 place-items-center rounded-full text-[7px] leading-none font-bold ring-2 ring-card"
            style={{ background: look.color, color: look.ink, fontFamily: 'system-ui, sans-serif' }}
          >
            {look.mark}
          </span>
        );
      })}
    </span>
  );
}

function Avatar({ ad, size = 'size-9', square }: { ad: LibraryAd; size?: string; square?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (ad.avatar && !broken)
    return <img src={ad.avatar} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className={cx('pii shrink-0 object-cover ring-1 ring-line', size, square ? 'rounded-lg' : 'rounded-full')} />;
  return (
    <span className={cx('grid shrink-0 place-items-center bg-raised text-sm font-bold text-ink-2', size, square ? 'rounded-lg' : 'rounded-full')}>
      {ad.advertiser.trim().slice(0, 1)}
    </span>
  );
}

/**
 * The creative in a fixed frame (so a row of cards lines up): the picture, or a video's still that plays
 * in place when tapped; a stand-in that opens the ad when the source gave no picture.
 */
function Media({ ad, ratio }: { ad: LibraryAd; ratio: string }) {
  const { t } = useI18n();
  const l = t.ads.library;
  const [broken, setBroken] = useState(false);
  const [playing, setPlaying] = useState(false);
  const format = ad.format ? (l.formats[ad.format as keyof typeof l.formats] ?? null) : ad.video ? l.formats.video : null;
  const badge = format && (
    <span className="absolute start-2 top-2 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-sm">{format}</span>
  );

  if (ad.video && playing && !broken) {
    return (
      <div className="relative w-full bg-black" style={{ aspectRatio: ratio }}>
        <video src={ad.video} poster={ad.image} controls autoPlay playsInline onError={() => setBroken(true)} className="pii absolute inset-0 size-full object-contain" />
      </div>
    );
  }
  if (ad.image && !broken) {
    return (
      <div className="relative w-full overflow-hidden bg-raised" style={{ aspectRatio: ratio }}>
        <img src={ad.image} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="pii absolute inset-0 size-full object-cover" />
        {badge}
        {ad.video && (
          <button
            type="button"
            onClick={() => setPlaying(true)}
            aria-label={t.chats.media.play}
            className="absolute inset-0 grid cursor-pointer place-items-center bg-black/10 transition-colors hover:bg-black/25"
          >
            <span className="grid size-14 place-items-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur-sm transition-transform hover:scale-105">
              <Play className="size-6 translate-x-0.5 fill-current" />
            </span>
          </button>
        )}
      </div>
    );
  }
  const stand = (
    <span className="flex flex-col items-center gap-1.5 text-center text-xs text-muted">
      <PlatformMark platform={ad.platform} size={28} />
      <span className="font-medium">{l.media}</span>
      {ad.url && <span className="opacity-80">{l.mediaHint}</span>}
    </span>
  );
  const frame = 'relative grid w-full place-items-center overflow-hidden bg-raised';
  return ad.url ? (
    <a href={ad.url} target="_blank" rel="noreferrer" className={cx(frame, 'transition-colors hover:bg-raised/70')} style={{ aspectRatio: ratio }}>
      {stand}
      {badge}
    </a>
  ) : (
    <div className={frame} style={{ aspectRatio: ratio }}>
      {stand}
      {badge}
    </div>
  );
}

/** Long ad copy: three lines, and the rest on demand. */
function AdText({ text }: { text: string }) {
  const { t } = useI18n();
  const l = t.ads.library;
  const [open, setOpen] = useState(false);
  const long = text.length > 150 || text.split('\n').length > 3;
  return (
    <div className="text-[13.5px] leading-relaxed text-ink-2">
      <p dir="auto" className={cx('pii break-words whitespace-pre-line', !open && 'line-clamp-3')}>
        {text}
      </p>
      {long && (
        <button type="button" onClick={() => setOpen((o) => !o)} className="mt-0.5 cursor-pointer text-xs font-semibold text-brand hover:underline">
          {open ? l.less : l.moreText}
        </button>
      )}
    </div>
  );
}

function Stat({ icon: Icon, children }: { icon: typeof Layers; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1 text-[11.5px] text-muted">
      <Icon className="size-3.5" />
      {children}
    </span>
  );
}

/**
 * One ad: the advertiser and where/how long it runs, the creative in a fixed frame, the copy, the call
 * to action, and the same stats bar under every card. The platform's color runs along the top.
 */
function AdCard({ ad, index, saved, onToggleSave }: { ad: LibraryAd; index: number; saved: boolean; onToggleSave: () => void }) {
  const { t, fmt, lang } = useI18n();
  const l = t.ads.library;
  const look = PLATFORM_LOOK[ad.platform];
  const tier = scoreTier(ad.score);
  const cta = ad.cta ? (lang === 'ar' ? (CTA_AR[ad.cta.trim().toLowerCase()] ?? ad.cta) : ad.cta) : null;
  const text = ad.text ?? ad.description;
  // Search ads are words, not pictures: drawn as the result Google shows.
  const searchAd = ad.platform === 'google' && !ad.image;
  const ratio = ad.platform === 'youtube' ? '16 / 9' : ad.platform === 'tiktok' || ad.platform === 'snapchat' ? '9 / 14' : '4 / 5';

  return (
    <article
      className="animate-fade-up flex h-full flex-col overflow-hidden rounded-2xl border border-line bg-card shadow-xs transition-shadow hover:shadow-md"
      style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
    >
      <span aria-hidden className="h-1 w-full shrink-0" style={{ background: look.color }} />
      <header className="flex items-center gap-2.5 px-3 pt-3 pb-2.5">
        <Avatar ad={ad} square={ad.platform === 'linkedin'} />
        <div className="min-w-0 flex-1">
          <p className="pii truncate text-sm font-semibold text-ink">{ad.advertiser}</p>
          <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
            <Placements ad={ad} />
            <span className="truncate">{ad.active ? l.running(ad.days) : l.ran(ad.days)}</span>
          </p>
        </div>
        <span
          className={cx('flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-bold tabular-nums', TIER_TONE[tier])}
          title={`${l.tiers[tier]} — ${l.scoreHint}`}
        >
          <Zap className="size-3 fill-current" />
          {ad.score}
        </span>
      </header>

      {searchAd ? (
        <div className="mx-3 mb-1 flex flex-col gap-1 rounded-xl border border-line bg-raised/30 p-3">
          <span className="text-[12px] text-ink-2">
            <strong>{l.ad}</strong> · <span className="ltr">{ad.domain ?? ad.advertiser}</span>
          </span>
          {ad.title && <span dir="auto" className="line-clamp-2 text-[15px] leading-snug text-[#1a0dab] dark:text-[#8ab4f8]">{ad.title}</span>}
        </div>
      ) : (
        <Media ad={ad} ratio={ratio} />
      )}

      <div className="flex flex-1 flex-col gap-2 px-3 pt-2.5 pb-3">
        {ad.title && !searchAd && (
          <p dir="auto" className="pii line-clamp-2 text-sm font-semibold text-ink">
            {ad.title}
          </p>
        )}
        {text && <AdText text={text} />}
        {ad.note && (
          <p dir="auto" className="rounded-lg bg-brand/[0.07] px-2.5 py-1.5 text-xs leading-relaxed text-ink-2">
            <strong className="text-brand">{l.myNote}:</strong> {ad.note}
          </p>
        )}
        {(ad.domain || cta) && (
          <div className="mt-auto flex items-center gap-2 pt-1">
            {ad.domain && !searchAd && <span className="ltr min-w-0 flex-1 truncate text-start text-[11px] text-faint uppercase">{ad.domain}</span>}
            {cta && <span className="ms-auto shrink-0 rounded-lg border border-line bg-raised/60 px-2.5 py-1 text-xs font-semibold text-ink">{cta}</span>}
          </div>
        )}
      </div>

      <footer className="flex items-center gap-3 border-t border-line/70 px-3 py-2">
        <Stat icon={Layers}>{l.variants(ad.variants)}</Stat>
        <Stat icon={Globe}>{l.countriesCount(Math.max(ad.countries.length, 1))}</Stat>
        {ad.reach !== null && <Stat icon={Eye}>{fmt.number.format(ad.reach)}</Stat>}
        <span className="ms-auto flex items-center gap-0.5">
          {ad.url && (
            <a href={ad.url} target="_blank" rel="noreferrer" aria-label={l.open} title={l.open} className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-raised hover:text-ink">
              <ExternalLink className="size-4" />
            </a>
          )}
          <button
            type="button"
            onClick={onToggleSave}
            aria-pressed={saved}
            aria-label={saved ? l.unsave : l.save}
            title={saved ? l.unsave : l.save}
            className={cx('grid size-8 cursor-pointer place-items-center rounded-lg transition-colors', saved ? 'bg-brand/10 text-brand' : 'text-muted hover:bg-raised hover:text-ink')}
          >
            <Bookmark className={cx('size-4', saved && 'fill-current')} />
          </button>
        </span>
      </footer>
    </article>
  );
}
