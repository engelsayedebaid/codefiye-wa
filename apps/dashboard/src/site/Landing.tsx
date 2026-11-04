import { ArrowUpRight, BookOpen, Building2, Check, CheckCheck, ChevronRight, Code2, Mail, MessageCircle, Play, Plus, ShieldCheck } from '../icons';
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
  const { hero } = t.landing;
  const otp = hero.otpPreview;
  return (
    <section className="studio-hero" aria-labelledby="home-headline">
      <div className="studio-hero-grid">
        <div className="min-w-0">
          <Link href="#pricing" className="studio-announcement">
            <span>{hero.announceTag}</span> {hero.announce}
            <ChevronRight className={cx('size-3.5 shrink-0', flip)} />
          </Link>
          <h1 id="home-headline" className="animate-fade-up studio-headline">
            {hero.title} <span>{hero.accent}</span>
          </h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted sm:text-lg">{hero.text}</p>
          <div className="mt-7 flex flex-wrap gap-2.5">
            <Link href="/register" className={buttonClass('brand', 'lg')}>
              {hero.cta} <Arrow />
            </Link>
            <button type="button" onClick={playDemo} className={buttonClass('outline', 'lg')}>
              <Play className="size-4" /> {hero.watch}
            </button>
          </div>
          <ul className="mt-5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
            {hero.trust.map((item) => (
              <li key={item} className="flex items-center gap-1.5"><Check className="size-3.5 text-brand" />{item}</li>
            ))}
          </ul>
        </div>
        <figure className="studio-dispatch animate-fade-up" style={delay(100)}>
          <figcaption className="studio-dispatch-label">
            <span className="inline-flex items-center gap-2"><span aria-hidden className="studio-status-light" />{otp.caption}</span>
            <bdi>OTP</bdi>
          </figcaption>
          <svg aria-hidden className="studio-routing" viewBox="0 0 500 330" preserveAspectRatio="xMidYMid slice" fill="none">
            <g stroke="currentColor" strokeWidth="1">
              {[72, 104, 138, 176, 219, 268].map((radius) => <circle key={radius} cx="389" cy="67" r={radius} />)}
              <path d="M0 264h82l88-88h105l89-89h136M0 278h88l88-88h106l89-89h129" />
            </g>
            <g fill="currentColor"><circle cx="82" cy="264" r="3" /><circle cx="275" cy="176" r="4" /><circle cx="364" cy="87" r="3" /></g>
          </svg>
          <div className="studio-thread">
            <div className="flex items-center gap-2.5">
              <span className="studio-chat-icon"><ShieldCheck aria-hidden className="size-5" /></span>
              <div><strong className="block text-sm"><bdi>{BRAND.name}</bdi></strong><small>{otp.sender}</small></div>
            </div>
            <div className="studio-otp-message">
              <p>{otp.message}</p>
              <bdi dir="ltr" className="studio-otp-code">482910</bdi>
              <small>{otp.safety}</small>
            </div>
          </div>
          <div className="studio-receipt">
            <span className="studio-receipt-icon"><CheckCheck aria-hidden className="size-5" /></span>
            <strong>{otp.delivered}</strong>
          </div>
          <div className="studio-endpoint" dir="ltr"><Code2 aria-hidden className="size-4" /> POST /api/send-otp</div>
        </figure>
      </div>
      <div className="studio-shortcuts">
        <Link href="#platform"><MessageCircle className="size-4" /> {t.landing.platform.inbox.title} <Arrow /></Link>
        <Link href="#developers"><Code2 className="size-4" /> {t.landing.platform.api.title} <Arrow /></Link>
        <Link href="/guide"><ShieldCheck className="size-4" /> {hero.otpTitle} <Arrow /></Link>
      </div>
    </section>
  );
}

function TrustStrip() {
  const { t } = useI18n();
  return (
    <section className="studio-metrics py-14 sm:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <Reveal className="studio-metric-panel overflow-hidden rounded-2xl">
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
    <section id="how" className="studio-steps band scroll-mt-20 py-20 sm:py-28">
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
                    <span className="studio-step-number ltr font-mono">0{i + 1}</span>
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
        <div className="studio-closing relative isolate overflow-hidden rounded-3xl px-6 py-16 text-center sm:px-12 sm:py-20">
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
  const { t } = useI18n();
  // Opened at /#pricing, or sent here from another page: go to that section once it has rendered.
  useEffect(() => {
    if (location.hash.length > 1) scrollToHash(location.hash.slice(1));
  }, []);

  return (
    <div className="studio-site overflow-x-clip">
      <SiteHeader />
      <main id="main">
        <Hero />
        <TrustStrip />
        <DemoVideo />
        <Platform />
        <section className="studio-product-stage">
          <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8">
            <SectionHeading align="start" kicker={t.landing.dashboard} title={t.landing.platform.inbox.title} text={t.landing.platform.inbox.text} />
            <div className="mt-9"><ProductShot /></div>
          </div>
        </section>
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
