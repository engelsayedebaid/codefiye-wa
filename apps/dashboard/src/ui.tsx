import type { MessageStatus, SessionStatus } from '@wa/shared/constants';
import {
  AlertTriangle,
  Check,
  CheckCheck,
  ChevronDown,
  CircleDashed,
  Clock,
  Copy,
  Globe,
  Inbox,
  Loader2,
  LogOut,
  QrCode,
  RotateCw,
  Unplug,
  Wifi,
  X,
  XCircle,
} from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  type CSSProperties,
  type InputHTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { errorMessage } from './api';
import { BRAND } from './brand';
import { useI18n } from './i18n';

export const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ');

/** For icons that point "forward": drawn for LTR, mirrored in RTL. */
export const flip = 'rtl:-scale-x-100';

// --- buttons (shadcn/ui shapes) ------------------------------------------------------------------

type Variant = 'white' | 'brand' | 'outline' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  white: 'bg-ink text-[#171717] shadow-xs hover:bg-ink/90',
  brand: 'bg-brand text-black shadow-xs hover:bg-brand-strong hover:shadow-[0_8px_30px_-8px] hover:shadow-brand/60',
  outline: 'border border-line bg-bg text-ink shadow-xs hover:bg-raised',
  secondary: 'bg-raised text-ink shadow-xs hover:bg-raised/80',
  ghost: 'text-ink-2 hover:bg-raised hover:text-ink',
  danger: 'bg-destructive text-white shadow-xs hover:bg-destructive/90',
};
const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm gap-1.5 rounded-md',
  md: 'h-9 px-4 text-sm gap-2 rounded-md',
  lg: 'h-11 px-6 text-base gap-2.5 rounded-md',
};

export const buttonClass = (variant: Variant = 'white', size: Size = 'md', className?: string) =>
  cx(
    'group inline-flex shrink-0 cursor-pointer items-center justify-center font-medium whitespace-nowrap transition-[color,background-color,box-shadow,transform] duration-200 active:scale-[0.97] [&_svg]:shrink-0',
    'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50',
    VARIANTS[variant],
    SIZES[size],
    className,
  );

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; loading?: boolean; icon?: ReactNode };

export function Button({ variant = 'white', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button {...rest} type={type} disabled={disabled || loading} className={buttonClass(variant, size, className)}>
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

// --- brand ---------------------------------------------------------------------------------------

/** The mark: a chat bubble carrying `</>` — WhatsApp messaging, for developers. */
export function LogoMark({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 40 40" fill="none" aria-hidden className={cx('size-8 shrink-0', className)}>
      <defs>
        <linearGradient id={id} x1="4" y1="2" x2="36" y2="38" gradientUnits="userSpaceOnUse">
          <stop stopColor="#3BE37F" />
          <stop offset="1" stopColor="#0E9488" />
        </linearGradient>
      </defs>
      <rect width="40" height="40" rx="11" fill={`url(#${id})`} />
      <path
        d="M12 10.5h16a5 5 0 0 1 5 5v8a5 5 0 0 1-5 5h-8.2l-5.6 4.3a.8.8 0 0 1-1.3-.63V28.4A5 5 0 0 1 7 23.5v-8a5 5 0 0 1 5-5Z"
        fill="#fff"
      />
      <path d="m16.4 16.4-3 3.1 3 3.1M23.6 16.4l3 3.1-3 3.1M21.1 15.4l-2.2 8.2" stroke="#0B8F6B" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  const [first, ...rest] = BRAND.name.split('-');
  return (
    <span className={cx('group/logo inline-flex items-center gap-2.5', className)}>
      <LogoMark className="transition-transform duration-500 group-hover/logo:-rotate-6 group-hover/logo:scale-105" />
      <span dir="ltr" className="text-lg font-bold tracking-tight">
        <span className="text-brand">{first}</span>
        {rest.length > 0 && <span>-{rest.join('-')}</span>}
      </span>
    </span>
  );
}

export function LangSwitch({ className }: { className?: string }) {
  const { lang, setLang, t } = useI18n();
  return (
    <button
      onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
      aria-label={t.lang.aria}
      lang={lang === 'ar' ? 'en' : 'ar'}
      className={cx(
        'inline-flex h-9 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-ink-2 transition-colors hover:bg-raised hover:text-ink',
        className,
      )}
    >
      <Globe className="size-4" />
      {t.lang.other}
    </button>
  );
}

// --- motion --------------------------------------------------------------------------------------

/** Fades and lifts its children in the first time they scroll into view (see `.reveal` in index.css). */
export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return setShown(true);
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShown(true);
          observer.disconnect();
        }
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} data-shown={shown || undefined} className={cx('reveal', className)} style={{ '--delay': `${delay}ms` } as CSSProperties}>
      {children}
    </div>
  );
}

/** Inline style for staggered entrance animations (`animate-fade-up` reads `--delay`). */
export const delay = (ms: number) => ({ '--delay': `${ms}ms` }) as CSSProperties;

// --- layout pieces -------------------------------------------------------------------------------

export function Card({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  style,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  style?: CSSProperties;
}) {
  const hasHeader = Boolean(title || actions);
  return (
    <section style={style} className={cx('flex min-w-0 flex-col gap-6 rounded-xl border border-line bg-card py-6 shadow-sm', className)}>
      {hasHeader && (
        <header className="flex flex-wrap items-start justify-between gap-3 px-6">
          <div className="space-y-1.5">
            <h2 className="text-lg leading-none font-semibold">{title}</h2>
            {description && <p className="text-sm text-muted">{description}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx('px-6', bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="space-y-1">
        <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
        {description && <p className="text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Small pill used for counts and plan names ("Trial", "3 total"). */
export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('rounded-full bg-ink/10 px-2.5 py-1 text-sm font-medium whitespace-nowrap', className)}>{children}</span>;
}

/** Fills from zero on mount so usage bars animate in. */
export function Progress({ value, className }: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(pct));
    return () => cancelAnimationFrame(frame);
  }, [pct]);
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} className={cx('h-2.5 w-full overflow-hidden rounded-full bg-ink/20', className)}>
      <div className="h-full rounded-full bg-ink transition-[width] duration-1000 ease-out" style={{ width: `${shown}%` }} />
    </div>
  );
}

export function EmptyState({ icon: Icon, title, text, action }: { icon: typeof Wifi; title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <span className="animate-float rounded-full bg-raised p-3">
        <Icon className="size-6 text-muted" />
      </span>
      <h3 className="mt-4 text-lg font-medium">{title}</h3>
      {text && <p className="mt-2 max-w-sm text-sm text-muted">{text}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// --- form controls -------------------------------------------------------------------------------

export const inputClass =
  'h-9 w-full min-w-0 rounded-md border border-line bg-transparent px-3 py-1 text-base text-ink shadow-xs outline-none transition-[color,box-shadow,border-color] placeholder:text-muted md:text-sm focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50';

export function Field({
  label,
  hint,
  error,
  aside,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string[]; aside?: ReactNode }) {
  const { lang } = useI18n();
  return (
    <label className="grid gap-2">
      <span className="flex items-center justify-between text-sm leading-none font-medium">
        {label}
        {aside}
      </span>
      <input
        {...input}
        aria-invalid={error ? true : undefined}
        className={cx(inputClass, error && 'border-destructive-ink ring-destructive-ink/30', input.className)}
      />
      {error ? (
        <span className="block text-sm text-destructive-ink">{error.join(lang === 'ar' ? '، ' : ', ')}</span>
      ) : (
        hint && <span className="block text-sm text-muted">{hint}</span>
      )}
    </label>
  );
}

export function TextArea({ label, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  return (
    <label className="grid gap-2">
      <span className="text-sm leading-none font-medium">{label}</span>
      <textarea {...rest} className={cx(inputClass, 'h-auto min-h-16 py-2', rest.className)} />
    </label>
  );
}

export type SelectOption<T extends string> = { value: T; label: ReactNode };

/**
 * Themed dropdown (shadcn-style listbox). Replaces the native <select>, whose open list is drawn by
 * the browser/OS and ignores the dark theme (white popup with unreadable text on some systems).
 * Keyboard: ↑/↓/Home/End to move, Enter/Space to pick, Esc/Tab to close.
 */
export function Select<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
  disabled,
  'aria-label': ariaLabel,
}: {
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  label?: string;
  className?: string;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(0, options.findIndex((o) => o.value === value));
  const [active, setActive] = useState(selectedIndex);

  useEffect(() => {
    if (!open) return;
    setActive(selectedIndex);
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, selectedIndex]);

  // Keep the highlighted option in view while moving with the keyboard.
  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const pick = (i: number) => {
    const option = options[i];
    if (option) onChange(option.value);
    setOpen(false);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    const last = options.length - 1;
    if (e.key === 'ArrowDown') setActive((a) => Math.min(last, a + 1));
    else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1));
    else if (e.key === 'Home') setActive(0);
    else if (e.key === 'End') setActive(last);
    else if (e.key === 'Enter' || e.key === ' ') pick(active);
    else if (e.key === 'Escape' || e.key === 'Tab') {
      if (e.key === 'Escape') e.stopPropagation(); // don't also close an enclosing modal
      setOpen(false);
      return;
    } else return;
    e.preventDefault();
  };

  return (
    <div className={cx('grid gap-2', className)}>
      {label && (
        <span id={`${id}-label`} className="text-sm leading-none font-medium">
          {label}
        </span>
      )}
      <div ref={ref} className="relative" onKeyDown={onKeyDown}>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-label={ariaLabel}
          aria-labelledby={label ? `${id}-label` : undefined}
          aria-activedescendant={open ? `${id}-opt-${active}` : undefined}
          className={cx(inputClass, 'flex cursor-pointer items-center justify-between gap-2 bg-bg text-start', open && 'border-ring ring-[3px] ring-ring/50')}
        >
          <span className="min-w-0 flex-1 truncate">{options[selectedIndex]?.label}</span>
          <ChevronDown className={cx('size-4 shrink-0 text-muted transition-transform duration-200', open && 'rotate-180')} />
        </button>
        {open && (
          <ul
            ref={listRef}
            id={`${id}-list`}
            role="listbox"
            aria-labelledby={label ? `${id}-label` : undefined}
            aria-label={label ? undefined : ariaLabel}
            className="animate-scale-in absolute inset-x-0 top-full z-50 mt-1.5 max-h-72 min-w-max origin-top overflow-auto rounded-md border border-line bg-bg p-1 shadow-xl shadow-black/50"
          >
            {options.map((option, i) => {
              const selected = option.value === value;
              return (
                <li
                  key={option.value}
                  id={`${id}-opt-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(i)}
                  className={cx(
                    'flex cursor-pointer items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-sm transition-colors select-none',
                    i === active ? 'bg-raised text-ink' : 'text-ink-2',
                    selected && 'font-medium text-ink',
                  )}
                >
                  <span className="min-w-0 truncate">{option.label}</span>
                  {selected && <Check className="size-4 shrink-0 text-brand" />}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Centered spinner with a caption, for sections that are fetching. */
export function Loading({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <div role="status" className={cx('animate-fade-in flex items-center justify-center gap-2.5 py-8 text-sm text-muted', className)}>
      <span className="relative flex size-5">
        <span className="absolute inset-0 animate-ping rounded-full bg-brand/20" />
        <Loader2 className="relative size-5 animate-spin text-brand" />
      </span>
      {t.common.loading}
    </div>
  );
}

export function Checkbox({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-px size-4 shrink-0 cursor-pointer appearance-none rounded-[4px] border border-line bg-transparent bg-center bg-no-repeat shadow-xs transition-colors outline-none checked:border-ink checked:bg-ink focus-visible:ring-[3px] focus-visible:ring-ring/50"
        style={{
          backgroundImage: checked
            ? "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23171717' stroke-width='2'%3E%3Cpath d='M3.5 8.5l3 3 6-7'/%3E%3C/svg%3E\")"
            : undefined,
        }}
      />
      <span className="space-y-1">
        <span className="block text-sm leading-none font-medium">{label}</span>
        {hint && <span className="block text-sm text-muted">{hint}</span>}
      </span>
    </label>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="animate-fade-up flex items-start gap-3 rounded-lg border border-destructive-ink/30 bg-destructive/15 px-4 py-3 text-sm text-red-200">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive-ink" />
      <span>{children}</span>
    </p>
  );
}

export function SuccessNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="animate-fade-up flex items-start gap-3 rounded-lg border border-green-500/25 bg-green-500/10 px-4 py-3 text-sm text-green-200">
      <Check className="mt-0.5 size-4 shrink-0 text-green-500" />
      <span>{children}</span>
    </p>
  );
}

// --- overlays ------------------------------------------------------------------------------------

const MODAL_SIZES = {
  md: 'max-w-lg',
  lg: 'max-w-xl',
  // Tall editors: the body scrolls under a fixed header and has no bottom padding, so the content can
  // end with a `sticky bottom-0` footer (or pad itself). Only used where no dropdown overflows the dialog.
  xl: 'max-w-5xl max-h-[92svh] pb-0',
};

export function Modal({
  title,
  description,
  onClose,
  children,
  wide,
  size = wide ? 'lg' : 'md',
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  size?: keyof typeof MODAL_SIZES;
}) {
  const { t } = useI18n();
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  // A multi-step dialog shows a new title per step; each step starts scrolled to the top. Braces matter:
  // scrollTo() returns a Promise in recent browsers, and an effect must not return anything but a cleanup.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: 0 });
  }, [title]);
  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]" onClick={onClose}>
      <div
        role="dialog"
        aria-modal
        aria-label={title}
        className={cx('animate-scale-in relative flex w-full flex-col gap-4 rounded-lg border border-line bg-bg p-6 shadow-lg', MODAL_SIZES[size])}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="space-y-2 pe-6 text-start">
          <h2 className="text-lg leading-none font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted">{description}</p>}
        </header>
        <button onClick={onClose} className="absolute top-4 end-4 rounded-xs opacity-70 transition-opacity hover:opacity-100" aria-label={t.common.close}>
          <X className="size-4" />
        </button>
        <div ref={bodyRef} className={cx('space-y-4', size === 'xl' && '-mx-6 min-h-0 flex-1 overflow-y-auto px-6 pt-1')}>
          {children}
        </div>
      </div>
    </div>
  );
}

export function CopyField({ value }: { value: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard unavailable; the value is selectable
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-raised/40 p-1.5">
      <code className="ltr min-w-0 flex-1 truncate px-1.5 font-mono text-sm select-all">{value}</code>
      <button onClick={copy} className="rounded-md p-1.5 text-muted transition-colors hover:bg-raised hover:text-ink" aria-label={t.common.copy}>
        {copied ? <Check className="animate-scale-in size-4 text-brand" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}

/** Shows a freshly created key once, with the warning that it can't be retrieved later. */
export function KeyReveal({ title, value, onClose }: { title: string; value: string; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal title={title} description={t.common.keyRevealText} onClose={onClose}>
      <CopyField value={value} />
      <Button className="w-full" onClick={onClose}>
        {t.common.keySaved}
      </Button>
    </Modal>
  );
}

// --- status --------------------------------------------------------------------------------------

export type Tone = 'good' | 'info' | 'progress' | 'warning' | 'critical' | 'neutral';

/** Soft tinted chips, as in the reference dashboard ("Connected", "Scan QR", "Logged Out"). */
export const TONES: Record<Tone, { chip: string; dot: string; text: string }> = {
  good: { chip: 'bg-green-500/10 text-green-500', dot: 'bg-green-500', text: 'text-green-500' },
  info: { chip: 'bg-blue-500/10 text-blue-500', dot: 'bg-blue-500', text: 'text-blue-500' },
  progress: { chip: 'bg-purple-500/10 text-purple-400', dot: 'bg-purple-500', text: 'text-purple-400' },
  warning: { chip: 'bg-amber-500/10 text-amber-400', dot: 'bg-amber-500', text: 'text-amber-400' },
  critical: { chip: 'bg-red-500/10 text-red-400', dot: 'bg-red-500', text: 'text-red-400' },
  neutral: { chip: 'bg-raised text-muted', dot: 'bg-muted', text: 'text-muted' },
};

export const SESSION_STATUS: Record<SessionStatus, { tone: Tone; icon: typeof Wifi }> = {
  created: { tone: 'neutral', icon: CircleDashed },
  connecting: { tone: 'progress', icon: Loader2 },
  qr: { tone: 'info', icon: QrCode },
  pairing: { tone: 'info', icon: QrCode },
  connected: { tone: 'good', icon: Wifi },
  disconnected: { tone: 'warning', icon: Unplug },
  logged_out: { tone: 'neutral', icon: LogOut },
  needs_attention: { tone: 'critical', icon: AlertTriangle },
};

export const MESSAGE_STATUS: Record<MessageStatus, { tone: Tone; icon: typeof Wifi }> = {
  queued: { tone: 'neutral', icon: Clock },
  sending: { tone: 'progress', icon: Loader2 },
  sent: { tone: 'neutral', icon: Check },
  delivered: { tone: 'good', icon: CheckCheck },
  read: { tone: 'info', icon: CheckCheck },
  failed: { tone: 'critical', icon: XCircle },
  received: { tone: 'info', icon: Inbox },
};

export function Badge({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center rounded-full px-2 py-1 text-xs font-medium whitespace-nowrap', TONES[tone].chip, className)}>{children}</span>;
}

export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  const { t } = useI18n();
  return (
    <Badge tone={SESSION_STATUS[status].tone} className={status === 'connecting' ? 'animate-pulse' : undefined}>
      {t.status.session[status].label}
    </Badge>
  );
}

export function MessageStatusBadge({ status }: { status: MessageStatus }) {
  const { t } = useI18n();
  return <Badge tone={MESSAGE_STATUS[status].tone}>{t.status.message[status]}</Badge>;
}

/** Round tinted icon used in activity feeds. */
export function StatusIcon({ tone, icon: Icon, spin }: { tone: Tone; icon: typeof Wifi; spin?: boolean }) {
  return (
    <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-full', TONES[tone].chip)}>
      <Icon className={cx('size-4', spin && 'animate-spin')} />
    </span>
  );
}

export function Phone({ value }: { value: string | null }) {
  return value ? <span className="ltr font-mono text-sm">{value}</span> : <span className="text-faint">—</span>;
}

/** Plan display name: the trial is translated, paid plans keep their product names. */
export function usePlanName() {
  const { t } = useI18n();
  return (plan: { id: string; name: string }) => (plan.id === 'trial' ? t.plans.trialName : plan.id === 'unlimited' ? t.common.unlimited : plan.name);
}

// --- data states ---------------------------------------------------------------------------------

/**
 * A failed load, with a way out: the reason and a retry button. Used instead of leaving a spinner
 * up when a request fails (reads also retry by themselves when the failure is temporary).
 */
export function LoadError({ error, onRetry, retrying, className }: { error: unknown; onRetry: () => void; retrying?: boolean; className?: string }) {
  const { t } = useI18n();
  return (
    <div role="alert" className={cx('animate-fade-up flex flex-wrap items-center gap-3 rounded-lg border border-destructive-ink/30 bg-destructive/15 px-4 py-3 text-sm text-red-200', className)}>
      <AlertTriangle className="size-4 shrink-0 text-destructive-ink" />
      <span className="min-w-0 flex-1">
        {t.errors.loadFailed} {errorMessage(error)}
      </span>
      <Button variant="outline" size="sm" loading={retrying} onClick={onRetry} icon={<RotateCw className="size-4" />}>
        {t.common.retry}
      </Button>
    </div>
  );
}

/** Previous/next paging with "21–40 of 132". */
export function Pagination({ page, pageSize, total, onPage, busy }: { page: number; pageSize: number; total: number; onPage: (page: number) => void; busy?: boolean }) {
  const { t } = useI18n();
  if (total <= pageSize && page === 1) return null;
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between gap-3 pt-4 text-sm text-muted">
      <span className="tabular-nums">{t.admin.users.range(from, to, total)}</span>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}>
          {t.admin.users.prev}
        </Button>
        <Button variant="outline" size="sm" disabled={busy || to >= total} onClick={() => onPage(page + 1)}>
          {t.admin.users.next}
        </Button>
      </div>
    </div>
  );
}
