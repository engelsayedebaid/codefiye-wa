import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BROADCAST_LIMITS, BROADCAST_PACE_IDS, type BroadcastPace, estimateDuration, rotationSplit } from '@wa/shared/broadcasts';
import { planHasFeature } from '@wa/shared/plans';
import type { MessageStatus } from '@wa/shared/constants';
import { POLL_LIMITS, type TemplateParts, templatePartsVariables } from '@wa/shared/template-text';
import {
  ArrowLeft,
  BadgePercent,
  Bold,
  BookOpen,
  Building2,
  CalendarCheck,
  CalendarDays,
  ChartColumn,
  Check,
  CheckCheck,
  CircleStop,
  Clock,
  Code,
  Copy,
  Dumbbell,
  FileSpreadsheet,
  Gauge,
  Gift,
  GraduationCap,
  HeartHandshake,
  Image as ImageIcon,
  Italic,
  LayoutGrid,
  ListChecks,
  Lock,
  type LucideIcon,
  Megaphone,
  Moon,
  PartyPopper,
  PenLine,
  Plus,
  Rocket,
  Send,
  ShieldCheck,
  ShoppingCart,
  Smartphone,
  Smile,
  Sparkles,
  Star,
  Stethoscope,
  Store,
  Strikethrough,
  Ticket,
  Timer,
  TriangleAlert,
  Trophy,
  Truck,
  Upload,
  UserPlus,
  UserRound,
  Users,
  UtensilsCrossed,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import {
  type CSSProperties,
  type DragEvent,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { api, errorMessage } from '../api';
import { useAccount } from '../app/account';
import { buildAudience, type Entry, parseManual, rowsToEntries } from '../app/recipients';
import { readSheet, SheetError } from '../app/spreadsheet';
import { useLiveEvents } from '../events';
import { useI18n } from '../i18n';
import type { Dict } from '../i18n/ar';
import { debouncedInvalidate, qk } from '../queries';
import { Link, navigate, useQuery as useSearchParams } from '../router';
import type { Session, Template } from '../types';
import {
  Badge,
  Button,
  cx,
  delay,
  EmptyState,
  ErrorNote,
  flip,
  inputClass,
  LoadError,
  Loading,
  MESSAGE_STATUS,
  Modal,
  PageHeader,
  Select,
  SessionStatusBadge,
  StatusIcon,
  SuccessNote,
  type Tone,
  TONES,
} from '../ui';
import { TemplatePreview, WhatsAppText } from './Templates';

// --- API shapes (apps/api/src/routes/broadcasts.ts) --------------------------------------------------

type Stats = { queued: number; sending: number; sent: number; delivered: number; read: number; failed: number };
type CampaignState = 'running' | 'done' | 'cancelled';

type Campaign = {
  id: string;
  name: string;
  template: { body: string; imageUrl: string | null; buttons: string[] | null; buttonsTitle: string | null };
  sessionIds: string[];
  rotateEvery: number;
  pace: BroadcastPace;
  recipients: number;
  state: CampaignState;
  stats: Stats;
  finishesAt: string | null;
  createdAt: string;
  cancelledAt: string | null;
};

type CampaignDetail = Campaign & {
  sessions: { id: string; name: string; phone: string | null; status: string; total: number; done: number; failed: number; pending: number }[];
  recent: { id: number; phone: string | null; sessionId: string; status: MessageStatus; error: string | null; updatedAt: string }[];
  failures: { phone: string | null; error: string | null }[];
};

type Created = { id: string; recipients: number; skippedCount: number; finishesAt: string | null };

/** The campaign launched from this tab, so its page can say so (and how many numbers were left out). */
let lastLaunch: Created | null = null;

// --- ready-made ad templates -----------------------------------------------------------------------

type AdId = keyof Dict['ads']['templates'];
type AdCat = Exclude<keyof Dict['ads']['gallery']['categories'], 'all'>;
type AdStyle = { id: AdId; cat: AdCat; icon: LucideIcon; from: string; to: string; imageUrl?: string };

const photo = (id: string) => `https://images.unsplash.com/${id}?w=800&q=80`;

/** Display order and look; the copy lives in i18n (`ads.templates`). Grouped by category for the gallery filter. */
const ADS: AdStyle[] = [
  // offers & products
  { id: 'flash', cat: 'offers', icon: Zap, from: '#f97316', to: '#e11d48' },
  { id: 'launch', cat: 'offers', icon: Rocket, from: '#8b5cf6', to: '#4338ca', imageUrl: photo('photo-1505740420928-5e560c06d30e') },
  { id: 'coupon', cat: 'offers', icon: Ticket, from: '#10b981', to: '#0f766e' },
  { id: 'shipping', cat: 'offers', icon: Truck, from: '#84cc16', to: '#15803d' },
  { id: 'blackfriday', cat: 'offers', icon: BadgePercent, from: '#1f2937', to: '#b91c1c', imageUrl: photo('photo-1607083206869-4c7672e72a8a') },
  { id: 'bundle', cat: 'offers', icon: Gift, from: '#d946ef', to: '#a21caf' },
  { id: 'cart', cat: 'offers', icon: ShoppingCart, from: '#fbbf24', to: '#d97706', imageUrl: photo('photo-1556742049-0cfed4f6a45d') },
  // events & occasions
  { id: 'seasonal', cat: 'events', icon: Moon, from: '#f59e0b', to: '#92400e' },
  { id: 'event', cat: 'events', icon: PartyPopper, from: '#ec4899', to: '#86198f', imageUrl: photo('photo-1492684223066-81342ee5ff30') },
  { id: 'webinar', cat: 'events', icon: GraduationCap, from: '#3b82f6', to: '#4f46e5' },
  { id: 'opening', cat: 'events', icon: Store, from: '#4ade80', to: '#15803d', imageUrl: photo('photo-1472851294608-062f824d29cc') },
  { id: 'appointment', cat: 'events', icon: CalendarCheck, from: '#f43f5e', to: '#be123c' },
  // customers & engagement
  { id: 'winback', cat: 'customers', icon: HeartHandshake, from: '#0ea5e9', to: '#0e7490' },
  { id: 'giveaway', cat: 'customers', icon: Trophy, from: '#eab308', to: '#c2410c' },
  { id: 'survey', cat: 'customers', icon: ChartColumn, from: '#64748b', to: '#1e293b' },
  { id: 'referral', cat: 'customers', icon: UserPlus, from: '#22d3ee', to: '#2563eb', imageUrl: photo('photo-1529156069898-49953e39b3ac') },
  { id: 'review', cat: 'customers', icon: Star, from: '#fde047', to: '#ea580c' },
  // business & services
  { id: 'restaurant', cat: 'business', icon: UtensilsCrossed, from: '#ef4444', to: '#c2410c', imageUrl: photo('photo-1568901346375-23c9450c58cd') },
  { id: 'realestate', cat: 'business', icon: Building2, from: '#14b8a6', to: '#115e59', imageUrl: photo('photo-1600596542815-ffad4c1539a9') },
  { id: 'clinic', cat: 'business', icon: Stethoscope, from: '#60a5fa', to: '#0369a1', imageUrl: photo('photo-1576091160399-112ba8d25d1d') },
  { id: 'gym', cat: 'business', icon: Dumbbell, from: '#f87171', to: '#991b1b', imageUrl: photo('photo-1534438327276-14e5300c3a48') },
  { id: 'education', cat: 'business', icon: BookOpen, from: '#a78bfa', to: '#6d28d9', imageUrl: photo('photo-1503676260728-1c00da094a0b') },
];

/** Gallery filter chips (icon only; labels live in `ads.gallery.categories`). */
const AD_CATS: { id: 'all' | AdCat; icon: LucideIcon }[] = [
  { id: 'all', icon: LayoutGrid },
  { id: 'offers', icon: BadgePercent },
  { id: 'events', icon: CalendarDays },
  { id: 'customers', icon: Users },
  { id: 'business', icon: Store },
];

const EMOJIS = ['🔥', '⚡', '🎁', '🎉', '✨', '✅', '👉', '👇', '🛒', '🛍️', '💥', '⏳', '⭐', '🚀', '💚', '😍', '💰', '🏷️', '📍', '📞'];
const ROTATE_EVERY = [1, 5, 10, 25, 50];
const PACE_ICONS: Record<BroadcastPace, LucideIcon> = { safe: ShieldCheck, normal: Gauge, fast: Zap };

type Draft = { source: AdId | 'blank' | 'saved' | null; body: string; imageUrl: string; buttons: string[]; buttonsTitle: string };
const EMPTY_DRAFT: Draft = { source: null, body: '', imageUrl: '', buttons: [], buttonsTitle: '' };

const sendableSession = (s: Session) => s.desiredState === 'running' && (s.status === 'connected' || s.status === 'connecting');
const processedOf = (s: Stats) => s.sent + s.delivered + s.read + s.failed;
const prefersReducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// --- small pieces ----------------------------------------------------------------------------------

function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors duration-200 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-brand' : 'bg-line-strong',
      )}
    >
      <span
        className={cx(
          'inline-block size-5 rounded-full bg-white shadow transition-transform duration-200',
          checked ? 'translate-x-5.5 rtl:-translate-x-5.5' : 'translate-x-0.5 rtl:-translate-x-0.5',
        )}
      />
    </button>
  );
}

function Step({ n, title, text, done, current, children, index }: { n: number; title: string; text: string; done: boolean; current: boolean; children: ReactNode; index: number }) {
  return (
    <section id={`ads-step-${n}`} className="animate-fade-up relative scroll-mt-6 overflow-hidden rounded-xl border border-line bg-card shadow-sm" style={delay(index * 80)}>
      <span
        aria-hidden
        className={cx('absolute inset-y-0 start-0 w-1 transition-colors duration-500', done ? 'bg-gradient-to-b from-[#3BE37F] to-[#0E9488]' : 'bg-transparent')}
      />
      <header className="flex items-start gap-3 px-5 pt-5">
        <span
          className={cx(
            'flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold transition-all duration-300',
            done ? 'bg-brand text-black shadow-[0_0_20px_-6px] shadow-brand' : current ? 'bg-raised text-ink ring-2 ring-brand/50' : 'bg-raised text-ink',
          )}
        >
          {done ? <Check className="animate-scale-in size-4" /> : n}
        </span>
        <div className="min-w-0 space-y-1">
          <h2 className="leading-tight font-semibold">{title}</h2>
          <p className="text-sm text-muted">{text}</p>
        </div>
      </header>
      <div className="p-5">{children}</div>
    </section>
  );
}

/** Counts from the previous value to the new one (instantly with reduced motion). */
function useCountUp(value: number) {
  const [shown, setShown] = useState(value);
  const current = useRef(value);
  useEffect(() => {
    const from = current.current;
    if (from === value) return;
    if (prefersReducedMotion()) {
      current.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / 700);
      const next = Math.round(from + (value - from) * (1 - (1 - k) ** 3));
      current.current = next;
      setShown(next);
      if (k < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return shown;
}

function StateBadge({ state }: { state: CampaignState }) {
  const { t } = useI18n();
  const l = t.ads.live;
  if (state === 'running') {
    return (
      <Badge tone="progress" className="gap-1.5">
        <span className="relative flex size-2">
          <span className="absolute inset-0 animate-ping rounded-full bg-purple-400" />
          <span className="relative size-2 rounded-full bg-purple-400" />
        </span>
        {l.running}
      </Badge>
    );
  }
  return state === 'done' ? (
    <Badge tone="good" className="gap-1">
      <CheckCheck className="size-3.5" /> {l.done}
    </Badge>
  ) : (
    <Badge tone="warning" className="gap-1">
      <CircleStop className="size-3.5" /> {l.cancelled}
    </Badge>
  );
}

/** Read / delivered / sent / failed as one bar, out of `total`. */
function StackedBar({ stats, total, className }: { stats: Stats; total: number; className?: string }) {
  const parts = [
    { key: 'read', value: stats.read, tone: 'bg-sky-500' },
    { key: 'delivered', value: stats.delivered, tone: 'bg-brand' },
    { key: 'sent', value: stats.sent, tone: 'bg-ink/70' },
    { key: 'failed', value: stats.failed, tone: 'bg-red-500' },
  ];
  return (
    <div className={cx('flex h-2 w-full overflow-hidden rounded-full bg-raised', className)}>
      {parts.map((p) =>
        p.value > 0 ? <span key={p.key} className={cx('h-full transition-[width] duration-700 ease-out', p.tone)} style={{ width: `${(p.value / Math.max(1, total)) * 100}%` }} /> : null,
      )}
    </div>
  );
}

// --- step 1: the message ---------------------------------------------------------------------------

const teaser = (body: string, name: string) =>
  body
    .replace(/\{\{\s*name\s*\}\}/g, name)
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, 3)
    .join('\n');

function AdCard({ ad, index, selected, onPick }: { ad: AdStyle; index: number; selected: boolean; onPick: () => void }) {
  const { t } = useI18n();
  const text = t.ads.templates[ad.id];
  const tags = [ad.imageUrl && t.ads.gallery.tags.image, text.buttons?.length && t.ads.gallery.tags.buttons, text.body.includes('{{name}}') && t.ads.gallery.tags.personal].filter(Boolean);
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      className={cx(
        'lift group animate-fade-up relative flex flex-col overflow-hidden rounded-xl border bg-card text-start shadow-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        selected ? 'border-brand ring-2 ring-brand/40' : 'border-line hover:border-line-strong',
      )}
      style={delay(index * 40)}
    >
      <span className="shine relative block h-36 overflow-hidden" style={{ background: `linear-gradient(135deg, ${ad.from}, ${ad.to})` }}>
        <span aria-hidden className="absolute -end-10 -top-10 size-32 rounded-full bg-white/25 blur-2xl transition-transform duration-700 group-hover:scale-125" />
        <span aria-hidden className="absolute -start-8 -bottom-12 size-28 rounded-full bg-black/25 blur-2xl" />
        <ad.icon aria-hidden className="absolute end-3 top-3 size-9 text-white/90 drop-shadow transition-transform duration-500 group-hover:scale-110 group-hover:rotate-12" />
        {ad.imageUrl && (
          <img
            src={ad.imageUrl}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            className="absolute end-3 bottom-3 size-14 rotate-6 rounded-lg object-cover shadow-lg ring-2 ring-white/40 transition-transform duration-500 group-hover:rotate-0"
          />
        )}
        <span
          dir="auto"
          className="absolute start-3 bottom-3 block max-w-[72%] rounded-lg rounded-ss-sm bg-[#005c4b] px-2.5 py-1.5 text-[11px] leading-snug whitespace-pre-line text-[#e9edef] shadow-lg transition-transform duration-300 group-hover:-translate-y-1"
        >
          <span className="line-clamp-3">
            <WhatsAppText text={teaser(text.body, t.templates.samples.name ?? '')} />
          </span>
        </span>
        {selected ? (
          <span className="animate-scale-in absolute start-3 top-3 flex size-6 items-center justify-center rounded-full bg-white text-black shadow">
            <Check className="size-4" />
          </span>
        ) : (
          <span aria-hidden className="absolute start-3 top-3 flex size-6 items-center justify-center rounded-full border-2 border-white/60 text-white opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <Plus className="size-3.5" />
          </span>
        )}
      </span>
      <span className="flex flex-1 flex-col gap-1 p-4">
        <span className="block text-sm font-semibold">{text.title}</span>
        <span className="block text-xs text-muted">{text.hint}</span>
        {tags.length > 0 && (
          <span className="mt-auto flex flex-wrap gap-1.5 pt-2">
            {tags.map((tag) => (
              <span key={String(tag)} className="rounded-full bg-raised px-2 py-0.5 text-[11px] text-ink-2">
                {tag}
              </span>
            ))}
          </span>
        )}
      </span>
    </button>
  );
}

function MessageStep({
  draft,
  setDraft,
  onImageStatus,
  imageBroken,
  insertRef,
}: {
  draft: Draft;
  setDraft: (update: (d: Draft) => Draft) => void;
  onImageStatus: (url: string, ok: boolean) => void;
  imageBroken: boolean;
  insertRef: { current: ((token: string) => void) | null };
}) {
  const { t } = useI18n();
  const e = t.ads.editor;
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [emoji, setEmoji] = useState(false);
  const [cat, setCat] = useState<'all' | AdCat>('all');
  const saved = useQuery({ queryKey: qk.templates, queryFn: ({ signal }) => api<Template[]>('/api/templates', { signal }) });

  const originalBody = (source: Draft['source']) => (source && source !== 'blank' && source !== 'saved' ? t.ads.templates[source].body : '');
  const dirty = draft.source !== null && draft.body.trim() !== '' && draft.body !== originalBody(draft.source);

  const pick = (next: Draft) => {
    if (dirty && !confirm(t.templates.discardChanges)) return;
    setDraft(() => next);
    requestAnimationFrame(() => bodyRef.current?.focus());
  };
  const pickAd = (ad: AdStyle) => {
    const text = t.ads.templates[ad.id];
    pick({ source: ad.id, body: text.body, imageUrl: ad.imageUrl ?? '', buttons: text.buttons ?? [], buttonsTitle: text.buttonsTitle ?? '' });
  };

  /** Replaces the selection with `before + selection + after` and keeps the selection on the same text. */
  const edit = useCallback(
    (before: string, after = '') => {
      const el = bodyRef.current;
      const value = el?.value ?? draft.body;
      const start = el?.selectionStart ?? value.length;
      const end = el?.selectionEnd ?? value.length;
      setDraft((d) => ({ ...d, body: value.slice(0, start) + before + value.slice(start, end) + after + value.slice(end) }));
      requestAnimationFrame(() => {
        el?.focus();
        el?.setSelectionRange(start + before.length, end + before.length);
      });
    },
    [draft.body, setDraft],
  );
  useEffect(() => {
    insertRef.current = (token) => edit(token);
    return () => {
      insertRef.current = null;
    };
  }, [edit, insertRef]);

  const setButton = (i: number, value: string) => setDraft((d) => ({ ...d, buttons: d.buttons.map((b, j) => (j === i ? value : b)) }));

  if (draft.source === null) {
    const shown = cat === 'all' ? ADS : ADS.filter((ad) => ad.cat === cat);
    return (
      <div className="space-y-4">
        <div className="code-scroll -mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="tablist" aria-label={t.ads.gallery.categoriesLabel}>
          {AD_CATS.map(({ id, icon: Icon }) => {
            const active = cat === id;
            const count = id === 'all' ? ADS.length : ADS.filter((ad) => ad.cat === id).length;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setCat(id)}
                className={cx(
                  'flex h-9 shrink-0 items-center gap-2 rounded-full border ps-1 pe-3 text-sm whitespace-nowrap transition-all duration-200 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  active ? 'border-brand/60 bg-brand/10 text-ink' : 'border-line text-ink-2 hover:border-line-strong hover:bg-raised/40',
                )}
              >
                <span className={cx('flex size-7 items-center justify-center rounded-full', active ? 'bg-brand text-black' : 'bg-raised text-ink-2')}>
                  <Icon className="size-3.5" />
                </span>
                {t.ads.gallery.categories[id]}
                <span className={cx('rounded-full px-1.5 py-0.5 text-[11px] leading-none tabular-nums', active ? 'bg-brand/20 text-ink' : 'bg-raised text-muted')}>{count}</span>
              </button>
            );
          })}
        </div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((ad, i) => (
            <AdCard key={ad.id} ad={ad} index={i} selected={false} onPick={() => pickAd(ad)} />
          ))}
          <button
            type="button"
            onClick={() => pick({ ...EMPTY_DRAFT, source: 'blank' })}
            className="lift group animate-fade-up flex min-h-56 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line-strong text-center outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            style={delay(shown.length * 40)}
          >
            <span className="flex size-12 items-center justify-center rounded-full border border-dashed border-white/25 text-white/60 transition-colors duration-200 group-hover:border-brand/70 group-hover:text-brand">
              <Plus className="size-5" />
            </span>
            <span className="block text-sm font-semibold">{t.ads.gallery.blank}</span>
            <span className="block text-xs text-muted">{t.ads.gallery.blankHint}</span>
          </button>
        </div>
        {saved.data && saved.data.length > 0 && (
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted">{t.ads.gallery.saved}</span>
            <Select
              className="w-64 max-w-full"
              aria-label={t.ads.gallery.savedPick}
              value=""
              onChange={(id) => {
                const tpl = saved.data.find((x) => x.id === id);
                if (tpl) pick({ source: 'saved', body: tpl.body, imageUrl: tpl.imageUrl ?? '', buttons: tpl.buttons ?? [], buttonsTitle: tpl.buttonsTitle ?? '' });
              }}
              options={[{ value: '', label: <span className="text-muted">{t.ads.gallery.savedPick}</span> }, ...saved.data.map((x) => ({ value: x.id, label: <span className="ltr font-mono">{x.name}</span> }))]}
            />
          </div>
        )}
      </div>
    );
  }

  const toolbar = [
    { label: e.bold, icon: Bold, run: () => edit('*', '*') },
    { label: e.italic, icon: Italic, run: () => edit('_', '_') },
    { label: e.strike, icon: Strikethrough, run: () => edit('~', '~') },
    { label: e.mono, icon: Code, run: () => edit('```', '```') },
  ];

  return (
    <div className="animate-fade-in space-y-5">
      {/* Quick switch between templates once one is chosen. */}
      <div className="code-scroll -mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
        {ADS.map((ad) => {
          const active = draft.source === ad.id;
          return (
            <button
              key={ad.id}
              type="button"
              onClick={() => !active && pickAd(ad)}
              aria-pressed={active}
              className={cx(
                'flex h-9 shrink-0 items-center gap-2 rounded-full border ps-1 pe-3 text-sm whitespace-nowrap transition-all duration-200 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                active ? 'border-brand/60 bg-brand/10 text-ink' : 'border-line text-ink-2 hover:border-line-strong hover:bg-raised/40',
              )}
            >
              <span className="flex size-7 items-center justify-center rounded-full text-white" style={{ background: `linear-gradient(135deg, ${ad.from}, ${ad.to})` }}>
                <ad.icon className="size-3.5" />
              </span>
              {t.ads.templates[ad.id].title}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => pick({ ...EMPTY_DRAFT, source: 'blank' })}
          className={cx(
            'flex h-9 shrink-0 items-center gap-2 rounded-full border border-dashed ps-1 pe-3 text-sm whitespace-nowrap transition-colors',
            draft.source === 'blank' ? 'border-brand/60 text-ink' : 'border-line-strong text-ink-2 hover:text-ink',
          )}
        >
          <span className="flex size-7 items-center justify-center rounded-full bg-raised">
            <PenLine className="size-3.5" />
          </span>
          {t.ads.gallery.blank}
        </button>
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm leading-none font-medium">{e.body}</span>
          <div className="flex flex-wrap items-center gap-1">
            {toolbar.map(({ label, icon: Icon, run }) => (
              <button
                key={label}
                type="button"
                onClick={run}
                title={label}
                aria-label={label}
                className="flex size-8 items-center justify-center rounded-md text-ink-2 transition-colors hover:bg-raised hover:text-ink"
              >
                <Icon className="size-4" />
              </button>
            ))}
            <span className="mx-1 h-5 w-px bg-line" />
            <button
              type="button"
              onClick={() => edit('{{name}}')}
              className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-ink-2 transition-colors hover:bg-raised hover:text-ink"
            >
              <UserRound className="size-3.5" /> {e.insertName}
            </button>
            <button
              type="button"
              onClick={() => setEmoji((v) => !v)}
              aria-expanded={emoji}
              title={e.emoji}
              aria-label={e.emoji}
              className={cx('flex size-8 items-center justify-center rounded-md transition-colors hover:bg-raised', emoji ? 'bg-raised text-brand' : 'text-ink-2')}
            >
              <Smile className="size-4" />
            </button>
          </div>
        </div>
        {emoji && (
          <div className="animate-scale-in flex flex-wrap gap-1 rounded-lg border border-line bg-raised/30 p-2">
            {EMOJIS.map((em) => (
              <button key={em} type="button" onClick={() => edit(em)} className="flex size-8 items-center justify-center rounded-md text-lg transition-transform hover:scale-125 hover:bg-raised">
                {em}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={bodyRef}
          value={draft.body}
          onChange={(ev) => setDraft((d) => ({ ...d, body: ev.target.value }))}
          rows={9}
          dir="auto"
          maxLength={4096}
          aria-label={e.body}
          className={cx(inputClass, 'h-auto min-h-40 py-2 leading-relaxed')}
        />
        <div className="flex items-start justify-between gap-3 text-xs text-muted">
          <span>{e.bodyHint}</span>
          <span className="ltr shrink-0 tabular-nums">{e.chars(draft.body.length)}</span>
        </div>
      </div>

      <label className="grid gap-2">
        <span className="flex items-center gap-2 text-sm leading-none font-medium">
          <ImageIcon className="size-4 text-muted" /> {e.image}
        </span>
        <span className="flex gap-2">
          <input
            type="url"
            value={draft.imageUrl}
            onChange={(ev) => setDraft((d) => ({ ...d, imageUrl: ev.target.value }))}
            placeholder="https://example.com/offer.jpg"
            dir="ltr"
            className={inputClass}
          />
          {draft.imageUrl && (
            <Button variant="ghost" size="sm" className="h-9" onClick={() => setDraft((d) => ({ ...d, imageUrl: '' }))} aria-label={t.common.delete}>
              <X className="size-4" />
            </Button>
          )}
        </span>
        <span className="text-sm text-muted">{e.imageHint}</span>
        {imageBroken && <span className="animate-fade-in block text-sm text-destructive-ink">{t.templates.imageNotImage}</span>}
      </label>
      {/* Loads the image off-screen too, so a broken link is caught even when the preview is scrolled away. */}
      {draft.imageUrl.trim() && (
        <img src={draft.imageUrl.trim()} alt="" hidden referrerPolicy="no-referrer" onLoad={() => onImageStatus(draft.imageUrl.trim(), true)} onError={() => onImageStatus(draft.imageUrl.trim(), false)} />
      )}

      <fieldset className="space-y-2.5">
        <legend className="mb-2 flex items-center gap-2 text-sm leading-none font-medium">
          <ListChecks className="size-4 text-muted" /> {e.buttons}
        </legend>
        <p className="text-sm text-muted">{e.buttonsHint}</p>
        {draft.buttons.length > 0 && (
          <div className="animate-fade-in space-y-2">
            <input
              value={draft.buttonsTitle}
              onChange={(ev) => setDraft((d) => ({ ...d, buttonsTitle: ev.target.value }))}
              placeholder={e.buttonsTitle}
              aria-label={e.buttonsTitle}
              maxLength={POLL_LIMITS.question}
              dir="auto"
              className={cx(inputClass, 'font-medium')}
            />
            {draft.buttons.map((label, i) => (
              <span key={i} className="animate-fade-in flex items-center gap-2">
                <span className="size-4 shrink-0 rounded-full border-2 border-line-strong" />
                <input
                  value={label}
                  onChange={(ev) => setButton(i, ev.target.value)}
                  placeholder={e.buttonLabel(i + 1)}
                  aria-label={e.buttonLabel(i + 1)}
                  maxLength={POLL_LIMITS.option}
                  dir="auto"
                  className={inputClass}
                />
                <button
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, buttons: d.buttons.filter((_, j) => j !== i) }))}
                  aria-label={e.removeButton}
                  className="rounded-md p-1.5 text-muted transition-colors hover:bg-raised hover:text-red-400"
                >
                  <X className="size-4" />
                </button>
              </span>
            ))}
          </div>
        )}
        {draft.buttons.length < POLL_LIMITS.maxOptions && (
          <Button
            variant="outline"
            size="sm"
            icon={<Plus className="size-4" />}
            onClick={() =>
              setDraft((d) => ({ ...d, buttons: d.buttons.length === 0 ? ['', ''] : [...d.buttons, ''], buttonsTitle: d.buttonsTitle || e.buttonsTitleDefault }))
            }
          >
            {e.addButton}
          </Button>
        )}
      </fieldset>
    </div>
  );
}

// --- step 2: recipients ----------------------------------------------------------------------------

type FileState = { name: string; rows: number; entries: Entry[]; columns: string[] };

function AudienceStep({
  manual,
  setManual,
  file,
  setFile,
  countryCode,
  setCountryCode,
  audience,
  columns,
  variables,
  defaults,
  setDefaults,
  onInsert,
}: {
  manual: string;
  setManual: (v: string) => void;
  file: FileState | null;
  setFile: (f: FileState | null) => void;
  countryCode: string;
  setCountryCode: (v: string) => void;
  audience: ReturnType<typeof buildAudience>;
  columns: string[];
  variables: string[];
  defaults: Record<string, string>;
  setDefaults: (update: (d: Record<string, string>) => Record<string, string>) => void;
  onInsert: (token: string) => void;
}) {
  const { t, fmt } = useI18n();
  const a = t.ads.audience;
  const [mode, setMode] = useState<'manual' | 'file'>('manual');
  const [dragging, setDragging] = useState(false);
  const [reading, setReading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [showLeftOut, setShowLeftOut] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = async (picked: File | undefined) => {
    if (!picked) return;
    setReading(true);
    setFileError(null);
    try {
      const rows = await readSheet(picked);
      const parsed = rowsToEntries(rows);
      if (!parsed) throw new Error('noPhone');
      setFile({ name: picked.name, rows: parsed.entries.length, entries: parsed.entries, columns: parsed.columns });
    } catch (err) {
      setFileError(err instanceof SheetError ? a.errors[err.code] : err instanceof Error && err.message === 'noPhone' ? a.errors.noPhone : a.errors.corrupt);
    } finally {
      setReading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const onDrop = (ev: DragEvent) => {
    ev.preventDefault();
    setDragging(false);
    void load(ev.dataTransfer.files[0]);
  };

  const missing = variables.map((v) => ({ name: v, count: audience.recipients.filter((r) => !r.variables[v]?.trim()).length })).filter((m) => m.count > 0);
  const leftOut = [...audience.invalid, ...audience.local];
  const chips: { label: string; value: number; tone: Tone }[] = [
    { label: a.valid, value: audience.recipients.length, tone: 'good' },
    { label: a.invalid, value: audience.invalid.length, tone: 'critical' },
    { label: a.duplicates, value: audience.duplicates, tone: 'neutral' },
    { label: a.local, value: audience.local.length, tone: 'warning' },
  ];

  return (
    <div className="space-y-4">
      <div role="tablist" className="inline-flex rounded-lg border border-line bg-raised/30 p-1">
        {(['manual', 'file'] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={cx(
              'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-all duration-200',
              mode === m ? 'bg-bg text-ink shadow-sm' : 'text-muted hover:text-ink',
            )}
          >
            {m === 'manual' ? <PenLine className="size-4" /> : <FileSpreadsheet className="size-4" />}
            {a[m]}
            {m === 'file' && file && <span className="size-1.5 rounded-full bg-brand" />}
          </button>
        ))}
      </div>

      {mode === 'manual' ? (
        <textarea
          value={manual}
          onChange={(ev) => setManual(ev.target.value)}
          rows={7}
          dir="auto"
          placeholder={a.placeholder}
          aria-label={a.manual}
          className={cx(inputClass, 'animate-fade-in h-auto min-h-36 py-2 font-mono text-sm leading-relaxed')}
        />
      ) : (
        <div className="animate-fade-in space-y-3">
          <div
            onDragOver={(ev) => {
              ev.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cx(
              'relative flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-all duration-200',
              dragging ? 'scale-[1.01] border-brand bg-brand/10' : 'border-line-strong bg-raised/20',
            )}
          >
            <span className={cx('flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-[#3BE37F] to-[#0E9488] text-black shadow-lg', dragging ? 'animate-bounce' : 'animate-float')}>
              <Upload className="size-6" />
            </span>
            <div className="space-y-1">
              <p className="font-medium">{reading ? a.reading : a.drop}</p>
              <p className="text-sm text-muted">{a.fileHint}</p>
            </div>
            <Button variant="outline" size="sm" loading={reading} onClick={() => inputRef.current?.click()}>
              {a.browse}
            </Button>
            <input ref={inputRef} type="file" accept=".xlsx,.csv,.tsv,.txt" hidden onChange={(ev) => void load(ev.target.files?.[0])} />
          </div>
          <ErrorNote>{fileError}</ErrorNote>
          {file && (
            <div className="animate-scale-in flex items-center gap-3 rounded-lg border border-line bg-raised/30 px-3 py-2.5">
              <FileSpreadsheet className="size-5 shrink-0 text-brand" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted">{a.fileRows(file.rows)}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setFile(null)} aria-label={a.removeFile}>
                <X className="size-4" />
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {chips.map((c) =>
          c.value > 0 || c.tone === 'good' ? (
            <span key={c.label} className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium', TONES[c.tone].chip)}>
              <span className={cx('size-1.5 rounded-full', TONES[c.tone].dot)} />
              {c.label}
              <span className="tabular-nums">{fmt.number.format(c.value)}</span>
            </span>
          ) : null,
        )}
        {leftOut.length > 0 && (
          <button type="button" onClick={() => setShowLeftOut((v) => !v)} className="text-xs text-muted underline-offset-4 hover:text-ink hover:underline">
            {showLeftOut ? a.hideLeftOut : a.showLeftOut}
          </button>
        )}
        {(manual || file) && (
          <button
            type="button"
            onClick={() => {
              setManual('');
              setFile(null);
            }}
            className="ms-auto text-xs text-muted hover:text-red-400"
          >
            {a.clear}
          </button>
        )}
      </div>

      {showLeftOut && leftOut.length > 0 && (
        <div className="animate-fade-in flex max-h-32 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-line bg-raised/20 p-2">
          {leftOut.slice(0, 200).map((raw, i) => (
            <code key={i} className="ltr rounded bg-raised px-1.5 py-0.5 font-mono text-xs text-ink-2">
              {raw}
            </code>
          ))}
        </div>
      )}

      {(audience.local.length > 0 || countryCode) && (
        <div className="animate-fade-in flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2.5">
          <label className="flex items-center gap-2 text-sm font-medium">
            {a.countryCode}
            <span className="ltr flex items-center rounded-md border border-line bg-bg ps-2">
              <span className="text-muted">+</span>
              <input
                value={countryCode}
                onChange={(ev) => setCountryCode(ev.target.value.replace(/[^\d٠-٩]/g, '').slice(0, 4))}
                inputMode="numeric"
                placeholder="20"
                className="h-8 w-14 bg-transparent px-1.5 text-sm outline-none"
              />
            </span>
          </label>
          {audience.local.length > 0 && <span className="text-sm text-amber-200">{a.localHint(audience.local.length)}</span>}
        </div>
      )}

      {columns.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs text-muted">{a.columns}</p>
          <div className="flex flex-wrap gap-1.5" dir="ltr">
            {columns.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onInsert(`{{${c}}}`)}
                className="rounded-md border border-line px-2 py-0.5 font-mono text-xs text-ink-2 transition-colors hover:border-brand/50 hover:text-ink"
              >
                {`{{${c}}}`}
              </button>
            ))}
          </div>
        </div>
      )}

      {missing.length > 0 && audience.recipients.length > 0 && (
        <div className="animate-fade-in space-y-2.5 rounded-lg border border-line bg-raised/20 p-3">
          <p className="text-sm font-medium">{a.defaults}</p>
          {missing.map((m) => (
            <label key={m.name} className="flex flex-wrap items-center gap-2">
              <code className="ltr w-28 shrink-0 font-mono text-xs text-ink-2">{`{{${m.name}}}`}</code>
              <input
                value={defaults[m.name] ?? ''}
                onChange={(ev) => setDefaults((d) => ({ ...d, [m.name]: ev.target.value }))}
                placeholder={a.defaultPlaceholder}
                dir="auto"
                maxLength={200}
                className={cx(inputClass, 'h-8 min-w-40 flex-1')}
              />
              <span className="text-xs text-muted">{a.missingFor(m.count)}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// --- step 3: sending numbers -----------------------------------------------------------------------

function NumbersStep({
  sessions,
  picked,
  setPicked,
  rotate,
  setRotate,
  every,
  setEvery,
  pace,
  setPace,
  split,
}: {
  sessions: { data?: Session[]; error: unknown; isPending: boolean; isFetching: boolean; refetch: () => unknown };
  picked: Set<string>;
  setPicked: (s: Set<string>) => void;
  rotate: boolean;
  setRotate: (v: boolean) => void;
  every: number;
  setEvery: (v: number) => void;
  pace: BroadcastPace;
  setPace: (p: BroadcastPace) => void;
  split: { session: Session; count: number }[];
}) {
  const { t, fmt } = useI18n();
  const n = t.ads.numbers;
  if (sessions.error) return <LoadError error={sessions.error} onRetry={() => void sessions.refetch()} retrying={sessions.isFetching} />;
  if (sessions.isPending || !sessions.data) return <Loading />;
  const list = sessions.data;
  if (!list.length) {
    return (
      <EmptyState
        icon={Smartphone}
        title={n.none}
        action={
          <Link href="/sessions" className="text-sm font-medium text-brand hover:underline">
            {n.connect}
          </Link>
        }
      />
    );
  }
  const available = list.filter(sendableSession);
  const chosen = available.filter((s) => picked.has(s.id));
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const max = Math.max(1, ...split.map((s) => s.count));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-muted">{t.ads.numbersCount(chosen.length)}</span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" icon={<CheckCheck className="size-4" />} disabled={!available.length} onClick={() => setPicked(new Set(available.map((s) => s.id)))}>
            {n.selectAll}
          </Button>
          {chosen.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setPicked(new Set())}>
              {n.clearAll}
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {list.map((s, i) => {
          const ok = sendableSession(s);
          const on = ok && picked.has(s.id);
          return (
            <button
              key={s.id}
              type="button"
              disabled={!ok}
              aria-pressed={on}
              onClick={() => toggle(s.id)}
              className={cx(
                'animate-fade-up flex items-center gap-3 rounded-xl border p-3 text-start transition-all duration-200 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                on ? 'border-brand/60 bg-brand/10 shadow-[0_0_30px_-14px] shadow-brand' : 'border-line hover:border-line-strong hover:bg-raised/30',
                !ok && 'cursor-not-allowed opacity-55',
              )}
              style={delay(i * 40)}
            >
              <span
                className={cx(
                  'flex size-5 shrink-0 items-center justify-center rounded-md border transition-colors duration-200',
                  on ? 'border-brand bg-brand text-black' : 'border-line-strong',
                )}
              >
                {on && <Check className="animate-scale-in size-3.5" />}
              </span>
              <span className={cx('relative flex size-10 shrink-0 items-center justify-center rounded-full', on ? 'bg-brand/20 text-brand' : 'bg-raised text-muted')}>
                <Smartphone className="size-5" />
                {s.status === 'connected' && <span className="absolute end-0 bottom-0 size-2.5 rounded-full border-2 border-card bg-green-500" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{s.name}</span>
                <span className="ltr block truncate font-mono text-xs text-muted">{s.phoneNumber ?? n.noPhone}</span>
              </span>
              {!ok && <SessionStatusBadge status={s.status} />}
            </button>
          );
        })}
      </div>

      <div className="space-y-3 rounded-xl border border-line bg-raised/20 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm font-medium">{n.rotate}</p>
            <p className="text-sm text-muted">{chosen.length < 2 ? n.rotateOne : rotate ? n.rotateOn : n.rotateOff}</p>
          </div>
          <Switch checked={rotate && chosen.length > 1} disabled={chosen.length < 2} onChange={setRotate} label={n.rotate} />
        </div>
        {rotate && chosen.length > 1 && (
          <div className="animate-fade-in flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">{n.every}</span>
            {ROTATE_EVERY.map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={every === k}
                onClick={() => setEvery(k)}
                className={cx(
                  'h-8 rounded-full border px-3 text-sm tabular-nums transition-colors',
                  every === k ? 'border-brand/60 bg-brand/15 font-medium text-ink' : 'border-line text-ink-2 hover:border-line-strong',
                )}
              >
                {k}
              </button>
            ))}
            <span className="text-sm text-muted">{n.everyUnit(every)}</span>
          </div>
        )}
        {split.length > 1 && (
          <div className="space-y-2 pt-1">
            <p className="text-xs text-muted">{n.split}</p>
            {split.map(({ session, count }) => (
              <div key={session.id} className="flex items-center gap-3 text-xs">
                <span className="w-28 shrink-0 truncate">{session.name}</span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
                  <span className="block h-full rounded-full bg-gradient-to-r from-[#3BE37F] to-[#0E9488] transition-[width] duration-500 rtl:bg-gradient-to-l" style={{ width: `${(count / max) * 100}%` }} />
                </span>
                <span className="w-12 shrink-0 text-end tabular-nums">{fmt.number.format(count)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">{n.pace}</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {BROADCAST_PACE_IDS.map((id) => {
            const Icon = PACE_ICONS[id];
            const active = pace === id;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                onClick={() => setPace(id)}
                className={cx(
                  'flex items-start gap-3 rounded-xl border p-3 text-start transition-all duration-200 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                  active ? 'border-brand/60 bg-brand/10' : 'border-line hover:border-line-strong hover:bg-raised/30',
                )}
              >
                <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-lg', active ? 'bg-brand text-black' : 'bg-raised text-muted')}>
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{t.ads.paces[id]!.label}</span>
                  <span className="block text-xs text-muted">{t.ads.paces[id]!.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// --- composer --------------------------------------------------------------------------------------

function Composer({ onLaunched }: { onLaunched: (created: Created) => void }) {
  const { t, fmt } = useI18n();
  const s = t.ads.summary;
  const queryClient = useQueryClient();

  const [draft, setDraftState] = useState<Draft>(EMPTY_DRAFT);
  const setDraft = useCallback((update: (d: Draft) => Draft) => setDraftState(update), []);
  const [badImage, setBadImage] = useState<string | null>(null);
  const onImageStatus = useCallback((url: string, ok: boolean) => setBadImage((prev) => (ok ? (prev === url ? null : prev) : url)), []);
  const insertRef = useRef<((token: string) => void) | null>(null);

  const [manual, setManual] = useState('');
  const deferredManual = useDeferredValue(manual);
  const [file, setFile] = useState<FileState | null>(null);
  const [countryCode, setCountryCode] = useState('');
  const [defaults, setDefaults] = useState<Record<string, string>>({});

  const sessions = useQuery({ queryKey: qk.sessions, queryFn: ({ signal }) => api<Session[]>('/api/whatsapp-sessions', { signal }) });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const touched = useRef(false);
  // Start with every connected number selected; after that the admin's choice stands.
  useEffect(() => {
    if (touched.current || !sessions.data) return;
    touched.current = true;
    setPicked(new Set(sessions.data.filter(sendableSession).map((x) => x.id)));
  }, [sessions.data]);
  const [rotate, setRotate] = useState(true);
  const [every, setEvery] = useState(1);
  const [pace, setPace] = useState<BroadcastPace>('safe');
  const [name, setName] = useState('');
  const [confirming, setConfirming] = useState(false);

  const buttons = draft.buttons.map((b) => b.trim()).filter(Boolean);
  const parts: TemplateParts = { body: draft.body, imageUrl: draft.imageUrl.trim() || null, buttons, buttonsTitle: draft.buttonsTitle };
  const variables = templatePartsVariables(parts);
  const imageBroken = parts.imageUrl !== null && parts.imageUrl === badImage;
  const buttonsInvalid =
    draft.buttons.length > 0 && (buttons.length < POLL_LIMITS.minOptions || new Set(buttons).size !== buttons.length || !draft.buttonsTitle.trim());

  const manualEntries = useMemo(() => parseManual(deferredManual), [deferredManual]);
  const audience = useMemo(() => buildAudience([...manualEntries, ...(file?.entries ?? [])], countryCode), [manualEntries, file, countryCode]);
  const columns = useMemo(
    () => [...new Set([...(manualEntries.some((e) => e.variables.name) ? ['name'] : []), ...(file?.columns ?? [])])],
    [manualEntries, file],
  );
  const valueOf = (vars: Record<string, string>, v: string) => (vars[v]?.trim() || defaults[v]?.trim() || '').slice(0, 1024);
  const complete = audience.recipients.filter((r) => variables.every((v) => valueOf(r.variables, v)));
  const willSkip = audience.recipients.length - complete.length;
  const recipients = complete.slice(0, BROADCAST_LIMITS.recipients);

  const chosen = (sessions.data ?? []).filter((x) => sendableSession(x) && picked.has(x.id));
  const rotateEvery = rotate && chosen.length > 1 ? every : Math.max(1, Math.ceil(recipients.length / Math.max(1, chosen.length)));
  const split = useMemo(() => {
    const counts = rotationSplit(recipients.length, chosen.length, rotateEvery);
    return chosen.map((session, i) => ({ session, count: counts[i] ?? 0 }));
  }, [recipients.length, chosen, rotateEvery]);

  const templateTitle = draft.source && draft.source !== 'blank' && draft.source !== 'saved' ? t.ads.templates[draft.source].title : t.ads.title;
  const defaultName = `${templateTitle} · ${fmt.dayShort.format(new Date())}`;
  const needs = [
    !draft.body.trim() && s.needs.body,
    buttonsInvalid && s.needs.buttons,
    imageBroken && t.templates.imageNotImage,
    !recipients.length && s.needs.recipients,
    !chosen.length && s.needs.numbers,
  ].filter((x): x is string => Boolean(x));
  const ready = needs.length === 0;

  const messageDone = Boolean(draft.body.trim()) && !buttonsInvalid && !imageBroken;
  const audienceDone = recipients.length > 0;
  const numbersDone = chosen.length > 0;
  const currentStep = !messageDone ? 1 : !audienceDone ? 2 : !numbersDone ? 3 : 0;
  const checklist = [
    { n: 1, icon: PenLine, title: t.ads.steps.message.title, done: messageDone, missing: needs.find((x) => [s.needs.body, s.needs.buttons, t.templates.imageNotImage].includes(x)) },
    { n: 2, icon: UserRound, title: t.ads.steps.audience.title, done: audienceDone, missing: s.needs.recipients },
    { n: 3, icon: Smartphone, title: t.ads.steps.numbers.title, done: numbersDone, missing: s.needs.numbers },
  ];

  const launch = useMutation({
    mutationFn: () =>
      api<Created>('/api/broadcasts', {
        method: 'POST',
        timeoutMs: 60_000,
        body: {
          name: name.trim() || defaultName,
          sessionIds: chosen.map((x) => x.id),
          rotateEvery,
          pace,
          body: draft.body,
          imageUrl: parts.imageUrl,
          buttons: buttons.length ? buttons : null,
          buttonsTitle: buttons.length ? draft.buttonsTitle.trim() : null,
          recipients: recipients.map((r) => ({ to: r.phone, variables: Object.fromEntries(variables.map((v) => [v, valueOf(r.variables, v)])) })),
        },
      }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: qk.admin.broadcasts });
      onLaunched(created);
    },
  });

  const first = recipients[0];
  const previewValues = first ? Object.fromEntries(variables.map((v) => [v, valueOf(first.variables, v)])) : defaults;
  const perRecipient = buttons.length ? 2 : 1;
  const summaryStats = [
    { icon: UserRound, label: s.recipients, value: fmt.number.format(recipients.length) },
    { icon: Smartphone, label: s.numbers, value: fmt.number.format(chosen.length) },
    { icon: Send, label: s.messages, value: fmt.number.format(recipients.length * perRecipient) },
    { icon: Timer, label: s.duration, value: recipients.length ? t.ads.duration(estimateDuration(recipients.length, chosen.length, rotateEvery, pace)) : '—' },
  ];

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-6">
        <div className="animate-fade-up flex items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 p-4">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-amber-300" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-amber-200">{t.ads.warning.title}</p>
            <p className="text-sm text-muted">{t.ads.warning.text}</p>
          </div>
        </div>

        <Step n={1} index={0} title={t.ads.steps.message.title} text={t.ads.steps.message.text} done={messageDone} current={currentStep === 1}>
          <MessageStep draft={draft} setDraft={setDraft} onImageStatus={onImageStatus} imageBroken={imageBroken} insertRef={insertRef} />
        </Step>

        <Step n={2} index={1} title={t.ads.steps.audience.title} text={t.ads.steps.audience.text} done={audienceDone} current={currentStep === 2}>
          <AudienceStep
            manual={manual}
            setManual={setManual}
            file={file}
            setFile={setFile}
            countryCode={countryCode}
            setCountryCode={setCountryCode}
            audience={audience}
            columns={columns}
            variables={variables}
            defaults={defaults}
            setDefaults={setDefaults}
            onInsert={(token) => insertRef.current?.(token)}
          />
        </Step>

        <Step n={3} index={2} title={t.ads.steps.numbers.title} text={t.ads.steps.numbers.text} done={numbersDone} current={currentStep === 3}>
          <NumbersStep
            sessions={sessions}
            picked={picked}
            setPicked={setPicked}
            rotate={rotate}
            setRotate={setRotate}
            every={every}
            setEvery={setEvery}
            pace={pace}
            setPace={setPace}
            split={split}
          />
        </Step>
      </div>

      <aside className="animate-fade-up space-y-4 lg:sticky lg:top-6" style={delay(160)}>
        <div className="overflow-hidden rounded-xl border border-line bg-card shadow-sm">
          <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
            <p className="text-sm font-medium">{s.preview}</p>
            {first && <p className="ltr truncate text-xs text-muted">{first.phone}</p>}
          </div>
          {draft.body.trim() || parts.imageUrl ? (
            <TemplatePreview template={parts} values={previewValues} onImageStatus={onImageStatus} className="max-h-[26rem] overflow-y-auto p-4" />
          ) : (
            <div
              className="flex h-40 flex-col items-center justify-center gap-2 bg-[#0b141a] text-sm text-white/40"
              style={{ backgroundImage: 'radial-gradient(rgb(255 255 255 / 0.07) 1px, transparent 1px)', backgroundSize: '16px 16px' }}
            >
              <Megaphone className="animate-float size-7" />
              {s.needs.body}
            </div>
          )}
        </div>

        <div className="space-y-1.5 rounded-xl border border-line bg-card p-4 shadow-sm">
          <p className="mb-1 font-semibold">{s.checklist}</p>
          {checklist.map(({ n, icon: Icon, title, done, missing }) => (
            <button
              key={n}
              type="button"
              onClick={() => document.getElementById(`ads-step-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className="group flex w-full items-center gap-3 rounded-lg px-2 py-2 text-start transition-colors hover:bg-raised/40"
            >
              <span
                className={cx(
                  'flex size-7 shrink-0 items-center justify-center rounded-full transition-colors duration-300',
                  done ? 'bg-brand/15 text-brand' : 'bg-raised text-muted group-hover:text-ink-2',
                )}
              >
                {done ? <Check className="size-4" /> : <Icon className="size-3.5" />}
              </span>
              <span className="flex-1 text-sm font-medium">{title}</span>
              <span className={cx('text-xs', done ? 'font-medium text-brand' : 'text-muted')}>{done ? s.ready : missing}</span>
            </button>
          ))}
        </div>

        <div className="space-y-4 rounded-xl border border-line bg-card p-4 shadow-sm">
          <p className="font-semibold">{s.title}</p>
          <label className="grid gap-2">
            <span className="text-xs text-muted">{s.name}</span>
            <input value={name} onChange={(ev) => setName(ev.target.value)} placeholder={defaultName} maxLength={120} className={inputClass} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            {summaryStats.map(({ icon: Icon, label, value }) => (
              <div key={label} className="rounded-lg border border-line bg-raised/30 p-3">
                <p className="flex items-center gap-1.5 text-xs text-muted">
                  <Icon className="size-3.5" /> {label}
                </p>
                <p className="mt-1.5 text-lg leading-none font-semibold tabular-nums">{value}</p>
              </div>
            ))}
          </div>
          {willSkip > 0 && <p className="text-xs text-amber-300">{t.ads.audience.willSkip(willSkip)}</p>}
          {complete.length > BROADCAST_LIMITS.recipients && (
            <p className="text-xs text-amber-300">{t.ads.audience.tooMany(fmt.number.format(BROADCAST_LIMITS.recipients))}</p>
          )}
          <button
            type="button"
            disabled={!ready}
            onClick={() => {
              launch.reset();
              setConfirming(true);
            }}
            className={cx(
              'group relative flex h-12 w-full items-center justify-center gap-2 overflow-hidden rounded-lg text-base font-semibold transition-all duration-300 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
              ready
                ? 'shine shine-auto cursor-pointer bg-gradient-to-r from-[#3BE37F] to-[#0E9488] text-black shadow-[0_10px_40px_-12px] shadow-brand hover:shadow-[0_14px_50px_-10px] active:scale-[0.98]'
                : 'cursor-not-allowed bg-raised text-muted',
            )}
          >
            <Send className={cx('size-5 transition-transform duration-300', ready && 'group-hover:translate-x-1 group-hover:-translate-y-1 rtl:-scale-x-100 rtl:group-hover:-translate-x-1')} />
            {s.launch}
          </button>
        </div>
      </aside>

      {confirming && (
        <Modal title={t.ads.confirm.title} onClose={() => !launch.isPending && setConfirming(false)}>
          <div className="flex items-center gap-4 rounded-lg border border-line bg-raised/30 p-4">
            <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#3BE37F] to-[#0E9488] text-black">
              <Rocket className="size-6" />
            </span>
            <p className="text-sm text-ink-2">{t.ads.confirm.text(recipients.length, chosen.length)}</p>
          </div>
          <ErrorNote>{launch.error ? errorMessage(launch.error) : null}</ErrorNote>
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={launch.isPending} onClick={() => setConfirming(false)}>
              {t.common.cancel}
            </Button>
            <Button variant="brand" loading={launch.isPending} icon={<Send className="size-4 rtl:-scale-x-100" />} onClick={() => launch.mutate()}>
              {t.ads.confirm.submit}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// --- live campaign ---------------------------------------------------------------------------------

/** A paper plane flies off the ring for each message that goes out (a few at a time at most). */
function Planes({ count }: { count: number }) {
  const previous = useRef(count);
  const seq = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [planes, setPlanes] = useState<{ id: number; style: CSSProperties }[]>([]);
  useEffect(() => {
    const added = Math.min(count - previous.current, 5);
    previous.current = count;
    if (added <= 0 || prefersReducedMotion()) return;
    const fresh = Array.from({ length: added }, (_, i) => {
      const angle = ((-25 - Math.random() * 130) * Math.PI) / 180;
      const distance = 120 + Math.random() * 70;
      return {
        id: ++seq.current,
        style: {
          '--dx': `${Math.cos(angle) * distance}px`,
          '--dy': `${Math.sin(angle) * distance}px`,
          '--rot': `${Math.round(Math.random() * 50 - 25)}deg`,
          animationDelay: `${i * 140}ms`,
        } as CSSProperties,
      };
    });
    setPlanes((list) => [...list, ...fresh].slice(-12));
    const ids = new Set(fresh.map((p) => p.id));
    timers.current.push(setTimeout(() => setPlanes((list) => list.filter((p) => !ids.has(p.id))), 2_400));
  }, [count]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return (
    <>
      {planes.map((p) => (
        <Send key={p.id} aria-hidden className="animate-plane pointer-events-none absolute top-1/2 left-1/2 -mt-2.5 -ml-2.5 size-5 text-brand drop-shadow-[0_0_6px_rgb(59_227_127/0.8)]" style={p.style} />
      ))}
    </>
  );
}

function ProgressRing({ value, total, running }: { value: number; total: number; running: boolean }) {
  const { t, fmt } = useI18n();
  const pct = total > 0 ? Math.min(1, value / total) : 0;
  const shownPct = useCountUp(Math.round(pct * 100));
  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  const [offset, setOffset] = useState(circumference);
  // Draws in from empty on mount, then follows progress.
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOffset(circumference * (1 - pct)));
    return () => cancelAnimationFrame(frame);
  }, [pct, circumference]);
  return (
    <div className="relative mx-auto size-56 shrink-0">
      <div className={cx('absolute -inset-2 rounded-full border-2 border-dashed border-brand/25', running ? 'animate-orbit' : 'opacity-0')} />
      <div className={cx('absolute inset-6 rounded-full bg-brand/10 blur-2xl', running && 'animate-glow')} />
      <svg viewBox="0 0 160 160" className="relative size-full -rotate-90" aria-hidden>
        <defs>
          <linearGradient id="ads-ring" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#3BE37F" />
            <stop offset="1" stopColor="#0E9488" />
          </linearGradient>
        </defs>
        <circle cx="80" cy="80" r={radius} fill="none" strokeWidth="11" className="stroke-raised" />
        <circle
          cx="80"
          cy="80"
          r={radius}
          fill="none"
          strokeWidth="11"
          strokeLinecap="round"
          stroke="url(#ads-ring)"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 1.1s cubic-bezier(0.22, 1, 0.36, 1)', filter: 'drop-shadow(0 0 6px rgb(59 227 127 / 0.45))' }}
        />
      </svg>
      <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct * 100)} className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="ltr text-5xl font-bold tracking-tight tabular-nums">{shownPct}%</span>
        <span className="mt-1 text-sm text-muted tabular-nums">{t.ads.live.of(fmt.number.format(value), fmt.number.format(total))}</span>
      </div>
      <Planes count={value} />
    </div>
  );
}

function StatTile({ label, value, icon: Icon, tone, index }: { label: string; value: number; icon: LucideIcon; tone: string; index: number }) {
  const { fmt } = useI18n();
  const shown = useCountUp(value);
  return (
    <div className="lift animate-fade-up rounded-xl border border-line bg-bg/60 p-4" style={delay(index * 60)}>
      <div className="flex items-center gap-2 text-sm text-muted">
        <span className={cx('flex size-7 items-center justify-center rounded-lg', tone)}>
          <Icon className="size-4" />
        </span>
        {label}
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{fmt.number.format(shown)}</p>
    </div>
  );
}

const CONFETTI_COLORS = ['#3BE37F', '#0E9488', '#fab219', '#ec4899', '#3b82f6', '#ffffff'];

function Confetti() {
  const pieces = useMemo(
    () =>
      Array.from({ length: 80 }, (_, i) => ({
        id: i,
        style: {
          left: `${Math.random() * 100}%`,
          background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
          '--drift': `${Math.round(Math.random() * 240 - 120)}px`,
          '--spin': `${Math.round(360 + Math.random() * 720)}deg`,
          '--duration': `${2.4 + Math.random() * 1.8}s`,
          '--delay': `${Math.round(Math.random() * 600)}ms`,
        } as CSSProperties,
      })),
    [],
  );
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-50 overflow-hidden">
      {pieces.map((p) => (
        <span key={p.id} className="confetti-piece" style={p.style} />
      ))}
    </div>
  );
}

function LiveCampaign({ id }: { id: string }) {
  const { t, fmt } = useI18n();
  const l = t.ads.live;
  const queryClient = useQueryClient();
  const [launched] = useState(() => (lastLaunch?.id === id ? lastLaunch : null));
  const query = useQuery({
    queryKey: qk.admin.broadcast(id),
    queryFn: ({ signal }) => api<CampaignDetail>(`/api/broadcasts/${id}`, { signal }),
    refetchInterval: (q) => (q.state.data?.state === 'running' ? 4_000 : false),
  });
  const data = query.data;

  // Message receipts from the campaign's numbers refresh the numbers right away (polling is the fallback).
  const invalidate = useMemo(() => debouncedInvalidate(queryClient, 600), [queryClient]);
  const sessionIds = useMemo(() => new Set(data?.sessionIds), [data?.sessionIds]);
  useLiveEvents((event) => {
    if (event.type === 'messages.update' && sessionIds.has(event.sessionId)) invalidate(qk.admin.broadcast(id));
  });

  // Confetti once, when the campaign finishes while it's on screen.
  const previousState = useRef<CampaignState | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  useEffect(() => {
    if (!data) return;
    if (previousState.current === 'running' && data.state === 'done') {
      setCelebrate(true);
      const timer = setTimeout(() => setCelebrate(false), 5_000);
      previousState.current = data.state;
      return () => clearTimeout(timer);
    }
    previousState.current = data.state;
  }, [data]);

  const cancel = useMutation({
    mutationFn: () => api<Campaign & { cancelled: number }>(`/api/broadcasts/${id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.admin.broadcast(id) });
      void queryClient.invalidateQueries({ queryKey: qk.admin.broadcasts });
    },
  });
  const [copied, setCopied] = useState(false);

  if (query.error && !data) return <LoadError error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  if (!data) return <Loading className="py-24" />;

  const { stats } = data;
  const processed = processedOf(stats);
  const total = Math.max(data.recipients, processed + stats.queued + stats.sending);
  const running = data.state === 'running';
  const active = running ? (data.recent.find((m) => m.status === 'sending') ?? data.recent[0])?.sessionId : undefined;
  const failedPhones = data.failures.map((f) => f.phone).filter((p): p is string => Boolean(p));

  const copyFailed = async () => {
    try {
      await navigator.clipboard.writeText(failedPhones.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable
    }
  };

  const tiles = [
    { label: l.waiting, value: stats.queued + stats.sending, icon: Clock, tone: 'bg-raised text-muted' },
    { label: l.sent, value: stats.sent, icon: Check, tone: 'bg-ink/10 text-ink' },
    { label: l.delivered, value: stats.delivered, icon: CheckCheck, tone: 'bg-green-500/15 text-green-400' },
    { label: l.read, value: stats.read, icon: CheckCheck, tone: 'bg-sky-500/15 text-sky-400' },
    { label: l.failed, value: stats.failed, icon: XCircle, tone: 'bg-red-500/15 text-red-400' },
  ];

  return (
    <div className="space-y-6">
      {celebrate && <Confetti />}
      <Link href="/ads?tab=history" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-ink">
        <ArrowLeft className={cx('size-4', flip)} /> {l.allCampaigns}
      </Link>

      {launched && (
        <SuccessNote>
          {l.launched}
          {launched.skippedCount > 0 && ` ${l.skipped(launched.skippedCount)}`}
        </SuccessNote>
      )}
      {cancel.data && <SuccessNote>{l.cancelledCount(cancel.data.cancelled)}</SuccessNote>}
      <ErrorNote>{cancel.error ? errorMessage(cancel.error) : null}</ErrorNote>

      <section className="animate-fade-up relative overflow-hidden rounded-2xl border border-line bg-card shadow-sm">
        <div aria-hidden className="pointer-events-none absolute -top-24 start-1/3 size-72 rounded-full bg-brand/10 blur-3xl" />
        <header className="relative flex flex-wrap items-start justify-between gap-4 border-b border-line px-6 py-5">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate text-xl font-semibold">{data.name}</h2>
              <StateBadge state={data.state} />
            </div>
            <p className="text-sm text-muted">
              {fmt.dateTime(data.createdAt)} · {t.ads.recipientsCount(data.recipients)} · {t.ads.numbersCount(data.sessionIds.length)} · {t.ads.paces[data.pace]?.label}
              {running && data.finishesAt && new Date(data.finishesAt).getTime() > Date.now() && ` · ${l.finishesAt(fmt.time(data.finishesAt))}`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {running && (
              <Button
                variant="outline"
                icon={<CircleStop className="size-4" />}
                loading={cancel.isPending}
                onClick={() => confirm(l.cancelConfirm) && cancel.mutate()}
                className="text-red-400 hover:text-red-300"
              >
                {l.cancel}
              </Button>
            )}
            {!running && failedPhones.length > 0 && (
              <Button variant="outline" icon={copied ? <Check className="animate-scale-in size-4 text-brand" /> : <Copy className="size-4" />} onClick={() => void copyFailed()}>
                {copied ? l.copied : l.copyFailed}
              </Button>
            )}
            {!running && (
              <Link href="/ads" className="inline-flex h-9 items-center gap-2 rounded-md bg-brand px-4 text-sm font-medium text-black shadow-xs transition-colors hover:bg-brand-strong">
                <Sparkles className="size-4" /> {l.newCampaign}
              </Link>
            )}
          </div>
        </header>

        <div className="relative grid items-center gap-8 p-6 md:grid-cols-[auto_minmax(0,1fr)]">
          <ProgressRing value={processed} total={total} running={running} />
          <div className="space-y-4">
            {data.state === 'done' && (
              <div className="animate-scale-in rounded-xl border border-green-500/25 bg-green-500/10 p-4">
                <p className="flex items-center gap-2 font-semibold text-green-300">
                  <PartyPopper className="size-5" /> {l.complete}
                </p>
                <p className="mt-1 text-sm text-muted">
                  {l.completeText(fmt.number.format(stats.sent + stats.delivered + stats.read), fmt.number.format(stats.failed))}
                </p>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
              {tiles.map((tile, i) => (
                <StatTile key={tile.label} index={i} {...tile} />
              ))}
            </div>
            <StackedBar stats={stats} total={total} className="h-2.5" />
          </div>
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="animate-fade-up space-y-4 rounded-xl border border-line bg-card p-5 shadow-sm" style={delay(120)}>
          <h3 className="font-semibold">{l.feed}</h3>
          {data.recent.length === 0 ? (
            <p className="flex items-center gap-2 py-6 text-sm text-muted">
              <Send className="animate-float size-4 text-brand rtl:-scale-x-100" /> {l.feedEmpty}
            </p>
          ) : (
            <ul className="space-y-1">
              {data.recent.slice(0, 12).map((m) => {
                const meta = MESSAGE_STATUS[m.status];
                return (
                  <li key={`${m.id}-${m.status}`} className="animate-slide-in flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-raised/30">
                    <StatusIcon tone={meta.tone} icon={meta.icon} spin={m.status === 'sending'} />
                    <div className="min-w-0 flex-1">
                      <p className="ltr truncate font-mono text-sm">{m.phone ?? '—'}</p>
                      {m.error && <p className="truncate text-xs text-red-400">{m.error}</p>}
                    </div>
                    <span className="shrink-0 text-xs text-muted">{fmt.timeAgo(m.updatedAt)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <div className="space-y-6">
          <section className="animate-fade-up space-y-4 rounded-xl border border-line bg-card p-5 shadow-sm" style={delay(180)}>
            <h3 className="font-semibold">{l.lanes}</h3>
            <ul className="space-y-4">
              {data.sessions.map((lane) => {
                const now = lane.id === active;
                return (
                  <li key={lane.id} className="space-y-2">
                    <div className="flex items-center gap-3">
                      <span className={cx('relative flex size-9 shrink-0 items-center justify-center rounded-full', now ? 'bg-brand/20 text-brand' : 'bg-raised text-muted')}>
                        <Smartphone className="size-4" />
                        {now && <span className="absolute inset-0 animate-ping rounded-full bg-brand/30" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-2 truncate text-sm font-medium">
                          {lane.name}
                          {now && <span className="text-xs font-normal text-brand">{l.sendingNow}</span>}
                        </p>
                        <p className="ltr truncate font-mono text-xs text-muted">{lane.phone ?? '—'}</p>
                      </div>
                      <span className="shrink-0 text-sm tabular-nums">
                        {fmt.number.format(lane.done + lane.failed)}
                        <span className="text-muted">/{fmt.number.format(lane.total)}</span>
                      </span>
                    </div>
                    <div className="flex h-1.5 overflow-hidden rounded-full bg-raised">
                      <span className="h-full bg-brand transition-[width] duration-700" style={{ width: `${(lane.done / Math.max(1, lane.total)) * 100}%` }} />
                      <span className="h-full bg-red-500 transition-[width] duration-700" style={{ width: `${(lane.failed / Math.max(1, lane.total)) * 100}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="animate-fade-up overflow-hidden rounded-xl border border-line bg-card shadow-sm" style={delay(240)}>
            <TemplatePreview template={data.template} className="max-h-80 overflow-y-auto p-4" />
          </section>
        </div>
      </div>

      {data.failures.length > 0 && (
        <details className="animate-fade-up group rounded-xl border border-line bg-card p-5 shadow-sm">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-semibold">
            {l.failures}
            <Badge tone="critical">{fmt.number.format(stats.failed)}</Badge>
          </summary>
          <ul className="mt-4 max-h-72 divide-y divide-line overflow-y-auto text-sm">
            {data.failures.map((f, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="ltr font-mono">{f.phone ?? '—'}</span>
                <span className="text-xs text-red-400">{f.error}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// --- history ---------------------------------------------------------------------------------------

function History() {
  const { t, fmt } = useI18n();
  const h = t.ads.history;
  const query = useQuery({
    queryKey: qk.admin.broadcasts,
    queryFn: ({ signal }) => api<Campaign[]>('/api/broadcasts', { signal }),
    refetchInterval: (q) => (q.state.data?.some((c) => c.state === 'running') ? 5_000 : false),
  });
  if (query.error && !query.data) return <LoadError error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  if (!query.data) return <Loading />;
  if (!query.data.length) {
    return (
      <div className="animate-fade-up rounded-xl border border-line">
        <EmptyState
          icon={Megaphone}
          title={h.empty}
          text={h.emptyText}
          action={
            <Link href="/ads" className="inline-flex h-9 items-center gap-2 rounded-md bg-brand px-4 text-sm font-medium text-black hover:bg-brand-strong">
              <Plus className="size-4" /> {h.create}
            </Link>
          }
        />
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {query.data.map((c, i) => {
        const total = Math.max(c.recipients, 1);
        const processed = processedOf(c.stats);
        return (
          <li key={c.id} className="animate-fade-up" style={delay(Math.min(i, 10) * 50)}>
            <Link
              href={`/ads?campaign=${c.id}`}
              className="lift group flex flex-col gap-3 rounded-xl border border-line bg-card p-4 shadow-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <div className="flex flex-wrap items-center gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-[#3BE37F] to-[#0E9488] text-black">
                  <Megaphone className="size-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    <span className="truncate">{c.name}</span>
                    <StateBadge state={c.state} />
                  </p>
                  <p className="text-xs text-muted">
                    {fmt.dateTime(c.createdAt)} · {t.ads.recipientsCount(c.recipients)} · {h.numbers(c.sessionIds.length)} · {t.ads.paces[c.pace]?.label}
                  </p>
                </div>
                <span className="text-sm text-muted tabular-nums">{Math.round((processed / total) * 100)}%</span>
                <span className="text-sm font-medium text-brand opacity-0 transition-opacity group-hover:opacity-100">{h.open}</span>
              </div>
              <StackedBar stats={c.stats} total={total} />
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-ink/70" /> {t.ads.live.sent} {fmt.number.format(c.stats.sent)}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-brand" /> {t.ads.live.delivered} {fmt.number.format(c.stats.delivered)}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-sky-500" /> {t.ads.live.read} {fmt.number.format(c.stats.read)}
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-red-500" /> {t.ads.live.failed} {fmt.number.format(c.stats.failed)}
                </span>
                {c.stats.queued + c.stats.sending > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 rounded-full bg-raised" /> {t.ads.live.waiting} {fmt.number.format(c.stats.queued + c.stats.sending)}
                  </span>
                )}
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

// --- page ------------------------------------------------------------------------------------------

/** The locked/splash view for plans without `ads` (upgrade) or with it while the flag is off (soon). */
function AdsGate({ kind }: { kind: 'soon' | 'upgrade' }) {
  const { t } = useI18n();
  const g = t.ads.gate;
  const soon = kind === 'soon';
  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <PageHeader title={t.ads.title} description={t.ads.description} />
      <section className="animate-fade-up overflow-hidden rounded-xl border border-line bg-card shadow-sm">
        <div className="relative flex flex-col items-center gap-3 px-6 py-10 text-center">
          <span aria-hidden className="absolute -top-16 size-48 rounded-full bg-brand/15 blur-3xl" />
          <span className={cx('relative flex size-14 items-center justify-center rounded-2xl shadow-lg', soon ? 'bg-gradient-to-br from-brand to-[#0E9488] text-black' : 'bg-raised text-muted')}>
            {soon ? <Megaphone className="size-7" /> : <Lock className="size-7" />}
            <span className="absolute -bottom-1 -end-1 flex size-6 items-center justify-center rounded-full bg-card ring-1 ring-line">
              {soon ? <Clock className="size-3.5 text-brand" /> : <Lock className="size-3.5 text-muted" />}
            </span>
          </span>
          <h2 className="relative text-lg font-semibold">{soon ? g.soonTitle : g.lockedTitle}</h2>
          <p className="relative max-w-md text-sm text-muted">{soon ? g.soonText : g.lockedText}</p>
          {!soon && (
            <Link href="/subscription" className="relative mt-1">
              <Button>{g.upgrade}</Button>
            </Link>
          )}
        </div>
        <div className="border-t border-line bg-raised/30 px-6 py-5 text-start">
          <p className="mb-3 text-xs font-medium text-muted">{g.featuresTitle}</p>
          <ul className="grid gap-2.5 sm:grid-cols-2">
            {g.features.map((f) => (
              <li key={f} className="flex items-start gap-2 text-sm text-ink-2">
                <Check className="mt-0.5 size-4 shrink-0 text-brand" />
                {f}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}

/** Admin-only switch that flips `features.ads` for every eligible plan, shown on top of the page. */
function AdsFeatureSwitch({ enabled }: { enabled: boolean }) {
  const { t } = useI18n();
  const { reload } = useAccount();
  const g = t.ads.gate;
  const toggle = useMutation({
    mutationFn: (ads: boolean) => api<{ ads: boolean }>('/api/admin/features', { method: 'PUT', body: { ads } }),
    onSuccess: reload,
  });
  return (
    <div className="animate-fade-up flex flex-wrap items-center justify-between gap-3 rounded-xl border border-brand/25 bg-brand/5 px-4 py-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium">
          {g.adminLabel}
          <Badge tone={enabled ? 'good' : 'warning'}>{enabled ? g.adminOn : g.adminOff}</Badge>
        </p>
        <p className="mt-0.5 text-xs text-muted">{g.adminHint}</p>
      </div>
      <Switch checked={enabled} onChange={(v) => toggle.mutate(v)} disabled={toggle.isPending} label={g.adminLabel} />
    </div>
  );
}

/** Bulk "ads" campaigns: compose → choose numbers → launch → watch it go out live. */
export function AdsPage() {
  const { t } = useI18n();
  const { account } = useAccount();
  const params = useSearchParams();
  const campaignId = params.get('campaign');
  const tab = campaignId || params.get('tab') === 'history' ? 'history' : 'compose';
  // Kept mounted while browsing campaigns, so a half-written campaign survives a look at the history.
  const [composerKey, setComposerKey] = useState(0);

  const isAdmin = account?.user?.isAdmin === true;
  if (account && !isAdmin) {
    if (!planHasFeature(account.plan.id, 'ads')) return <AdsGate kind="upgrade" />;
    if (!account.features.ads) return <AdsGate kind="soon" />;
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      {isAdmin && account && <AdsFeatureSwitch enabled={account.features.ads} />}
      <PageHeader
        title={t.ads.title}
        description={t.ads.description}
        actions={
          <div role="tablist" className="inline-flex rounded-lg border border-line bg-raised/30 p-1">
            {(['compose', 'history'] as const).map((id) => (
              <Link
                key={id}
                role="tab"
                aria-selected={tab === id}
                href={id === 'compose' ? '/ads' : '/ads?tab=history'}
                className={cx(
                  'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-all duration-200',
                  tab === id ? 'bg-bg text-ink shadow-sm' : 'text-muted hover:text-ink',
                )}
              >
                {id === 'compose' ? <Sparkles className="size-4" /> : <Megaphone className="size-4" />}
                {t.ads.tabs[id]}
              </Link>
            ))}
          </div>
        }
      />
      <div className={tab === 'compose' ? undefined : 'hidden'}>
        <Composer
          key={composerKey}
          onLaunched={(created) => {
            lastLaunch = created;
            setComposerKey((k) => k + 1);
            navigate(`/ads?campaign=${created.id}`);
          }}
        />
      </div>
      {campaignId ? <LiveCampaign key={campaignId} id={campaignId} /> : tab === 'history' ? <History /> : null}
    </div>
  );
}
