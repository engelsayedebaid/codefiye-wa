import { PLACEHOLDER, POLL_LIMITS, type TemplateParts, templatePartsVariables } from '@wa/shared/template-text';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRight,
  Bell,
  Check,
  CheckCheck,
  Copy,
  FileText,
  Image as ImageIcon,
  ImageOff,
  KeyRound,
  ListChecks,
  Megaphone,
  PenLine,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import { useI18n } from '../i18n';
import type { Dict } from '../i18n/ar';
import { qk } from '../queries';
import type { Template, TemplateCategory } from '../types';
import { Badge, Button, cx, delay, EmptyState, ErrorNote, Field, flip, inputClass, Loading, LoadError, Modal, PageHeader, type Tone, TONES } from '../ui';

const CATEGORIES: { id: TemplateCategory; icon: typeof Bell; tone: Tone }[] = [
  { id: 'otp', icon: KeyRound, tone: 'good' },
  { id: 'notification', icon: Bell, tone: 'info' },
  { id: 'marketing', icon: Megaphone, tone: 'progress' },
  { id: 'custom', icon: PenLine, tone: 'neutral' },
];
const categoryMeta = (id: TemplateCategory) => CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[3]!;

/** Variables offered as one-click inserts in the editor. */
const SUGGESTED = ['code', 'name', 'order', 'status', 'date', 'time', 'amount', 'app', 'link'];

// --- WhatsApp-style rendering ----------------------------------------------------------------------

const OPEN = '\u0001';
const CLOSE = '\u0002';
const FILLED = /\u0001([^\u0002]*)\u0002/g;
const FORMAT = /(```[\s\S]+?```|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g;

/** Substituted values are wrapped in control characters so they can be highlighted after formatting. */
function highlightValues(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(FILLED)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    out.push(
      <span key={`${keyPrefix}-${m.index}`} className="rounded bg-white/15 px-0.5 light:bg-black/10">
        {m[1]}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}

/** Renders WhatsApp markup (*bold*, _italic_, ~strike~, ```monospace```) as React nodes — never as HTML strings. */
export function WhatsAppText({ text }: { text: string }) {
  const nodes: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(FORMAT)) {
    if (m.index! > last) nodes.push(...highlightValues(text.slice(last, m.index), `t${last}`));
    const mono = m[0].startsWith('```');
    const inner = highlightValues(mono ? m[0].slice(3, -3) : m[0].slice(1, -1), `f${m.index}`);
    const mark = m[0][0];
    nodes.push(
      mono ? (
        <code key={m.index} className="font-mono text-[0.95em]">
          {inner}
        </code>
      ) : mark === '*' ? (
        <strong key={m.index}>{inner}</strong>
      ) : mark === '_' ? (
        <em key={m.index}>{inner}</em>
      ) : (
        <s key={m.index}>{inner}</s>
      ),
    );
    last = m.index! + m[0].length;
  }
  nodes.push(...highlightValues(text.slice(last), `t${last}`));
  return <>{nodes}</>;
}

/** Fills placeholders with `values`, falling back to the sample values, else shows `{{name}}`. */
function fillForPreview(text: string, values: Record<string, string>, samples: Record<string, string>) {
  return text.replace(PLACEHOLDER, (_, name: string) => `${OPEN}${values[name]?.trim() || samples[name] || `{{${name}}}`}${CLOSE}`);
}

const plain = (text: string) => text.replace(FILLED, '$1');

function Timestamp() {
  return (
    <span className="mt-1 flex items-center justify-end gap-1 text-[11px] text-white/60 light:text-black/45">
      <span className="ltr">10:24</span>
      <CheckCheck className="size-3.5 text-[#53bdeb]" />
    </span>
  );
}

/** `onStatus` reports whether the link really is an image. No referrer, like the worker's download. */
function CardImage({ url, onStatus }: { url: string; onStatus?: (url: string, ok: boolean) => void }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  if (failed) {
    return (
      <span className="flex h-32 flex-col items-center justify-center gap-1.5 rounded-md bg-black/25 text-xs text-white/60">
        <ImageOff className="size-5" />
        {t.templates.imageError}
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      // The editor needs the verdict even while the preview is scrolled out of view.
      loading={onStatus ? 'eager' : 'lazy'}
      referrerPolicy="no-referrer"
      onLoad={() => onStatus?.(url, true)}
      onError={() => {
        setFailed(true);
        onStatus?.(url, false);
      }}
      className="max-h-52 w-full rounded-md object-cover"
    />
  );
}

/** How WhatsApp shows a poll: the question, then a radio row per option. */
function PollBubble({ title, options }: { title: string; options: string[] }) {
  const { t } = useI18n();
  return (
    <div className="animate-scale-in w-[min(18rem,90%)] rounded-lg rounded-se-sm bg-[#005c4b] px-3 pt-2.5 pb-1.5 text-[#e9edef] light:bg-[#d9fdd3] light:text-[#111b21] shadow" style={delay(120)}>
      <p dir="auto" className="font-semibold break-words">
        {title ? <WhatsAppText text={title} /> : '…'}
      </p>
      <p className="mt-0.5 flex items-center gap-1 text-[11px] text-white/60">
        <ListChecks className="size-3.5" /> {t.templates.selectOne}
      </p>
      <ul className="mt-2 space-y-2.5">
        {options.map((option, i) => (
          <li key={i} className="space-y-1">
            <span className="flex items-center gap-2 text-[14px]">
              <span className="size-4 shrink-0 rounded-full border-2 border-white/50 light:border-black/30" />
              <span dir="auto" className="min-w-0 flex-1 truncate">
                {option ? <WhatsAppText text={option} /> : '…'}
              </span>
            </span>
            <span className="ms-6 block h-1 rounded-full bg-white/15 light:bg-black/10" />
          </li>
        ))}
      </ul>
      <Timestamp />
      <p className="-mx-3 mt-1 border-t border-white/10 pt-1.5 text-center text-[13px] text-[#53bdeb] light:border-black/10 light:text-[#027eb5]">{t.templates.viewVotes}</p>
    </div>
  );
}

/**
 * Sent-message bubbles on WhatsApp's dark chat background: the text (or image card), then the
 * buttons poll. Sent messages sit at the end side, as in WhatsApp (left in Arabic, right in English).
 * `className` replaces the default shape and padding (`rounded-lg p-4`).
 */
export function TemplatePreview({
  template,
  values = {},
  className,
  onImageStatus,
}: {
  template: TemplateParts;
  values?: Record<string, string>;
  className?: string;
  onImageStatus?: (url: string, ok: boolean) => void;
}) {
  const { t } = useI18n();
  const samples = t.templates.samples;
  const fill = (text: string) => fillForPreview(text, values, samples);
  const buttons = template.buttons?.filter((b) => b.trim()) ?? [];
  return (
    <div
      className={cx('wa-wall wa-dots flex flex-col items-end gap-1.5', className ?? 'rounded-lg p-4')}>
      <div
        className={cx(
          'animate-scale-in max-w-[90%] rounded-lg rounded-se-sm bg-[#005c4b] text-[14px] leading-relaxed text-[#e9edef] shadow light:bg-[#d9fdd3] light:text-[#111b21]',
          template.imageUrl ? 'w-[min(18rem,90%)] p-1' : 'px-3 py-2',
        )}
      >
        {template.imageUrl && <CardImage url={template.imageUrl} onStatus={onImageStatus} />}
        <div className={template.imageUrl ? 'px-2 pt-1.5 pb-1' : undefined}>
          <p dir="auto" className="break-words whitespace-pre-wrap">
            {template.body.trim() ? <WhatsAppText text={fill(template.body)} /> : <span className="text-white/40">…</span>}
          </p>
          <Timestamp />
        </div>
      </div>
      {buttons.length > 0 && <PollBubble title={plain(fill(template.buttonsTitle ?? ''))} options={buttons.map((b) => plain(fill(b)))} />}
    </div>
  );
}

// --- API snippet ---------------------------------------------------------------------------------

function apiRequest(template: TemplateParts & { name: string; category: TemplateCategory }, samples: Record<string, string>) {
  const vars = templatePartsVariables(template);
  const otp = template.category === 'otp';
  const extra = Object.fromEntries(vars.filter((v) => !(otp && v === 'code')).map((v) => [v, samples[v] ?? '…']));
  const payload: Record<string, unknown> = { to: '+201012345678' };
  if (!otp || template.name !== 'otp') payload.template = template.name || 'my_template';
  if (Object.keys(extra).length) payload.variables = extra;
  return [
    `curl -X POST ${location.origin}/api/${otp ? 'send-otp' : 'send-message'} \\`,
    `  -H "Authorization: Bearer YOUR_SESSION_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify(payload)}'`,
  ].join('\n');
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={copied ? <Check className="animate-scale-in size-4 text-brand" /> : <Copy className="size-4" />}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard unavailable
        }
      }}
    >
      {copied ? t.templates.copied : label}
    </Button>
  );
}

function VariableChips({ names }: { names: string[] }) {
  const { t } = useI18n();
  if (!names.length) return <span className="text-xs text-faint">{t.templates.noVariables}</span>;
  return (
    <span className="flex flex-wrap gap-1.5" dir="ltr">
      {names.map((v) => (
        <code key={v} className="rounded bg-raised px-1.5 py-0.5 font-mono text-xs text-ink-2">{`{{${v}}}`}</code>
      ))}
    </span>
  );
}

// --- drafts --------------------------------------------------------------------------------------

type Draft = { id?: string; name: string; category: TemplateCategory; body: string; imageUrl: string; buttons: string[]; buttonsTitle: string };

const toDraft = (t: Template): Draft => ({
  id: t.id,
  name: t.name,
  category: t.category,
  body: t.body,
  imageUrl: t.imageUrl ?? '',
  buttons: t.buttons ?? [],
  buttonsTitle: t.buttonsTitle ?? '',
});

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// --- ready-made templates ------------------------------------------------------------------------

type StarterId = keyof Dict['templates']['starters'];
type Starter = { id: StarterId; category: TemplateCategory; name: string; imageUrl?: string };

/** The gallery, in display order (copy lives in i18n). A category's first starter is its default text. */
const STARTERS: Starter[] = [
  { id: 'otp', category: 'otp', name: 'otp' },
  { id: 'login', category: 'otp', name: 'login_code' },
  { id: 'order', category: 'notification', name: 'order_update' },
  { id: 'appointment', category: 'notification', name: 'appointment_reminder' },
  { id: 'payment', category: 'notification', name: 'payment_received' },
  { id: 'feedback', category: 'notification', name: 'feedback' },
  { id: 'promo', category: 'marketing', name: 'promo' },
  { id: 'arrival', category: 'marketing', name: 'new_arrival', imageUrl: 'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?w=800&q=80' },
];

const categoryStarter = (category: TemplateCategory) => STARTERS.find((s) => s.category === category);

/** Names are unique per workspace: `base`, else `base_2`, `base_3`… */
function freeName(base: string, taken: ReadonlySet<string>) {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/** A new draft from a starter, or a blank one. */
function starterDraft(starter: Starter | undefined, tt: Dict['templates'], taken: ReadonlySet<string>): Draft {
  const text = starter && tt.starters[starter.id];
  return {
    name: starter ? freeName(starter.name, taken) : '',
    category: starter?.category ?? 'custom',
    body: text?.body ?? '',
    imageUrl: starter?.imageUrl ?? '',
    buttons: text?.buttons ?? [],
    buttonsTitle: text?.buttonsTitle ?? '',
  };
}

type Filter = TemplateCategory | 'all';
const FILTERS: Filter[] = ['all', 'otp', 'notification', 'marketing'];

function GalleryCard({
  title,
  hint,
  icon: Icon,
  tone,
  name,
  badge,
  preview,
  index,
  onPick,
}: {
  title: string;
  hint: string;
  icon: typeof Bell;
  tone: Tone;
  name?: string;
  badge?: ReactNode;
  preview: ReactNode;
  index: number;
  onPick: () => void;
}) {
  return (
    <article
      className="lift group animate-fade-up relative flex flex-col overflow-hidden rounded-xl border border-line bg-card shadow-sm has-[:focus-visible]:border-ring has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50"
      style={delay(index * 50)}
    >
      <div aria-hidden className="wa-wall relative h-40 overflow-hidden">
        {preview}
        <span className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[#0b141a] to-transparent light:from-[#efeae2]" />
      </div>
      <div className="flex flex-1 items-start gap-3 border-t border-line p-4">
        <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-md', TONES[tone].chip)}>
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            {/* The ::after overlay makes the whole card the button. */}
            <button type="button" onClick={onPick} className="min-w-0 truncate text-start outline-none after:absolute after:inset-0 after:content-['']">
              {title}
            </button>
            {badge}
          </h3>
          <p className="text-xs text-muted">{hint}</p>
          {name && <p className="ltr truncate font-mono text-[11px] text-faint">{name}</p>}
        </div>
        <ArrowRight className={cx('mt-1.5 size-4 shrink-0 text-brand opacity-0 transition-opacity duration-200 group-hover:opacity-100', flip)} />
      </div>
    </article>
  );
}

function TemplateGallery({
  filter,
  onFilter,
  taken,
  onPick,
}: {
  filter: Filter;
  onFilter: (filter: Filter) => void;
  taken: ReadonlySet<string>;
  onPick: (draft: Draft) => void;
}) {
  const { t } = useI18n();
  const tt = t.templates;
  const shown = STARTERS.filter((s) => filter === 'all' || s.category === filter);
  return (
    <div className="space-y-5 pb-6">
      <div role="group" aria-label={tt.category} className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const active = filter === f;
          const n = STARTERS.filter((s) => f === 'all' || s.category === f).length;
          return (
            <button
              key={f}
              type="button"
              aria-pressed={active}
              onClick={() => onFilter(f)}
              className={cx(
                'inline-flex h-8 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                active ? 'border-brand/60 bg-brand/10 text-ink' : 'border-line text-muted hover:border-line-strong hover:text-ink',
              )}
            >
              {f === 'all' ? tt.all : tt.categories[f]}
              <span className={cx('text-xs tabular-nums', active ? 'text-brand' : 'text-faint')}>{n}</span>
            </button>
          );
        })}
      </div>

      {/* Keyed by filter so the cards animate in again when it changes. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <GalleryCard
          key={`${filter}-blank`}
          index={0}
          icon={Plus}
          tone="neutral"
          title={tt.blank}
          hint={tt.blankHint}
          onPick={() => onPick(starterDraft(undefined, tt, taken))}
          preview={
            <span className="flex h-full items-center justify-center">
              <span className="flex size-12 items-center justify-center rounded-full border border-dashed border-line-strong text-muted transition-colors duration-200 group-hover:border-brand/70 group-hover:text-brand">
                <Plus className="size-5" />
              </span>
            </span>
          }
        />
        {shown.map((starter, i) => {
          const meta = categoryMeta(starter.category);
          const text = tt.starters[starter.id];
          return (
            <GalleryCard
              key={`${filter}-${starter.id}`}
              index={i + 1}
              icon={meta.icon}
              tone={meta.tone}
              title={text.title}
              hint={text.hint}
              name={starter.name}
              badge={taken.has(starter.name) ? <Badge tone="neutral" className="py-0.5">{tt.added}</Badge> : null}
              onPick={() => onPick(starterDraft(starter, tt, taken))}
              preview={
                <TemplatePreview
                  template={{ body: text.body, imageUrl: starter.imageUrl, buttons: text.buttons, buttonsTitle: text.buttonsTitle }}
                  className="min-h-full p-3"
                />
              }
            />
          );
        })}
      </div>
    </div>
  );
}

// --- editor --------------------------------------------------------------------------------------

function TemplateEditor({
  initial,
  taken,
  onBack,
  onCancel,
  onSaved,
}: {
  initial: Draft;
  taken: ReadonlySet<string>;
  /** Back to the gallery (new templates only). */
  onBack?: () => void;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const tt = t.templates;
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const buttons = draft.buttons.map((b) => b.trim()).filter(Boolean);
  const parts: TemplateParts = { body: draft.body, imageUrl: draft.imageUrl.trim() || null, buttons, buttonsTitle: draft.buttonsTitle };
  const variables = templatePartsVariables(parts);
  const missingCode = draft.category === 'otp' && !/\{\{\s*code\s*\}\}/.test(draft.body);
  const tooFewButtons = buttons.length === 1;
  // A link that doesn't load as an image in the preview (usually a web page) would fail to send.
  const [badImage, setBadImage] = useState<string | null>(null);
  const imageBroken = parts.imageUrl !== null && parts.imageUrl === badImage;
  const onImageStatus = useCallback((url: string, ok: boolean) => setBadImage(ok ? null : url), []);

  const chooseCategory = (category: TemplateCategory) =>
    setDraft((d) => {
      // Swap in the category's default text, name and buttons only while they still hold the previous default.
      const prev = starterDraft(categoryStarter(d.category), tt, taken);
      const next = starterDraft(categoryStarter(category), tt, taken);
      const bodyUntouched = !d.body.trim() || d.body === prev.body;
      const nameUntouched = !d.name || d.name === prev.name;
      const buttonsUntouched = d.buttons.every((b) => !b.trim()) || (prev.buttons.length > 0 && sameList(d.buttons, prev.buttons));
      return {
        ...d,
        category,
        body: bodyUntouched ? next.body : d.body,
        name: !d.id && nameUntouched ? next.name : d.name,
        ...(buttonsUntouched ? { buttons: next.buttons, buttonsTitle: next.buttonsTitle } : {}),
      };
    });

  const back = () => {
    const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
    if (!dirty || confirm(tt.discardChanges)) onBack?.();
  };

  const insert = (name: string) => {
    const el = bodyRef.current;
    const token = `{{${name}}}`;
    const start = el?.selectionStart ?? draft.body.length;
    const end = el?.selectionEnd ?? draft.body.length;
    setDraft((d) => ({ ...d, body: d.body.slice(0, start) + token + d.body.slice(end) }));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + token.length, start + token.length);
    });
  };

  const setButton = (i: number, value: string) => setDraft((d) => ({ ...d, buttons: d.buttons.map((b, j) => (j === i ? value : b)) }));
  const addButton = () =>
    setDraft((d) => ({
      ...d,
      // The first two buttons come together: a poll needs at least two options.
      buttons: d.buttons.length === 0 ? ['', ''] : [...d.buttons, ''],
      buttonsTitle: d.buttonsTitle || tt.buttonsTitleDefault,
    }));
  const removeButton = (i: number) => setDraft((d) => ({ ...d, buttons: d.buttons.filter((_, j) => j !== i) }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (missingCode || tooFewButtons || imageBroken) return;
    setSaving(true);
    setErrors({});
    setError(null);
    try {
      const body = {
        name: draft.name.trim(),
        category: draft.category,
        body: draft.body,
        imageUrl: parts.imageUrl,
        buttons: buttons.length ? buttons : null,
        buttonsTitle: buttons.length ? draft.buttonsTitle.trim() : null,
      };
      if (draft.id) await api(`/api/templates/${draft.id}`, { method: 'PUT', body });
      else await api('/api/templates', { method: 'POST', body });
      onSaved();
    } catch (err) {
      if (err instanceof ApiRequestError && err.errors) setErrors(err.errors);
      else setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const fieldError = (key: string) => (errors[key] ? <span className="block text-sm text-destructive-ink">{errors[key]!.join(' ')}</span> : null);

  return (
    <form onSubmit={submit} className="animate-fade-in">
      <div className="grid gap-6 pb-6 lg:grid-cols-[1.15fr_1fr]">
        {/* min-w-0: a long code line must scroll inside its <pre>, not widen the column. */}
        <div className="min-w-0 space-y-5">
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm leading-none font-medium">{tt.category}</legend>
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map(({ id, icon: Icon }) => {
                const active = draft.category === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => chooseCategory(id)}
                    aria-pressed={active}
                    className={cx(
                      'flex h-9 items-center gap-2 rounded-lg border ps-1.5 pe-3 text-sm font-medium transition-all duration-200 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      active ? 'border-brand/60 bg-brand/10 shadow-[0_0_24px_-12px] shadow-brand' : 'border-line text-ink-2 hover:border-line-strong hover:bg-raised/40',
                    )}
                  >
                    <span className={cx('flex size-6 shrink-0 items-center justify-center rounded-md', active ? 'bg-brand text-on-brand' : 'bg-raised text-muted')}>
                      <Icon className="size-3.5" />
                    </span>
                    {tt.categories[id]}
                  </button>
                );
              })}
            </div>
            <p className="text-sm text-muted">{tt.categoryHints[draft.category]}</p>
          </fieldset>

          <Field
            label={tt.name}
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="order_update"
            dir="ltr"
            className="font-mono"
            required
            maxLength={64}
            pattern="[A-Za-z0-9_\-]{1,64}"
            hint={tt.nameHint}
            error={errors.name}
          />

          <label className="grid gap-2">
            <span className="text-sm leading-none font-medium">{tt.body}</span>
            <textarea
              ref={bodyRef}
              value={draft.body}
              onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
              rows={5}
              dir="auto"
              required
              maxLength={4096}
              className={cx(inputClass, 'h-auto min-h-28 py-2')}
            />
            <span className="text-sm text-muted">{tt.bodyHint}</span>
            {fieldError('body')}
          </label>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="me-1 text-xs text-muted">{tt.insert}:</span>
            {SUGGESTED.map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => insert(v)}
                className="rounded-md border border-line px-2 py-0.5 font-mono text-xs text-ink-2 transition-colors hover:border-brand/50 hover:text-ink"
                dir="ltr"
              >
                {`{{${v}}}`}
              </button>
            ))}
          </div>

          <label className="grid gap-2">
            <span className="flex items-center gap-2 text-sm leading-none font-medium">
              <ImageIcon className="size-4 text-muted" /> {tt.image}
            </span>
            <span className="flex gap-2">
              <input
                type="url"
                value={draft.imageUrl}
                onChange={(e) => setDraft((d) => ({ ...d, imageUrl: e.target.value }))}
                placeholder="https://example.com/product.jpg"
                dir="ltr"
                className={inputClass}
              />
              {draft.imageUrl && (
                <Button variant="ghost" size="sm" className="h-9" onClick={() => setDraft((d) => ({ ...d, imageUrl: '' }))} aria-label={t.common.delete}>
                  <X className="size-4" />
                </Button>
              )}
            </span>
            <span className="text-sm text-muted">{tt.imageHint}</span>
            {imageBroken && <span className="animate-fade-in block text-sm text-destructive-ink">{tt.imageNotImage}</span>}
            {fieldError('imageUrl')}
          </label>

          <fieldset className="space-y-2.5">
            <legend className="mb-2 flex items-center gap-2 text-sm leading-none font-medium">
              <ListChecks className="size-4 text-muted" /> {tt.buttons}
            </legend>
            <p className="text-sm text-muted">{tt.buttonsHint}</p>
            {draft.buttons.length > 0 && (
              <div className="animate-fade-in space-y-2">
                <input
                  value={draft.buttonsTitle}
                  onChange={(e) => setDraft((d) => ({ ...d, buttonsTitle: e.target.value }))}
                  placeholder={tt.buttonsTitle}
                  aria-label={tt.buttonsTitle}
                  maxLength={POLL_LIMITS.question}
                  dir="auto"
                  required
                  className={cx(inputClass, 'font-medium')}
                />
                {draft.buttons.map((label, i) => (
                  <span key={i} className="animate-fade-in flex items-center gap-2">
                    <span className="size-4 shrink-0 rounded-full border-2 border-line-strong" />
                    <input
                      value={label}
                      onChange={(e) => setButton(i, e.target.value)}
                      placeholder={tt.buttonLabel(i + 1)}
                      aria-label={tt.buttonLabel(i + 1)}
                      maxLength={POLL_LIMITS.option}
                      dir="auto"
                      className={inputClass}
                    />
                    <button
                      type="button"
                      onClick={() => removeButton(i)}
                      aria-label={tt.removeButton}
                      className="rounded-md p-1.5 text-muted transition-colors hover:bg-raised hover:text-red-400"
                    >
                      <X className="size-4" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {draft.buttons.length < POLL_LIMITS.maxOptions && (
              <Button variant="outline" size="sm" icon={<Plus className="size-4" />} onClick={addButton}>
                {tt.addButton}
              </Button>
            )}
            {tooFewButtons && <p className="text-sm text-amber-400">{tt.needTwoButtons}</p>}
            {fieldError('buttons')}
            {fieldError('buttonsTitle')}
          </fieldset>

          {missingCode && <ErrorNote>{tt.otpNeedsCode}</ErrorNote>}
          <ErrorNote>{error}</ErrorNote>
        </div>

        <div className="min-w-0 space-y-5 lg:sticky lg:top-0 lg:self-start">
          <div className="space-y-2">
            <p className="text-sm leading-none font-medium">{tt.preview}</p>
            <TemplatePreview template={parts} onImageStatus={onImageStatus} />
          </div>
          <div className="space-y-2">
            <p className="text-sm leading-none font-medium">{tt.variables}</p>
            <VariableChips names={variables} />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm leading-none font-medium">{tt.api}</p>
              <CopyButton text={apiRequest({ ...parts, name: draft.name, category: draft.category }, tt.samples)} label={tt.copy} />
            </div>
            <pre dir="ltr" className="code-scroll overflow-x-auto rounded-lg border border-line bg-[#141414] p-3 font-mono text-[12px] leading-5 text-[#d4d4d4]">
              {apiRequest({ ...parts, name: draft.name, category: draft.category }, tt.samples)}
            </pre>
            {draft.category === 'otp' && <p className="text-xs text-muted">{tt.otpTip}</p>}
          </div>
        </div>
      </div>

      {/* Stays in view while the form scrolls inside the dialog. */}
      <div className="sticky bottom-0 z-10 -mx-6 flex flex-wrap items-center gap-2 border-t border-line bg-bg px-6 py-4">
        {onBack && (
          <Button variant="ghost" icon={<ArrowLeft className={cx('size-4', flip)} />} onClick={back}>
            {tt.back}
          </Button>
        )}
        <div className="ms-auto flex gap-2">
          <Button variant="outline" onClick={onCancel}>
            {t.common.cancel}
          </Button>
          <Button type="submit" variant="brand" loading={saving} disabled={missingCode || tooFewButtons || imageBroken}>
            {draft.id ? tt.save : tt.create}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** New templates start in the gallery, then open in the editor; existing ones open straight in the editor. */
function TemplateDialog({
  template,
  filter: initialFilter,
  taken,
  onClose,
  onSaved,
}: {
  template?: Template;
  filter: Filter;
  taken: ReadonlySet<string>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const tt = t.templates;
  const [draft, setDraft] = useState<Draft | null>(() => (template ? toDraft(template) : null));
  const [filter, setFilter] = useState(initialFilter);
  return (
    <Modal
      size="xl"
      onClose={onClose}
      title={template ? tt.editTitle(template.name) : draft ? tt.newTitle : tt.chooseTitle}
      description={draft ? undefined : tt.chooseText}
    >
      {draft ? (
        <TemplateEditor initial={draft} taken={taken} onBack={template ? undefined : () => setDraft(null)} onCancel={onClose} onSaved={onSaved} />
      ) : (
        <TemplateGallery filter={filter} onFilter={setFilter} taken={taken} onPick={setDraft} />
      )}
    </Modal>
  );
}

// --- page ----------------------------------------------------------------------------------------

export function TemplatesPage() {
  const { t, fmt } = useI18n();
  const tt = t.templates;
  const queryClient = useQueryClient();
  /** `template` edits it; otherwise the gallery opens on `filter`. */
  const [dialog, setDialog] = useState<{ template?: Template; filter?: Filter } | null>(null);
  // Shared with the session page's template picker.
  const query = useQuery({ queryKey: qk.templates, queryFn: ({ signal }) => api<Template[]>('/api/templates', { signal }) });
  const templates = query.data ?? null;
  const taken = useMemo(() => new Set(templates?.map((x) => x.name)), [templates]);

  // Gone from the grid at once; back if the server refuses.
  const removal = useMutation({
    mutationFn: (template: Template) => api(`/api/templates/${template.id}`, { method: 'DELETE' }),
    onMutate: async (template) => {
      await queryClient.cancelQueries({ queryKey: qk.templates });
      const previous = queryClient.getQueryData<Template[]>(qk.templates);
      queryClient.setQueryData<Template[]>(qk.templates, (list) => list?.filter((x) => x.id !== template.id));
      return { previous };
    },
    onError: (_err, _template, context) => queryClient.setQueryData(qk.templates, context?.previous),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: qk.templates }),
  });
  const remove = (template: Template) => {
    if (confirm(tt.confirmDelete(template.name))) removal.mutate(template);
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        title={tt.title}
        description={tt.description}
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setDialog({})}>
            {tt.new}
          </Button>
        }
      />
      <ErrorNote>{removal.isError ? errorMessage(removal.error) : null}</ErrorNote>
      {query.isError && <LoadError error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />}

      {templates === null ? (
        !query.isError && <Loading />
      ) : templates.length === 0 ? (
        <div className="animate-fade-up rounded-xl border border-line">
          <EmptyState
            icon={FileText}
            title={tt.emptyTitle}
            text={tt.emptyText}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {CATEGORIES.filter((c) => c.id !== 'custom').map(({ id, icon: Icon }) => (
                  <Button key={id} variant={id === 'otp' ? 'brand' : 'outline'} icon={<Icon className="size-4" />} onClick={() => setDialog({ filter: id })}>
                    {tt.categories[id]}
                  </Button>
                ))}
              </div>
            }
          />
        </div>
      ) : (
        <div className="grid items-start gap-6 md:grid-cols-2 xl:grid-cols-3">
          {templates.map((template, i) => {
            const meta = categoryMeta(template.category);
            return (
              <article
                key={template.id}
                className="lift animate-fade-up flex flex-col overflow-hidden rounded-xl border border-line bg-card shadow-sm"
                style={delay(i * 70)}
              >
                <header className="flex items-start justify-between gap-3 px-5 pt-5">
                  <div className="min-w-0 space-y-1.5">
                    <h3 className="ltr truncate font-mono text-base font-semibold">{template.name}</h3>
                    <p className="text-xs text-muted">{tt.updated(fmt.timeAgo(template.updatedAt))}</p>
                  </div>
                  <Badge tone={meta.tone} className="gap-1.5">
                    <meta.icon className="size-3.5" />
                    {tt.categories[template.category]}
                  </Badge>
                </header>
                <div className="flex-1 space-y-3 px-5 py-4">
                  <TemplatePreview template={template} className="rounded-lg p-3" />
                  <div className="flex flex-wrap items-center gap-1.5">
                    {template.imageUrl && (
                      <Badge tone="neutral" className="gap-1">
                        <ImageIcon className="size-3.5" /> {tt.imageBadge}
                      </Badge>
                    )}
                    {template.buttons?.length ? (
                      <Badge tone="neutral" className="gap-1">
                        <ListChecks className="size-3.5" /> {tt.buttonsBadge(template.buttons.length)}
                      </Badge>
                    ) : null}
                    <VariableChips names={template.variables} />
                  </div>
                </div>
                <footer className="flex items-center justify-between gap-2 border-t border-line px-3 py-3">
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" icon={<PenLine className="size-4" />} onClick={() => setDialog({ template })}>
                      {tt.edit}
                    </Button>
                    <CopyButton text={apiRequest(template, tt.samples)} label={tt.copy} />
                  </div>
                  <Button variant="ghost" size="sm" icon={<Trash2 className="size-4" />} onClick={() => remove(template)} className="text-red-400 hover:text-red-300">
                    {t.common.delete}
                  </Button>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {dialog && (
        <TemplateDialog
          template={dialog.template}
          filter={dialog.filter ?? 'all'}
          taken={taken}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void queryClient.invalidateQueries({ queryKey: qk.templates });
          }}
        />
      )}
    </div>
  );
}
