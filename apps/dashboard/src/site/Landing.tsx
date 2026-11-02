import { ArrowUpRight, BookOpen, Building2, Check, ChevronRight, Mail, Play, Plus, ShieldCheck } from '../icons';
import { useEffect } from 'react';
import { BRAND } from '../brand';
import { useI18n } from '../i18n';
import { Link, scrollToHash } from '../router';
import { buttonClass, cx, delay, flip, Reveal } from '../ui';
import { CodeTabs } from './CodeTabs';
import { LANGUAGES, SECURITY_BADGES, SECURITY_ICONS, SOLUTION_ICONS, STEP_ICONS } from './content';
import { DemoVideo, playDemo } from './DemoVideo';
import { Platform } from './Platform';
import { PlanCards } from './Pricing';
import { ProductShot } from './ProductShot';
import { Arrow, SectionHeading, SiteFooter, SiteHeader } from './SiteChrome';

/** A small brand check, for the short lists on the page. */
function Tick({ className }: { className?: string }) {
  return (
    <span className={cx('flex size-5 shrink-0 items-center justify-center rounded-full bg-brand/12 text-brand', className)}>
      <Check className="size-3" strokeWidth={3} />
    </span>
  );
}

function Hero() {
  const { t } = useI18n();
  const h = t.landing.hero;
  return (
    <section className="relative isolate overflow-hidden pt-14 sm:pt-20 lg:pt-24">
      <div aria-hidden className="hero-aura absolute inset-x-0 top-0 -z-10 h-[680px]" />

      <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
        <Link
          href="#pricing"
          className="animate-fade-up group inline-flex h-8 max-w-full items-center gap-2.5 rounded-full border border-line bg-card ps-1 pe-3 text-sm text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
        >
          <span className="shrink-0 rounded-full bg-brand/15 px-2.5 py-0.5 text-xs font-semibold text-brand">{h.announceTag}</span>
          <span className="truncate">{h.announce}</span>
          <ChevronRight className={cx('size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5', flip)} />
        </Link>

        <h1
          className="animate-fade-up mx-auto mt-8 max-w-5xl text-[2.5rem] leading-[1.06] font-semibold tracking-[-0.045em] text-balance sm:text-6xl lg:text-[4.5rem] rtl:leading-[1.28]"
          style={delay(80)}
        >
          {h.title}
          <span className="block pb-1 text-brand">{h.accent}</span>
        </h1>

        <p className="animate-fade-up mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted sm:text-xl" style={delay(160)}>
          {h.text}
        </p>

        <div className="animate-fade-up mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center" style={delay(220)}>
          <Link href="/register" className={buttonClass('white', 'lg', 'h-12 px-7 font-semibold')}>
            {h.cta} <Arrow />
          </Link>
          <button type="button" onClick={playDemo} className={buttonClass('outline', 'lg', 'h-12 px-6')}>
            <span className="flex size-6 items-center justify-center rounded-full bg-ink/[0.08]">
              <Play className="size-3 translate-x-px" />
            </span>
            {h.watch}
          </button>
        </div>

        <ul className="animate-fade-up mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted" style={delay(280)}>
          {h.trust.map((item) => (
            <li key={item} className="flex items-center gap-2">
              <Check className="size-4 text-brand" strokeWidth={2.5} />
              {item}
            </li>
          ))}
        </ul>

        {/* The most asked-for use: WhatsApp verification codes, with a way into the guide. */}
        <Link
          href="/guide"
          className="animate-fade-up group mx-auto mt-8 flex w-fit max-w-2xl items-center gap-3 rounded-xl border border-line bg-card py-2 ps-2 pe-4 text-start text-sm leading-relaxed text-ink-2 transition-colors hover:border-line-strong"
          style={delay(340)}
        >
          <span className="site-icon size-8 text-brand">
            <ShieldCheck className="size-4" />
          </span>
          <span>
            <span className="font-semibold text-ink">{h.otpTitle}</span> <span className="text-muted">{h.otpText}</span>
          </span>
          <span className="hidden shrink-0 items-center gap-1 font-semibold whitespace-nowrap text-ink sm:inline-flex">
            {h.otpCta} <Arrow className="size-3.5" />
          </span>
        </Link>
      </div>

      <div className="animate-fade-up relative mx-auto mt-14 max-w-6xl px-4 sm:mt-16 sm:px-6 lg:px-8" style={delay(420)}>
        <ProductShot />
      </div>
    </section>
  );
}

function TrustStrip() {
  const { t } = useI18n();
  return (
    <section className="py-16 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="overflow-hidden rounded-2xl border border-line bg-card">
          {/* Every cell draws its end and bottom edge; the grid reaches 1px past the box so the outer ones are clipped. */}
          <dl className="-me-px -mb-px grid grid-cols-2 lg:grid-cols-4 [&>div]:border-e [&>div]:border-b [&>div]:border-line">
            {t.landing.stats.map((s) => (
              <div key={s.label} className="flex flex-col-reverse gap-1.5 px-5 py-6 sm:px-7 sm:py-8">
                <dt className="text-sm text-muted">{s.label}</dt>
                <dd className="ltr text-start text-3xl font-semibold tracking-[-0.03em] tabular-nums sm:text-4xl rtl:text-end">{s.value}</dd>
              </div>
            ))}
          </dl>
        </Reveal>

        <p className="mt-14 text-center text-sm text-faint">{t.landing.integrations}</p>
        <div className="marquee mt-5" dir="ltr">
          <div className="marquee-track">
            {[...LANGUAGES, ...LANGUAGES].map((name, i) => (
              <span
                key={i}
                aria-hidden={i >= LANGUAGES.length || undefined}
                className="me-2.5 shrink-0 rounded-lg border border-line bg-card px-3.5 py-1.5 font-mono text-[13px] font-medium whitespace-nowrap text-muted"
              >
                {name}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const { t } = useI18n();
  const s = t.landing.how;
  return (
    <section id="how" className="band scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading kicker={s.kicker} title={s.title} accent={s.accent} text={s.text} />
        <ol className="mt-14 grid gap-4 md:grid-cols-3 lg:gap-5">
          {s.steps.map((step, i) => {
            const Icon = STEP_ICONS[i]!;
            return (
              <li key={step.title}>
                <Reveal delay={i * 100} className="site-card h-full rounded-2xl p-6 sm:p-7">
                  <div className="flex items-center justify-between">
                    <span className="site-icon size-10">
                      <Icon className={cx('size-5', i === 2 && flip)} />
                    </span>
                    <span className="ltr font-mono text-sm text-faint">0{i + 1}</span>
                  </div>
                  <h3 className="mt-6 text-lg font-semibold">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{step.text}</p>
                </Reveal>
              </li>
            );
          })}
        </ol>
        <Reveal className="mt-12 flex justify-center">
          <Link href="/register" className={buttonClass('white', 'lg', 'h-12 px-7 font-semibold')}>
            {s.cta} <Arrow />
          </Link>
        </Reveal>
      </div>
    </section>
  );
}

function Developers() {
  const { t } = useI18n();
  const s = t.landing.developers;
  return (
    <section id="developers" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto grid max-w-7xl grid-cols-1 items-center gap-12 px-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:gap-16 lg:px-8">
        <div>
          <SectionHeading align="start" kicker={s.kicker} title={s.title} accent={s.accent} text={s.text} />
          <ul className="mt-8 space-y-3.5">
            {s.points.map((point, i) => (
              <li key={point}>
                <Reveal delay={i * 60} className="flex items-start gap-3 text-[15px] text-ink-2">
                  <Tick className="mt-0.5" />
                  {point}
                </Reveal>
              </li>
            ))}
          </ul>
          <Reveal className="mt-9 flex flex-wrap gap-3">
            <Link href="/guide" className={buttonClass('white', 'lg', 'font-semibold')}>
              {s.guide} <Arrow />
            </Link>
            <a href="/docs" target="_blank" rel="noreferrer" className={buttonClass('outline', 'lg')}>
              <BookOpen className="size-4.5 text-muted" />
              {s.reference}
              <ArrowUpRight className={cx('size-4 text-muted', flip)} />
            </a>
          </Reveal>
        </div>
        <Reveal delay={120} className="min-w-0">
          <CodeTabs />
        </Reveal>
      </div>
    </section>
  );
}

function Solutions() {
  const { t } = useI18n();
  const s = t.landing.solutions;
  return (
    <section id="solutions" className="band scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading kicker={s.kicker} title={s.title} accent={s.accent} text={s.text} />
        <Reveal className="mt-14 overflow-hidden rounded-2xl border border-line bg-card">
          {/* Every cell draws its end and bottom edge; the grid reaches 1px past the box so the outer ones are clipped. */}
          <ul className="-me-px -mb-px grid sm:grid-cols-2 lg:grid-cols-3 [&>li]:border-e [&>li]:border-b [&>li]:border-line">
            {s.items.map((item, i) => {
              const Icon = SOLUTION_ICONS[i]!;
              return (
                <li key={item.title} className="group p-7 transition-colors hover:bg-ink/[0.025] sm:p-8">
                  <span className="site-icon size-10 transition-colors group-hover:text-brand">
                    <Icon className="size-5" />
                  </span>
                  <h3 className="mt-5 text-lg font-semibold">{item.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-muted">{item.text}</p>
                </li>
              );
            })}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}

function Security() {
  const { t } = useI18n();
  const s = t.landing.security;
  return (
    <section id="security" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-12 px-4 sm:px-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.5fr)] lg:gap-16 lg:px-8">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <SectionHeading align="start" kicker={s.kicker} title={s.title} accent={s.accent} text={s.text} />
          <Reveal>
            <ul className="mt-8 flex flex-wrap gap-2">
              {SECURITY_BADGES.map((badge) => (
                <li key={badge} className="ltr rounded-md border border-line bg-card px-2.5 py-1 font-mono text-[11px] font-medium text-muted">
                  {badge}
                </li>
              ))}
            </ul>
            <Link href="/privacy" className="group mt-8 inline-flex items-center gap-1.5 text-sm font-semibold text-ink transition-colors hover:text-brand">
              {s.privacy} <Arrow />
            </Link>
          </Reveal>
        </div>
        <ul className="grid gap-4 sm:grid-cols-2">
          {s.items.map((item, i) => {
            const Icon = SECURITY_ICONS[i]!;
            return (
              <li key={item.title}>
                <Reveal delay={(i % 2) * 80} className="h-full">
                  <div className="site-card h-full rounded-2xl p-6">
                    <span className="site-icon size-10">
                      <Icon className="size-5" />
                    </span>
                    <h3 className="mt-5 font-semibold">{item.title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted">{item.text}</p>
                  </div>
                </Reveal>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function PricingSection() {
  const { t } = useI18n();
  const s = t.landing.pricing;
  return (
    <section id="pricing" className="band scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading kicker={s.kicker} title={s.title} accent={s.accent} text={s.text} />
        <div className="mt-14">
          <PlanCards />
        </div>
        <Reveal className="mt-6">
          <div className="site-card flex flex-col gap-5 rounded-2xl p-6 sm:flex-row sm:items-center sm:justify-between sm:p-7">
            <div className="flex items-center gap-4">
              <span className="site-icon size-11">
                <Building2 className="size-5" />
              </span>
              <div>
                <h3 className="text-lg font-semibold">{s.higherTitle}</h3>
                <p className="mt-0.5 text-sm text-muted">{s.higherText}</p>
              </div>
            </div>
            <a href={`mailto:${BRAND.supportEmail}`} className={buttonClass('outline', 'lg')}>
              {s.higherCta} <Arrow />
            </a>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Faq() {
  const { t } = useI18n();
  const s = t.landing.faq;
  return (
    <section id="faq" className="scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto grid max-w-7xl grid-cols-1 gap-12 px-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] lg:gap-16 lg:px-8">
        <div className="lg:sticky lg:top-24 lg:self-start">
          <SectionHeading align="start" kicker={s.kicker} title={s.title} accent={s.accent} text={s.text} />
          <Reveal className="site-card mt-8 rounded-2xl p-6">
            <p className="font-semibold">{s.contactTitle}</p>
            <p className="mt-1 text-sm text-muted">{s.contactText}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <a href={`mailto:${BRAND.supportEmail}`} className={buttonClass('white', 'md')}>
                <Mail className="size-4" />
                {s.contactCta}
              </a>
              <Link href="/guide" className={buttonClass('outline', 'md')}>
                {s.docsCta}
              </Link>
            </div>
          </Reveal>
        </div>
        <Reveal>
          <div className="overflow-hidden rounded-2xl border border-line bg-card">
            <div className="divide-y divide-line">
              {s.items.map((item) => (
                <details key={item.q} className="group">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-6 px-5 py-4.5 text-start text-[15px] font-semibold transition-colors hover:bg-ink/[0.025] sm:px-6 sm:text-base [&::-webkit-details-marker]:hidden">
                    <span>{item.q}</span>
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-line text-muted transition-colors group-open:border-line-strong group-open:text-ink">
                      <Plus className="faq-icon size-3.5 transition-transform duration-300" />
                    </span>
                  </summary>
                  <p className="animate-fade-in ps-5 pe-14 pb-5 text-[15px] leading-relaxed text-muted sm:ps-6 sm:pe-16">{item.a}</p>
                </details>
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function FinalCta() {
  const { t } = useI18n();
  const s = t.landing.finalCta;
  return (
    <section className="px-4 pb-20 sm:px-6 sm:pb-28 lg:px-8">
      <Reveal className="mx-auto max-w-7xl">
        <div className="site-card relative isolate overflow-hidden rounded-3xl px-6 py-16 text-center sm:px-12 sm:py-20">
          <div aria-hidden className="hero-aura absolute inset-0 -z-10" />
          <h2 className="mx-auto max-w-2xl text-3xl leading-tight font-semibold tracking-[-0.03em] text-balance sm:text-5xl">{s.title}</h2>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-muted">{s.text}</p>
          <div className="mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
            <Link href="/register" className={buttonClass('white', 'lg', 'h-12 px-7 font-semibold')}>
              {s.cta} <Arrow />
            </Link>
            <a href={`mailto:${BRAND.supportEmail}`} className={buttonClass('outline', 'lg', 'h-12 px-6')}>
              {s.contact}
            </a>
          </div>
          <p className="mt-5 text-sm text-faint">{s.note}</p>
        </div>
      </Reveal>
    </section>
  );
}

export function Landing() {
  // Opened at /#pricing, or sent here from another page: go to that section once it has rendered.
  useEffect(() => {
    if (location.hash.length > 1) scrollToHash(location.hash.slice(1));
  }, []);

  return (
    <div className="overflow-x-clip">
      <SiteHeader />
      <main id="main">
        <Hero />
        <TrustStrip />
        <DemoVideo />
        <Platform />
        <HowItWorks />
        <Developers />
        <Solutions />
        <Security />
        <PricingSection />
        <Faq />
        <FinalCta />
      </main>
      <SiteFooter />
    </div>
  );
}
