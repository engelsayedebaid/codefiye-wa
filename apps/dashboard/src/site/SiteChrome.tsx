import { ArrowRight, Mail, Menu, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { sessionHint } from '../api';
import { BRAND } from '../brand';
import { useI18n } from '../i18n';
import { Link, usePath } from '../router';
import { buttonClass, cx, flip, LangSwitch, Logo, Reveal, ThemeSwitch } from '../ui';
import { FOOTER_HREFS, NAV_HREFS } from './content';
import { useSiteSettings } from './settings';

/** "Forward" arrow: right in LTR, left in RTL, nudging forward on hover. */
export function Arrow({ className }: { className?: string }) {
  return <ArrowRight className={cx('size-4 transition-transform duration-300 group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5', flip, className)} />;
}

/** The YouTube mark (Lucide ships no brand icons). */
export function YoutubeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={cx('size-4 shrink-0', className)}>
      <path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31.4 31.4 0 0 0 0 12a31.4 31.4 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31.4 31.4 0 0 0 24 12a31.4 31.4 0 0 0-.5-5.8ZM9.6 15.6V8.4l6.3 3.6-6.3 3.6Z" />
    </svg>
  );
}

/** Section title block: a kicker, a headline whose second half is in the brand gradient, and a lead. */
export function SectionHeading({
  kicker,
  title,
  accent,
  text,
  align = 'center',
  breakAccent,
  className,
}: {
  kicker: ReactNode;
  title: ReactNode;
  accent?: ReactNode;
  text?: ReactNode;
  align?: 'center' | 'start';
  /** Long titles: the accent gets its own line (from small screens up). */
  breakAccent?: boolean;
  className?: string;
}) {
  const center = align === 'center';
  return (
    <Reveal className={cx(center ? 'mx-auto max-w-3xl text-center' : 'max-w-2xl', className)}>
      <p className="kicker" data-center={center || undefined}>
        {kicker}
      </p>
      <h2 className="mt-4 text-3xl leading-[1.18] font-semibold tracking-tight text-balance sm:text-4xl lg:text-5xl">
        {title} {accent && <span className={cx('text-brand-gradient', breakAccent && 'sm:block')}>{accent}</span>}
      </h2>
      {text && <p className={cx('mt-5 text-lg leading-relaxed text-muted', center && 'mx-auto max-w-2xl')}>{text}</p>}
    </Reveal>
  );
}

/** Landing-page sections are `#id`; from any other page they lead back to `/#id`. */
function useSiteHref() {
  const home = usePath() === '/';
  return (href: string) => (href.startsWith('#') && !home ? `/${href}` : href);
}

export function SiteHeader() {
  const { t } = useI18n();
  const l = t.landing;
  const siteHref = useSiteHref();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  // A UI hint only: the session itself is an HttpOnly cookie the page can't read.
  const signedIn = sessionHint.get();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onWide = () => window.innerWidth >= 1024 && setOpen(false);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onWide);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onWide);
    };
  }, [open]);

  const close = () => setOpen(false);

  return (
    <header data-scrolled={scrolled || open || undefined} className="site-header sticky top-0 z-50">
      <a
        href="#main"
        className="sr-only rounded-md bg-card px-3 py-2 text-sm font-medium shadow-lg focus:not-sr-only focus:absolute focus:start-4 focus:top-3 focus:z-50"
      >
        {l.skip}
      </a>
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
        <Link href="/" aria-label={BRAND.name} className="shrink-0">
          <Logo />
        </Link>

        <nav aria-label={t.common.menu} className="ms-4 hidden items-center lg:flex xl:ms-8">
          {l.nav.map((label, i) => (
            <Link
              key={label}
              href={siteHref(NAV_HREFS[i]!)}
              className="rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap text-ink-2 transition-colors hover:bg-raised/60 hover:text-ink"
            >
              {label}
            </Link>
          ))}
        </nav>

        <div className="ms-auto hidden items-center gap-1 lg:flex">
          <ThemeSwitch />
          <LangSwitch />
          <span aria-hidden className="mx-1.5 h-5 w-px bg-line" />
          {signedIn ? (
            <Link href="/dashboard" className={buttonClass('brand', 'md', 'rounded-lg px-4')}>
              {l.dashboard} <Arrow />
            </Link>
          ) : (
            <>
              <Link href="/login" className={buttonClass('ghost', 'md', 'rounded-lg')}>
                {l.login}
              </Link>
              <Link href="/register" className={buttonClass('brand', 'md', 'rounded-lg px-4')}>
                {l.getStarted} <Arrow />
              </Link>
            </>
          )}
        </div>

        <button
          type="button"
          className="ms-auto rounded-md p-2 text-ink-2 transition-colors hover:bg-raised lg:hidden"
          onClick={() => setOpen((o) => !o)}
          aria-label={t.common.menu}
          aria-expanded={open}
          aria-controls="site-menu"
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
      </div>

      {open && (
        <div id="site-menu" className="animate-fade-in border-t border-line lg:hidden">
          <nav aria-label={t.common.menu} className="mx-auto flex max-w-7xl flex-col px-4 py-2 sm:px-6">
            {l.nav.map((label, i) => (
              <Link key={label} href={siteHref(NAV_HREFS[i]!)} onClick={close} className="border-b border-line/60 py-3.5 text-base font-medium text-ink-2 hover:text-ink">
                {label}
              </Link>
            ))}
          </nav>
          <div className="mx-auto grid max-w-7xl grid-cols-2 gap-3 px-4 py-4 sm:px-6">
            <Link href={signedIn ? '/dashboard' : '/login'} onClick={close} className={buttonClass('outline', 'lg', 'rounded-lg')}>
              {signedIn ? l.dashboard : l.login}
            </Link>
            <Link href="/register" onClick={close} className={buttonClass('brand', 'lg', 'rounded-lg')}>
              {l.getStarted}
            </Link>
          </div>
          {/* Theme last: its popup opens toward the start from the button's end edge. */}
          <div className="mx-auto flex max-w-7xl items-center justify-between border-t border-line px-4 py-3 sm:px-6">
            <LangSwitch />
            <ThemeSwitch />
          </div>
        </div>
      )}
    </header>
  );
}

const socialClass =
  'inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-card px-3 text-sm font-medium text-ink-2 transition-colors hover:border-line-strong hover:text-ink';

export function SiteFooter() {
  const { t } = useI18n();
  const f = t.landing.footer;
  const site = useSiteSettings();
  const siteHref = useSiteHref();

  return (
    <footer className="border-t border-line bg-surface/40">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.5fr_3fr] lg:px-8">
        <div className="max-w-sm">
          <Link href="/" aria-label={BRAND.name}>
            <Logo />
          </Link>
          <p className="mt-4 text-sm leading-relaxed text-muted">{t.brand.about}</p>
          <div className="mt-6 flex flex-wrap items-center gap-2">
            {site.youtubeChannelUrl && (
              <a href={site.youtubeChannelUrl} target="_blank" rel="noreferrer" className={socialClass}>
                <YoutubeIcon className="size-4.5 text-[#ff0033]" />
                {f.youtube}
              </a>
            )}
            <a href={`mailto:${BRAND.supportEmail}`} aria-label={f.email} title={f.email} className={cx(socialClass, 'w-9 justify-center px-0')}>
              <Mail className="size-4" />
            </a>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-10 sm:grid-cols-4">
          {f.columns.map((col, c) => (
            <div key={col.title}>
              <h3 className="text-sm font-semibold text-ink">{col.title}</h3>
              <ul className="mt-4 space-y-3 text-sm">
                {col.links.map((label, i) => {
                  const href = FOOTER_HREFS[c]![i]!;
                  const linkClass = 'text-muted transition-colors hover:text-ink';
                  if (href === 'mailto:')
                    return (
                      <li key={label}>
                        <a href={`mailto:${BRAND.supportEmail}`} className={linkClass}>
                          {label}
                        </a>
                      </li>
                    );
                  return (
                    <li key={label}>
                      <Link href={siteHref(href)} className={linkClass} {...(href === '/docs' ? { target: '_blank', rel: 'noreferrer' } : {})}>
                        {label}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-line">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-6 text-xs leading-relaxed text-faint sm:px-6 md:flex-row md:items-center md:justify-between md:gap-8 lg:px-8">
          <p className="shrink-0">
            © {new Date().getFullYear()} <span className="ltr font-semibold text-ink-2">{BRAND.name}</span>. {f.rights}
          </p>
          <p className="max-w-2xl md:text-end">{t.brand.disclaimer}</p>
        </div>
      </div>
    </footer>
  );
}
