import { ArrowUpRight, BookOpen, Building2, Check, ChevronRight, Mail, Play, Plus, ShieldCheck } from 'lucide-react';
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

function Hero() {
  const { t } = useI18n();
  const h = t.landing.hero;
  return (
    <section className="relative isolate overflow-hidden pt-14 sm:pt-20 lg:pt-24">
      <div aria-hidden className="hero-aura absolute inset-0 -z-10" />
      <div aria-hidden className="site-grid absolute inset-x-0 top-0 -z-10 h-[760px]" />

      <div className="mx-auto max-w-7xl px-4 text-center sm:px-6 lg:px-8">
        <Link
          href="#pricing"
          className="animate-fade-up group inline-flex max-w-full items-center gap-2.5 rounded-full border border-line bg-card/70 py-1 ps-1 pe-3 text-sm text-ink-2 shadow-xs backdrop-blur transition-colors hover:border-line-strong hover:text-ink"
        >
          <span className="shrink-0 rounded-full bg-brand px-2.5 py-0.5 text-xs font-semibold text-on-brand">{h.announceTag}</span>
          <span className="truncate">{h.announce}</span>
          <ChevronRight className={cx('size-4 shrink-0 text-muted transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5', flip)} />
        </Link>

        <h1 className="animate-fade-up mx-auto mt-7 max-w-5xl text-4xl leading-[1.14] font-semibold tracking-tight text-balance sm:text-6xl lg:text-[4.25rem]" style={delay(80)}>
          {h.title}
          <span className="text-brand-gradient block pb-1">{h.accent}</span>
        </h1>

        <p className="animate-fade-up mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-muted sm:text-xl" style={delay(160)}>
          {h.text}
        </p>

        {/* The most asked-for use: WhatsApp verification codes, with a way into the guide. */}
        <Link
          href="/guide"
          className="animate-fade-up group mx-auto mt-6 flex w-fit max-w-2xl items-center gap-3 rounded-xl border border-brand/30 bg-brand/[0.07] px-4 py-2.5 text-start text-sm leading-relaxed text-ink-2 transition-colors hover:border-brand/55 hover:bg-brand/[0.1]"
          style={delay(200)}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/15 text-brand">
            <ShieldCheck className="size-4" />
          </span>
          <span>
            <span className="font-semibold text-ink">{h.otpTitle}</span> {h.otpText}
          </span>
          <span className="hidden shrink-0 items-center gap-1 font-semibold whitespace-nowrap text-brand sm:inline-flex">
            {h.otpCta} <Arrow className="size-3.5" />
          </span>
        </Link>

        <div className="animate-fade-up mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center" style={delay(240)}>
          <Link href="/register" className={buttonClass('brand', 'lg', 'h-12 rounded-lg px-7 font-semibold shadow-[0_14px_34px_-14px] shadow-brand/70')}>
            {h.cta} <Arrow />
          </Link>
          <button type="button" onClick={playDemo} className={buttonClass('outline', 'lg', 'h-12 rounded-lg bg-card/70 px-6 backdrop-blur')}>
            <span className="flex size-6 items-center justify-center rounded-full bg-brand/15 text-brand">
              <Play className="size-3 translate-x-px fill-current" />
            </span>
            {h.watch}
          </button>
        </div>

        <ul className="animate-fade-up mt-7 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm text-muted" style={delay(320)}>
          {h.trust.map((item) => (
            <li key={item} className="flex items-center gap-2">
              <Check className="size-4 text-brand" strokeWidth={2.5} />
              {item}
            </li>
          ))}
        </ul>
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
        <dl className="grid grid-cols-2 gap-y-10 lg:grid-cols-4">
          {t.landing.stats.map((s, i) => (
            <Reveal key={s.label} delay={i * 70} className={cx('flex flex-col-reverse px-4 text-center', i > 0 && 'lg:border-s lg:border-line')}>
              <dt className="mt-2 text-sm text-muted">{s.label}</dt>
              <dd className="ltr text-3xl font-semibold tracking-tight sm:text-4xl">{s.value}</dd>
            </Reveal>
          ))}
        </dl>

        <p className="mt-16 text-center text-sm text-muted">{t.landing.integrations}</p>
        <div className="marquee mt-6" dir="ltr">
          <div className="marquee-track">
            {[...LANGUAGES, ...LANGUAGES].map((name, i) => (
              <span
                key={i}
                aria-hidden={i >= LANGUAGES.length || undefined}
                className="me-3 shrink-0 rounded-full border border-line bg-card px-4 py-2 font-mono text-sm font-medium whitespace-nowrap text-ink-2"
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
        <div className="relative mt-16">
          <span aria-hidden className="absolute inset-x-[17%] top-7 hidden h-px bg-gradient-to-r from-transparent via-line-strong to-transparent md:block" />
          <ol className="grid gap-12 md:grid-cols-3 md:gap-8">
          {s.steps.map((step, i) => {
            const Icon = STEP_ICONS[i]!;
            return (
              <li key={step.title} className="relative text-center">
                <Reveal delay={i * 120}>
                  <span className="relative mx-auto flex size-14 items-center justify-center rounded-2xl border border-line bg-card text-brand shadow-sm">
                    <Icon className={cx('size-6', i === 2 && flip)} />
                    <span className="absolute -end-2 -top-2 flex size-6 items-center justify-center rounded-full bg-brand text-[11px] font-bold text-on-brand ring-4 ring-bg">{i + 1}</span>
                  </span>
                  <h3 className="mt-6 text-lg font-semibold">{step.title}</h3>
                  <p className="mx-auto mt-2 max-w-xs text-sm leading-relaxed text-muted">{step.text}</p>
                </Reveal>
              </li>
            );
          })}
          </ol>
        </div>
        <Reveal className="mt-14 flex justify-center">
          <Link href="/register" className={buttonClass('brand', 'lg', 'h-12 rounded-lg px-7 font-semibold')}>
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
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-brand/15 text-brand">
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                  {point}
                </Reveal>
              </li>
            ))}
          </ul>
          <Reveal className="mt-9 flex flex-wrap gap-3">
            <Link href="/guide" className={buttonClass('brand', 'lg', 'rounded-lg font-semibold')}>
              {s.guide} <Arrow />
            </Link>
            <a href="/docs" target="_blank" rel="noreferrer" className={buttonClass('outline', 'lg', 'rounded-lg')}>
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
                <li key={item.title} className="group p-7 transition-colors hover:bg-raised/35 sm:p-8">
                  <span className="flex size-11 items-center justify-center rounded-xl bg-brand/10 text-brand ring-1 ring-brand/20 transition-transform duration-300 group-hover:scale-105">
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
        <div className="lg:sticky lg:top-28 lg:self-start">
          <SectionHeading align="start" kicker={s.kicker} title={s.title} accent={s.accent} text={s.text} />
          <Reveal>
            <ul className="mt-8 flex flex-wrap gap-2">
              {SECURITY_BADGES.map((badge) => (
                <li key={badge} className="ltr rounded-md border border-line bg-card px-2.5 py-1 font-mono text-[11px] font-medium text-muted">
                  {badge}
                </li>
              ))}
            </ul>
            <Link href="/privacy" className="group mt-8 inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:text-brand-strong">
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
                    <span className="flex size-10 items-center justify-center rounded-xl bg-brand/10 text-brand ring-1 ring-brand/20">
                      <Icon className="size-5" />
                    </span>
                    <h3 className="mt-4 font-semibold">{item.title}</h3>
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
        <div className="mt-16">
          <PlanCards />
        </div>
        <Reveal className="mt-8">
          <div className="site-card flex flex-col gap-5 rounded-2xl p-6 sm:flex-row sm:items-center sm:justify-between sm:p-8">
            <div className="flex items-center gap-4">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand ring-1 ring-brand/20">
                <Building2 className="size-6" />
              </span>
              <div>
                <h3 className="text-lg font-semibold">{s.higherTitle}</h3>
                <p className="mt-0.5 text-sm text-muted">{s.higherText}</p>
              </div>
            </div>
            <a href={`mailto:${BRAND.supportEmail}`} className={buttonClass('outline', 'lg', 'rounded-lg')}>
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
        <div className="lg:sticky lg:top-28 lg:self-start">
          <SectionHeading align="start" kicker={s.kicker} title={s.title} accent={s.accent} text={s.text} />
          <Reveal className="site-card mt-8 rounded-2xl p-6">
            <p className="font-semibold">{s.contactTitle}</p>
            <p className="mt-1 text-sm text-muted">{s.contactText}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <a href={`mailto:${BRAND.supportEmail}`} className={buttonClass('brand', 'md', 'rounded-lg')}>
                <Mail className="size-4" />
                {s.contactCta}
              </a>
              <Link href="/guide" className={buttonClass('outline', 'md', 'rounded-lg')}>
                {s.docsCta}
              </Link>
            </div>
          </Reveal>
        </div>
        <Reveal>
          <div className="divide-y divide-line border-y border-line">
            {s.items.map((item) => (
              <details key={item.q} className="group">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-start text-base font-semibold transition-colors hover:text-brand sm:text-lg [&::-webkit-details-marker]:hidden">
                  <span>{item.q}</span>
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-line text-muted transition-colors group-open:border-brand/50 group-open:text-brand">
                    <Plus className="faq-icon size-4 transition-transform duration-300" />
                  </span>
                </summary>
                <p className="animate-fade-in pe-12 pb-6 text-[15px] leading-relaxed text-muted">{item.a}</p>
              </details>
            ))}
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
        <div className="relative isolate overflow-hidden rounded-3xl bg-[#05241e] px-6 py-16 text-center text-white sm:px-12 sm:py-20">
          <div aria-hidden className="absolute inset-0 -z-10 bg-[radial-gradient(60%_90%_at_50%_0%,rgb(52_211_153/0.32),transparent_70%)]" />
          <div
            aria-hidden
            className="absolute inset-0 -z-10 [background-image:linear-gradient(to_right,rgb(255_255_255/0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgb(255_255_255/0.06)_1px,transparent_1px)] [background-size:48px_48px] [mask-image:radial-gradient(ellipse_60%_80%_at_50%_0%,#000,transparent)]"
          />
          <h2 className="mx-auto max-w-2xl text-3xl leading-tight font-semibold tracking-tight sm:text-5xl">{s.title}</h2>
          <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-white/75">{s.text}</p>
          <div className="mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:items-center">
            <Link
              href="/register"
              className="group inline-flex h-12 items-center justify-center gap-2.5 rounded-lg bg-white px-7 font-semibold text-[#05241e] shadow-lg transition-[background-color,transform] duration-200 hover:bg-white/90 active:scale-[0.97]"
            >
              {s.cta} <Arrow />
            </Link>
            <a
              href={`mailto:${BRAND.supportEmail}`}
              className="inline-flex h-12 items-center justify-center rounded-lg border border-white/25 px-6 font-medium text-white transition-colors hover:bg-white/10"
            >
              {s.contact}
            </a>
          </div>
          <p className="mt-5 text-sm text-white/60">{s.note}</p>
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
