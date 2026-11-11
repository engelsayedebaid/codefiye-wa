import { phoneHref } from '@wa/shared/site';
import type { ReactNode } from 'react';
import {
  BadgeCheck,
  Building2,
  Clock,
  CodeXml,
  FileText,
  Globe,
  HeartHandshake,
  LockKeyhole,
  Mail,
  MapPin,
  MessageCircle,
  Phone,
  Receipt,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Wallet,
  Zap,
  type LucideIcon,
} from '../icons';
import { BRAND } from '../brand';
import { useI18n } from '../i18n';
import { Link } from '../router';
import { buttonClass, delay, Reveal } from '../ui';
import { PlanCards } from './Pricing';
import { Arrow, SiteCursor, SiteFooter, SiteHeader } from './SiteChrome';
import { useSiteSettings } from './settings';

/**
 * /about and /contact: who runs the service, what it sells at what price (in EGP), and how to reach
 * the business — the payment gateway's review asks for both pages, with email, phone and location.
 */

const POLICY_LINKS = [
  { href: '/privacy', key: 'privacy', icon: ShieldCheck },
  { href: '/refund', key: 'refund', icon: RotateCcw },
  { href: '/shipping', key: 'shipping', icon: Zap },
  { href: '/terms', key: 'terms', icon: FileText },
] as const;

/** A WhatsApp chat link for the site's phone number (international digits only). */
const whatsappHref = (phone: string) => {
  const digits = phone.replace(/\D/g, '');
  return `https://wa.me/${digits.startsWith('0') ? `20${digits.slice(1)}` : digits}`;
};

function CompanyPage({ eyebrow, title, lead, children }: { eyebrow: string; title: string; lead: string; children: ReactNode }) {
  return (
    <div className="studio-site studio-doc min-h-svh overflow-x-clip">
      <SiteCursor />
      <SiteHeader />
      <main id="main">
        <header className="studio-doc-cover relative isolate overflow-hidden border-b border-line">
          <div aria-hidden className="hero-aura absolute inset-0 -z-10" />
          <div aria-hidden className="site-grid absolute inset-0 -z-10" />
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
            <p className="kicker animate-fade-up">{eyebrow}</p>
            <h1 className="animate-fade-up mt-4 text-4xl font-semibold tracking-tight text-balance sm:text-5xl" style={delay(60)}>
              {title}
            </h1>
            <p className="animate-fade-up mt-5 max-w-2xl text-lg leading-relaxed text-muted" style={delay(120)}>
              {lead}
            </p>
          </div>
        </header>
        <div className="mx-auto max-w-7xl space-y-20 px-4 py-14 sm:px-6 sm:py-16 lg:px-8">{children}</div>
      </main>
      <SiteFooter />
    </div>
  );
}

function SectionTitle({ title, text }: { title: string; text?: string }) {
  return (
    <div className="max-w-2xl">
      <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
      {text && <p className="mt-3 leading-relaxed text-muted">{text}</p>}
    </div>
  );
}

function IconCard({ icon: Icon, title, text, i }: { icon: LucideIcon; title: string; text: string; i: number }) {
  return (
    <li className="site-card animate-fade-up rounded-2xl p-5" style={delay(120 + i * 60)}>
      <span className="flex size-10 items-center justify-center rounded-xl bg-brand/10 text-brand ring-1 ring-brand/20">
        <Icon className="size-5" />
      </span>
      <h3 className="mt-4 font-semibold">{title}</h3>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">{text}</p>
    </li>
  );
}

/** The policy pages, as cards with a short summary of each. */
function PolicyLinks({ title }: { title: string }) {
  const { t } = useI18n();
  const summaries = t.company.policySummaries;
  return (
    <Reveal>
      <nav aria-label={title}>
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h2>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {POLICY_LINKS.map((p) => {
            const Icon = p.icon;
            return (
              <li key={p.key}>
                <Link href={p.href} className="site-card group flex h-full flex-col rounded-2xl p-5 transition-colors hover:border-line-strong">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex size-10 items-center justify-center rounded-xl bg-brand/10 text-brand ring-1 ring-brand/20">
                      <Icon className="size-5" />
                    </span>
                    <Arrow className="text-muted group-hover:text-brand" />
                  </div>
                  <h3 className="mt-4 font-semibold group-hover:text-brand">{t.legal[p.key]}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{summaries[p.key]}</p>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </Reveal>
  );
}

/** Business name, location, currency — the facts a payment reviewer looks for, in one table. */
function BusinessFacts() {
  const { t } = useI18n();
  const c = t.company;
  const site = useSiteSettings();
  const rows: [string, ReactNode][] = [
    [c.facts.name, <span className="ltr font-semibold">{BRAND.name}</span>],
    [c.facts.activity, c.facts.activityValue],
    [c.facts.location, site.localAddress],
    [c.facts.email, <a href={`mailto:${BRAND.supportEmail}`} className="ltr font-medium text-brand hover:underline">{BRAND.supportEmail}</a>],
    [c.facts.phone, site.phone ? <a href={phoneHref(site.phone)} className="ltr font-medium text-brand hover:underline">{site.phone}</a> : null],
    [c.facts.currency, c.facts.currencyValue],
    [c.facts.delivery, c.facts.deliveryValue],
  ];
  return (
    <dl className="site-card divide-y divide-line overflow-hidden rounded-2xl">
      {rows
        .filter(([, value]) => value)
        .map(([label, value]) => (
          <div key={label} className="grid gap-1 px-5 py-4 sm:grid-cols-[220px_minmax(0,1fr)] sm:gap-6">
            <dt className="text-sm font-medium text-muted">{label}</dt>
            <dd className="text-ink-2">{value}</dd>
          </div>
        ))}
    </dl>
  );
}

export function AboutPage() {
  const { t } = useI18n();
  const a = t.about;
  const valueIcons = [Sparkles, LockKeyhole, Wallet, HeartHandshake];
  const offerIcons = [CodeXml, MessageCircle, BadgeCheck, Globe];
  return (
    <CompanyPage eyebrow={a.eyebrow} title={a.title} lead={a.lead}>
      <section className="grid gap-10 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:gap-16">
        <Reveal>
          <SectionTitle title={a.whoTitle} />
          <div className="mt-5 space-y-4 leading-relaxed text-ink-2">
            {a.who.map((p) => (
              <p key={p}>{p}</p>
            ))}
          </div>
        </Reveal>
        <Reveal>
          <SectionTitle title={a.factsTitle} />
          <div className="mt-5">
            <BusinessFacts />
          </div>
        </Reveal>
      </section>

      <section>
        <SectionTitle title={a.offerTitle} text={a.offerText} />
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {a.offer.map((o, i) => (
            <IconCard key={o.title} icon={offerIcons[i] ?? Sparkles} title={o.title} text={o.text} i={i} />
          ))}
        </ul>
      </section>

      <section id="pricing" className="scroll-mt-24">
        <SectionTitle title={a.pricingTitle} text={a.pricingText} />
        <div className="mt-8">
          <PlanCards />
        </div>
      </section>

      <section>
        <SectionTitle title={a.valuesTitle} />
        <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {a.values.map((v, i) => (
            <IconCard key={v.title} icon={valueIcons[i] ?? ShieldCheck} title={v.title} text={v.text} i={i} />
          ))}
        </ul>
      </section>

      <Reveal>
        <section className="site-card flex flex-col items-start gap-5 rounded-2xl p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
          <div>
            <h2 className="text-xl font-semibold sm:text-2xl">{a.ctaTitle}</h2>
            <p className="mt-2 text-muted">{a.ctaText}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/contact" className={buttonClass('brand', 'lg')}>
              {a.ctaContact}
            </Link>
            <Link href="/register" className={buttonClass('outline', 'lg')}>
              {a.ctaStart}
            </Link>
          </div>
        </section>
      </Reveal>

      <PolicyLinks title={t.company.policies} />
    </CompanyPage>
  );
}

export function ContactPage() {
  const { t } = useI18n();
  const c = t.contact;
  const a = t.about;
  const site = useSiteSettings();
  const cards: { icon: LucideIcon; label: string; value: string; href?: string; hint: string; ltr?: boolean; external?: boolean }[] = [
    { icon: Mail, label: c.email, value: BRAND.supportEmail, href: `mailto:${BRAND.supportEmail}`, hint: c.emailHint, ltr: true },
    ...(site.phone
      ? [
          { icon: Phone, label: c.phone, value: site.phone, href: phoneHref(site.phone), hint: c.phoneHint, ltr: true },
          { icon: MessageCircle, label: c.whatsapp, value: site.phone, href: whatsappHref(site.phone), hint: c.whatsappHint, ltr: true, external: true },
        ]
      : []),
    ...(site.localAddress ? [{ icon: MapPin, label: c.address, value: site.localAddress, hint: c.addressHint }] : []),
  ];
  return (
    <CompanyPage eyebrow={c.eyebrow} title={c.title} lead={c.lead}>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card, i) => {
          const Icon = card.icon;
          const value = <span className={card.ltr ? 'ltr break-all' : undefined}>{card.value}</span>;
          return (
            <li key={card.label} className="site-card animate-fade-up flex flex-col rounded-2xl p-5" style={delay(120 + i * 60)}>
              <span className="flex size-10 items-center justify-center rounded-xl bg-brand/10 text-brand ring-1 ring-brand/20">
                <Icon className="size-5" />
              </span>
              <h2 className="mt-4 text-sm font-medium text-muted">{card.label}</h2>
              {card.href ? (
                <a
                  href={card.href}
                  className="mt-1 text-lg font-semibold text-ink transition-colors hover:text-brand"
                  {...(card.external ? { target: '_blank', rel: 'noreferrer' } : {})}
                >
                  {value}
                </a>
              ) : (
                <address className="mt-1 text-lg font-semibold text-ink not-italic">{value}</address>
              )}
              <p className="mt-2 text-sm leading-relaxed text-muted">{card.hint}</p>
            </li>
          );
        })}
      </ul>

      <section className="grid gap-10 lg:grid-cols-2 lg:gap-16">
        <Reveal>
          <SectionTitle title={c.factsTitle} />
          <div className="mt-5">
            <BusinessFacts />
          </div>
          <div className="mt-4">
            <Link href="/about" className="inline-flex items-center gap-2 text-sm font-semibold text-brand hover:underline">
              {a.title} <Arrow />
            </Link>
          </div>
        </Reveal>
        <Reveal>
          <SectionTitle title={c.helpTitle} />
          <ul className="mt-5 space-y-3">
            {c.help.map((h, i) => {
              const Icon = [Receipt, Clock, Building2][i] ?? Mail;
              return (
                <li key={h.title} className="site-card flex gap-4 rounded-2xl p-5">
                  <Icon className="mt-0.5 size-5 shrink-0 text-brand" />
                  <div>
                    <h3 className="font-semibold">{h.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-muted">{h.text}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </Reveal>
      </section>

      <section id="pricing" className="scroll-mt-24">
        <SectionTitle title={a.pricingTitle} text={a.pricingText} />
        <div className="mt-8">
          <PlanCards />
        </div>
      </section>

      <PolicyLinks title={t.company.policies} />
    </CompanyPage>
  );
}
