import { ChevronDown } from 'lucide-react';
import { useEffect, useState } from 'react';
import { cx } from '../ui';

/** The id of the section being read: the last one whose top has passed under the sticky header. */
export function useActiveSection(ids: string[]) {
  const [active, setActive] = useState(ids[0] ?? '');
  const key = ids.join(' ');
  useEffect(() => {
    const sections = key
      .split(' ')
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = sections[0]!.id;
      for (const el of sections) if (el.getBoundingClientRect().top <= 140) current = el.id;
      // At the very bottom the last short sections never reach that line: the last one is being read.
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = sections[sections.length - 1]!.id;
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, [key]);
  return active;
}

export type TocItem = { id: string; label: string };
type TocProps = { title: string; items: TocItem[]; active: string; numbered?: boolean; className?: string };

function TocList({ items, active, numbered }: Omit<TocProps, 'title' | 'className'>) {
  return (
    <ol className="space-y-0.5 text-sm">
      {items.map((item, i) => (
        <li key={item.id}>
          <a
            href={`#${item.id}`}
            aria-current={item.id === active ? 'true' : undefined}
            className="flex gap-2 rounded-e-md border-s-2 border-transparent py-1.5 ps-3 pe-2 text-muted transition-colors hover:text-ink aria-[current=true]:border-brand aria-[current=true]:bg-brand/[0.07] aria-[current=true]:font-medium aria-[current=true]:text-ink"
          >
            {numbered && <span className="w-5 shrink-0 text-faint tabular-nums">{i + 1}.</span>}
            <span>{item.label}</span>
          </a>
        </li>
      ))}
    </ol>
  );
}

/** Contents in a sticky side column (wide screens only). */
export function TocAside({ title, className, ...list }: TocProps) {
  return (
    <aside className={cx('hidden lg:block', className)}>
      <nav aria-label={title} className="code-scroll sticky top-24 max-h-[calc(100svh-7rem)] overflow-y-auto pb-6">
        <p className="mb-3 ps-3.5 text-xs font-semibold text-faint">{title}</p>
        <TocList {...list} />
      </nav>
    </aside>
  );
}

/** The same contents folded into a box above the text (phones and tablets). */
export function TocFold({ title, className, ...list }: TocProps) {
  return (
    <details className={cx('group site-card rounded-xl lg:hidden', className)}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown className="size-4 text-muted transition-transform group-open:rotate-180" />
      </summary>
      <nav aria-label={title} className="border-t border-line p-2">
        <TocList {...list} />
      </nav>
    </details>
  );
}
