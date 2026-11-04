import { phoneHref } from '@wa/shared/site';
import { ArrowRight, BookOpen, ChevronDown, Code2, Globe, Layers, LayoutGrid, Mail, MapPin, Menu, Phone, Tags, X } from '../icons';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { sessionHint } from '../api';
import { BRAND } from '../brand';
import { CurrencySwitch } from '../currency';
import { useI18n } from '../i18n';
import { Link, usePath } from '../router';
import { buttonClass, cx, flip, LangSwitch, Logo, Reveal, ThemeSwitch } from '../ui';
import { FOOTER_HREFS, NAV_HREFS } from './content';
import { useSiteSettings } from './settings';
import './editorial.css';

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

/** Section title block: a pill label, a two-tone headline (the second half in grey, as Whop writes them), and a lead. */
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
    <Reveal className={cx('studio-section-title', center ? 'mx-auto max-w-3xl text-center' : 'max-w-2xl', className)}>
      <p className="kicker" data-center={center || undefined}>
        {kicker}
      </p>
      <h2 className="mt-5 text-3xl leading-[1.15] font-semibold tracking-[-0.03em] text-balance sm:text-4xl lg:text-[2.75rem]">
        {title} {accent && <span className={cx('text-brand', breakAccent && 'sm:block')}>{accent}</span>}
      </h2>
      {text && <p className={cx('mt-4 text-base leading-relaxed text-muted sm:text-lg', center && 'mx-auto max-w-2xl')}>{text}</p>}
    </Reveal>
  );
}

/** Landing-page sections are `#id`; from any other page they lead back to `/#id`. */
function useSiteHref() {
  const home = usePath() === '/';
  return (href: string) => (href.startsWith('#') && !home ? `/${href}` : href);
}

const navIcons = [LayoutGrid, Layers, Code2, Tags, BookOpen];

function SitePreferences() {
  const { lang, t } = useI18n();
  const details = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      if (details.current?.open && !details.current.contains(event.target as Node)) details.current.open = false;
    };
    const desktop = window.matchMedia('(min-width: 72rem)');
    const dismiss = () => { if (details.current) details.current.open = false; };
    document.addEventListener('pointerdown', dismissOutside);
    desktop.addEventListener('change', dismiss);
    return () => {
      document.removeEventListener('pointerdown', dismissOutside);
      desktop.removeEventListener('change', dismiss);
    };
  }, []);

  return (
    <details ref={details} className="mast-settings mast-desktop"
      onBlur={(e) => {
        if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false;
      }}
      onKeyDownCapture={(e) => {
        if (e.key !== 'Escape' || !e.currentTarget.open) return;
        const picker = e.currentTarget.querySelector<HTMLButtonElement>('[aria-haspopup="menu"][aria-expanded="true"]');
        if (picker) picker.focus();
        else {
          e.currentTarget.open = false;
          e.currentTarget.querySelector('summary')?.focus();
        }
      }}>
      <summary aria-label={t.landing.preferences} title={t.landing.preferences}>
        <Globe aria-hidden className="size-4" /><bdi>{lang.toUpperCase()}</bdi><ChevronDown aria-hidden className="size-3" />
      </summary>
      <div className="mast-settings-panel">
        <strong>{t.landing.preferences}</strong>
        <div><span>{t.landing.language}</span><LangSwitch /></div>
        <div><span>{t.currency.label}</span><CurrencySwitch /></div>
        <div><span>{t.theme.aria}</span><ThemeSwitch /></div>
      </div>
    </details>
  );
}

export function SiteHeader() {
  const { t } = useI18n();
  const l = t.landing;
  const path = usePath();
  const [open, setOpen] = useState(false);
  const [section, setSection] = useState('');
  const header = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const signedIn = sessionHint.get();

  useEffect(() => {
    if (path !== '/') return;
    const sections = NAV_HREFS.filter((href) => href.startsWith('#')).map((href) => document.getElementById(href.slice(1)));
    const update = () => {
      const marker = (header.current?.offsetHeight ?? 68) + 20;
      const current = sections.find((el) => {
        const box = el?.getBoundingClientRect();
        return box && box.top <= marker && box.bottom > marker;
      });
      setSection(current ? '#' + current.id : '');
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [path]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const picker = header.current?.querySelector<HTMLButtonElement>('#site-menu [aria-haspopup="menu"][aria-expanded="true"]');
      if (picker) {
        picker.focus();
        return;
      }
      setOpen(false);
      toggle.current?.focus();
    };
    const onOutside = (event: PointerEvent) => {
      if (!header.current?.contains(event.target as Node)) setOpen(false);
    };
    const wide = window.matchMedia('(min-width: 72rem)');
    const onWide = () => { if (wide.matches) setOpen(false); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onOutside);
    wide.addEventListener('change', onWide);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onOutside);
      wide.removeEventListener('change', onWide);
    };
  }, [open]);

  const close = () => setOpen(false);
  const links = l.nav.map((label, i) => {
    const target = NAV_HREFS[i]!;
    const local = target.startsWith('#');
    const Icon = navIcons[i]!;
    const current = local ? path === '/' && section === target : path === target;
    return (
      <Link key={target} href={local && path !== '/' ? '/' + target : target} onClick={close}
        aria-current={current ? (local ? 'location' : 'page') : undefined} className="mast-link">
        <Icon aria-hidden className="mast-link-icon size-4" />
        {label}
        <Arrow className="mast-link-arrow" />
      </Link>
    );
  });

  return (
    <header ref={header} className="public-mast">
      <a href="#main" className="mast-skip sr-only focus:not-sr-only">{l.skip}</a>
      <div className="mast-inner">
        <Link href="/" aria-label={BRAND.name} className="mast-brand" onClick={close}><Logo /></Link>
        <nav aria-label={t.common.menu} className="mast-links mast-desktop">{links}</nav>
        <div className="mast-actions">
          <SitePreferences />
          {!signedIn && <Link href="/login" className="mast-login mast-desktop">{l.login}</Link>}
          <Link href={signedIn ? '/dashboard' : '/register'} onClick={close} className={buttonClass('brand', 'md', 'mast-entry')}>
            {signedIn ? l.dashboard : l.getStarted}<Arrow />
          </Link>
          <button ref={toggle} type="button" className="mast-toggle" aria-controls="site-menu"
            aria-label={open ? t.app.closeMenu : t.common.menu} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </div>
      <div id="site-menu" hidden={!open} className="mast-menu">
        <div className="mast-preferences">
          <CurrencySwitch align="start" /><LangSwitch /><ThemeSwitch className="ms-auto" />
        </div>
        <nav aria-label={t.common.menu} className="mast-links">{links}</nav>
        {!signedIn && <Link href="/login" className="mast-menu-login" onClick={close}>{l.login}<Arrow /></Link>}
      </div>
    </header>
  );
}

const socialClass =
  'inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-card px-3 text-sm font-medium text-ink-2 transition-colors hover:border-line-strong hover:text-ink';

/** The company's address in Egypt and phone number (the Central Bank's rules for online payments ask for both). */
export function ContactDetails({ className, withEmail }: { className?: string; withEmail?: boolean }) {
  const { t } = useI18n();
  const f = t.landing.footer;
  const site = useSiteSettings();
  if (!site.localAddress && !site.phone && !withEmail) return null;
  return (
    <ul className={cx('space-y-2.5 text-sm', className)}>
      {site.localAddress && (
        <li className="flex items-start gap-2.5 text-ink-2">
          <MapPin className="mt-0.5 size-4 shrink-0 text-muted" aria-label={f.address} />
          <address className="not-italic">{site.localAddress}</address>
        </li>
      )}
      {site.phone && (
        <li className="flex items-center gap-2.5">
          <Phone className="size-4 shrink-0 text-muted" aria-label={f.phone} />
          <a href={phoneHref(site.phone)} className="ltr font-medium text-ink-2 transition-colors hover:text-ink">
            {site.phone}
          </a>
        </li>
      )}
      {withEmail && (
        <li className="flex items-center gap-2.5">
          <Mail className="size-4 shrink-0 text-muted" aria-label={f.email} />
          <a href={`mailto:${BRAND.supportEmail}`} className="ltr font-medium break-all text-ink-2 transition-colors hover:text-ink">
            {BRAND.supportEmail}
          </a>
        </li>
      )}
    </ul>
  );
}

export function SiteFooter() {
  const { t } = useI18n();
  const f = t.landing.footer;
  const site = useSiteSettings();
  const siteHref = useSiteHref();

  return (
    <footer className="studio-footer border-t border-line">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 py-16 sm:px-6 lg:grid-cols-[1.5fr_3fr] lg:px-8">
        <div className="max-w-sm">
          <Link href="/" aria-label={BRAND.name}>
            <Logo />
          </Link>
          <p className="mt-4 text-sm leading-relaxed text-muted">{t.brand.about}</p>
          <ContactDetails className="mt-5" />
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
