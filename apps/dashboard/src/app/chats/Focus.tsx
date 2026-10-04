import { Columns2, Focus, Maximize2, MessageSquareText, Minimize2, PanelLeft } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { cx, flip } from '../../ui';

/**
 * Focus mode of the chats page: `full` = the whole page over the dashboard chrome, `single` = the open
 * conversation alone (the list as a drawer), `split` = two conversations side by side (the open one,
 * and a second picked from a list in the other half). Purely a layout: the page's state (number, open chat, drafts) is untouched.
 */
export const FOCUS_MODES = ['full', 'single', 'split'] as const;
export type FocusMode = (typeof FOCUS_MODES)[number];

const ICONS = { full: Maximize2, single: MessageSquareText, split: Columns2 } satisfies Record<FocusMode, unknown>;

const MODE_KEY = 'wa.chats.focusMode';
/** How long the exit animation runs before the page goes back into the dashboard. */
const EXIT_MS = 160;
const MENU_WIDTH = 288;

function load(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: just not remembered
  }
}

/**
 * Focus state: the active mode (null = normal page), the mode last used (offered first next time),
 * and an `exiting` flag that lets the exit animation play before the layout switches back.
 */
export function useFocusMode() {
  const [mode, setMode] = useState<FocusMode | null>(null);
  const [exiting, setExiting] = useState(false);
  const [last, setLast] = useState<FocusMode>(() => {
    const stored = load(MODE_KEY);
    return FOCUS_MODES.includes(stored as FocusMode) ? (stored as FocusMode) : 'split';
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enter = useCallback((next: FocusMode) => {
    if (timer.current) clearTimeout(timer.current);
    setExiting(false);
    setMode(next);
    setLast(next);
    save(MODE_KEY, next);
  }, []);
  const exit = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setExiting(true);
    timer.current = setTimeout(() => {
      setMode(null);
      setExiting(false);
    }, EXIT_MS);
  }, []);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  // The dashboard page behind must not scroll while focus covers it.
  useEffect(() => {
    if (!mode) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [mode]);

  return { mode, last, exiting, enter, exit };
}

/** The Focus button of the chats header and its menu of the three layouts. */
export function FocusMenu({ last, onPick, renderButton }: { last: FocusMode; onPick: (mode: FocusMode) => void; renderButton: (props: { onClick: () => void; open: boolean; label: string }) => ReactNode }) {
  const { t } = useI18n();
  const f = t.chats.focus;
  const [open, setOpen] = useState(false);
  /** Where the menu shows: under the button, kept inside the window (fixed, so no panel clips it). */
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const toggle = () => {
    const rect = box.current?.getBoundingClientRect();
    if (rect) setAt({ top: rect.bottom + 6, left: Math.min(Math.max(8, rect.left + rect.width / 2 - MENU_WIDTH / 2), window.innerWidth - MENU_WIDTH - 8) });
    setOpen((o) => !o);
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <div ref={box} className="relative">
      {renderButton({ onClick: toggle, open, label: f.open })}
      {open && at && (
        <div
          role="menu"
          aria-label={f.title}
          className="animate-scale-in fixed z-[70] origin-top rounded-xl border border-line bg-card p-1.5 shadow-xl"
          style={{ top: at.top, left: at.left, width: MENU_WIDTH }}
        >
          <p className="flex items-center gap-1.5 px-2 pt-1 pb-1.5 text-[11px] font-semibold tracking-wide text-ink-3 uppercase">
            <Focus className="size-3.5" /> {f.title}
          </p>
          {FOCUS_MODES.map((mode) => {
            const Icon = ICONS[mode];
            return (
              <button
                key={mode}
                type="button"
                role="menuitem"
                onClick={() => {
                  setOpen(false);
                  onPick(mode);
                }}
                className={cx(
                  'flex w-full cursor-pointer items-start gap-3 rounded-lg px-2 py-2 text-start transition-colors hover:bg-raised',
                  mode === last && 'bg-raised/60',
                )}
              >
                <span className={cx('mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg border', mode === last ? 'border-brand/40 bg-brand/10 text-brand' : 'border-line bg-surface text-ink-2')}>
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{f.modes[mode].label}</span>
                  <span className="block text-xs leading-snug text-muted">{f.modes[mode].text}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The slim bar on top of focus mode: what it is, switch layout, show the list (single), and leave. */
export function FocusBar({ mode, title, onMode, onExit, onShowList }: { mode: FocusMode; title: string; onMode: (mode: FocusMode) => void; onExit: () => void; onShowList?: () => void }) {
  const { t } = useI18n();
  const f = t.chats.focus;
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-card/95 px-2 backdrop-blur sm:px-3">
      <span className="flex min-w-0 items-center gap-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-brand/10 text-brand">
          <Focus className="size-4" />
        </span>
        <span className="hidden min-w-0 sm:block">
          <span className="block text-[13px] leading-tight font-semibold">{f.title}</span>
          <span className="block truncate text-[11px] leading-tight text-muted">{title}</span>
        </span>
      </span>
      {onShowList && (
        <button
          type="button"
          onClick={onShowList}
          className="ms-1 flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-ink-2 transition-colors hover:bg-raised hover:text-ink"
        >
          <PanelLeft className={cx('size-4', flip)} />
          <span className="hidden md:inline">{f.showList}</span>
        </button>
      )}
      <div role="radiogroup" aria-label={f.title} className="mx-auto flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5">
        {FOCUS_MODES.map((m) => {
          const Icon = ICONS[m];
          const active = m === mode;
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={active}
              title={f.modes[m].text}
              onClick={() => onMode(m)}
              className={cx(
                'flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-[color,background-color] duration-200',
                active ? 'bg-card text-ink shadow-xs' : 'text-muted hover:text-ink',
              )}
            >
              <Icon className={cx('size-3.5', active && 'text-brand')} />
              <span className="hidden sm:inline">{f.modes[m].label}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onExit}
        title={f.exitHint}
        className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line bg-surface px-2 py-1.5 text-xs font-medium text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
      >
        <Minimize2 className="size-3.5" />
        <span className="hidden sm:inline">{f.exit}</span>
        <kbd className="ltr hidden rounded border border-line-strong bg-raised px-1 font-mono text-[10px] text-ink-3 md:inline">Esc</kbd>
      </button>
    </header>
  );
}
