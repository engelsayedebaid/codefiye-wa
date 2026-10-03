import { ArrowRight, ArrowUpRight, Check, ChevronDown, CircleHelp, Clock, CreditCard, Menu, Sparkles, Users, X, Zap } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { sessionHint } from '../api';
import { BRAND } from '../brand';
import { useI18n } from '../i18n';
import { Link } from '../router';
import { buttonClass, cx, delay, flip, LangSwitch, Logo, Reveal } from '../ui';
import { CodeTabs } from './CodeTabs';
import { FOOTER_HREFS, LANGUAGES, MESSAGE_TYPE_ICONS, NAV_HREFS, RECIPIENTS, RESOURCES, STEP_ICONS, USE_CASE_ICONS } from './content';
import { PhoneMock } from './PhoneMock';
import { PlanCards } from './Pricing';

/** "Forward" arrow: points right in LTR, left in RTL, and nudges forward on hover. */
const Arrow = () => (
  <ArrowRight className={cx('size-4.5 transition-transform duration-300 group-hover:translate-x-1 rtl:group-hover:-translate-x-1', flip)} />
);

/** Diagonal light beam behind the hero headline (mirrored for RTL; see .animate-spotlight). */
function Spotlight() {
  return (
    <svg
      aria-hidden
      className="animate-spotlight pointer-events-none absolute z-[1] h-[169%] w-[138%] opacity-0 lg:w-[84%]"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 3787 2842"
      fill="none"
    >
      <g filter="url(#hero-spotlight)">
        <ellipse
          cx="1924.71"
          cy="273.501"
          rx="1924.71"
          ry="273.501"
          transform="matrix(-0.822377 -0.568943 -0.568943 0.822377 3631.88 2291.09)"
          fill="white"
          fillOpacity="0.21"
        />
      </g>
      <defs>
        <filter id="hero-spotlight" x="0.860352" y="0.838989" width="3785.16" height="2840.26" filterUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
          <feFlood floodOpacity="0" result="BackgroundImageFix" />
          <feBlend mode="normal" in="SourceGraphic" in2="BackgroundImageFix" result="shape" />
          <feGaussianBlur stdDeviation="151" />
        </filter>
      </defs>
    </svg>
  );
}

function Heading({ top, accent, accentFirst, className }: { top: ReactNode; accent: ReactNode; accentFirst?: boolean; className?: string }) {
  return (
    <h2 className={cx('text-4xl leading-[1.15] font-bold tracking-tight text-balance sm:text-6xl', className)}>
      {accentFirst ? (
        <>
          <span className="text-shimmer">{accent}</span> {top}
        </>
      ) : (
        <>
          {top}
          <br />
          <span className="text-shimmer">{accent}</span>
        </>
      )}
    </h2>
  );
}

function SectionIntro({ eyebrow, top, accent, text, accentFirst }: { eyebrow: ReactNode; top: ReactNode; accent: ReactNode; text: ReactNode; accentFirst?: boolean }) {
  return (
    <Reveal className="mx-auto max-w-3xl text-center">
      <span className="eyebrow">{eyebrow}</span>
      <Heading top={top} accent={accent} accentFirst={accentFirst} className="mt-7" />
      <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-ink-2 sm:text-xl">{text}</p>
    </Reveal>
  );
}

function Header() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // A UI hint only: the session itself is an HttpOnly cookie the page can't read.
  const signedIn = sessionHint.get();

  return (
    <header className="animate-fade-in relative z-20 bg-bg">
      <div className="relative mx-auto flex max-w-7xl items-center justify-between gap-6 px-6 py-5">
        <Link href="/" aria-label={BRAND.name}>
          <Logo />
        </Link>
        <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-8 lg:flex">
          {t.landing.nav.map((label, i) => (
            <a
              key={label}
              href={NAV_HREFS[i]}
              className="relative text-sm font-medium whitespace-nowrap text-white/70 transition-colors after:absolute after:inset-x-0 after:-bottom-1.5 after:h-px after:origin-center after:scale-x-0 after:bg-brand after:transition-transform after:duration-300 hover:text-white hover:after:scale-x-100"
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="hidden min-w-[200px] items-center justify-end gap-2 lg:flex">
          <LangSwitch />
          {signedIn ? (
            <Link href="/dashboard" className={buttonClass('white', 'md')}>
              {t.landing.dashboard} <Arrow />
            </Link>
          ) : (
            <>
              <Link href="/login" className={buttonClass('ghost', 'md', 'text-white/80 hover:bg-white/10 hover:text-white')}>
                {t.landing.login}
              </Link>
              <Link href="/register" className={buttonClass('white', 'md')}>
                {t.landing.getStarted} <Arrow />
              </Link>
            </>
          )}
        </div>
        <div className="flex items-center gap-1 lg:hidden">
          <LangSwitch />
          <button className="rounded-md p-2 text-ink-2" onClick={() => setOpen((o) => !o)} aria-label={t.common.menu} aria-expanded={open}>
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </button>
        </div>
      </div>
      {open && (
        <div className="animate-fade-up border-t border-line px-4 pb-5 lg:hidden">
          <nav className="flex flex-col py-2">
            {t.landing.nav.map((label, i) => (
              <a key={label} href={NAV_HREFS[i]} onClick={() => setOpen(false)} className="rounded-md px-2 py-3 text-ink-2 hover:text-ink">
                {label}
              </a>
            ))}
          </nav>
          <div className="grid grid-cols-2 gap-3">
            <Link href={signedIn ? '/dashboard' : '/login'} className={buttonClass('outline', 'md')}>
              {signedIn ? t.landing.dashboard : t.landing.login}
            </Link>
            <Link href="/register" className={buttonClass('white', 'md')}>
              {t.landing.getStarted}
            </Link>
          </div>
        </div>
      )}
    </header>
  );
}

function Hero() {
  const { t } = useI18n();
  const h = t.landing.hero;
  const icons = [CreditCard, Clock, X];
  return (
    <section className="relative grid min-h-svh place-content-center overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[linear-gradient(to_right,#ffffff03_1px,transparent_1px),linear-gradient(to_bottom,#ffffff03_1px,transparent_1px)] bg-[size:30px_30px]" />
        <div className="absolute inset-0 bg-gradient-to-b from-bg to-navy" />
        <div className="animate-glow absolute -end-80 -top-80 size-[500px] rounded-full bg-brand/10 blur-[120px]" />
        <div className="absolute start-0 bottom-0 size-[400px] rounded-full bg-[#075e54]/10 blur-[100px]" />
      </div>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-24 bg-gradient-to-b from-bg to-transparent" />
      <div className="relative z-10 mx-auto flex max-w-5xl flex-col items-center px-4 py-20 text-center">
        <Spotlight />
        <h1 className="relative z-[2] text-5xl leading-[1.1] font-bold tracking-tight text-balance sm:text-7xl sm:leading-[1.1]">
          <span className="animate-fade-up block" style={delay(100)}>
            {h.title}
          </span>
          <span className="animate-fade-up block" style={delay(250)}>
            <span className="text-shimmer">{h.accent}</span>
          </span>
        </h1>
        <p className="animate-fade-up relative z-[2] mx-auto mt-8 max-w-3xl text-xl leading-relaxed text-ink-2 sm:text-2xl" style={delay(400)}>
          {h.text}
        </p>
        <div className="animate-fade-up relative z-[2] mt-10 flex flex-wrap items-center justify-center gap-4" style={delay(550)}>
          <Link href="/register" className={buttonClass('white', 'lg', 'h-12 px-8 text-lg hover:shadow-[0_0_40px_-8px_rgba(255,255,255,0.45)]')}>
            {h.cta} <Arrow />
          </Link>
          <a href="/docs" className={buttonClass('white', 'md', 'h-10')}>
            {h.docs} <Arrow />
          </a>
        </div>
        <ul
          className="animate-fade-up relative z-[2] mx-auto mt-10 inline-flex flex-wrap items-center justify-center gap-x-5 gap-y-2 rounded-2xl border border-white/[0.06] bg-black/40 px-6 py-3.5 text-[15px] font-semibold backdrop-blur"
          style={delay(700)}
        >
          {h.trust.map((item, i) => {
            const Icon = icons[i]!;
            return (
              <li key={item} className="flex items-center gap-2">
                {i > 0 && <span className="me-3 hidden h-4 w-px bg-line-strong sm:block" />}
                <Icon className={cx('size-4', i === 0 ? 'text-brand' : i === 1 ? 'text-sky-400' : 'text-red-400')} />
                {item}
              </li>
            );
          })}
        </ul>
        <a href="#features" className="animate-fade-in relative z-[2] mt-14 flex flex-col items-center gap-3 text-sm text-muted transition-colors hover:text-ink" style={delay(1000)}>
          {h.scroll}
          <span className="flex h-10 w-6 justify-center rounded-full border border-line-strong pt-2">
            <span className="animate-scroll-dot size-1.5 rounded-full bg-ink" />
          </span>
        </a>
      </div>
    </section>
  );
}

function Integration() {
  const { t } = useI18n();
  const s = t.landing.integration;
  return (
    <section id="features" className="section-wash scroll-mt-16 py-24 sm:py-32">
      <div className="mx-auto max-w-5xl px-4">
        <SectionIntro eyebrow={s.eyebrow} top={s.top} accent={s.accent} text={s.text} />
        <Reveal delay={100}>
          <CodeTabs className="mt-14" />
        </Reveal>
        <Reveal>
          <ul className="mt-10 flex flex-wrap items-center justify-center gap-2.5" dir="ltr">
            {LANGUAGES.map((l) => (
              <li key={l}>
                <span className="block rounded-lg border border-line bg-white/[0.03] px-3 py-1.5 text-sm font-medium text-ink-2 transition-all duration-300 hover:-translate-y-0.5 hover:border-brand/40 hover:text-ink">
                  {l}
                </span>
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal className="mt-12 flex justify-center">
          <Link href="/register" className={buttonClass('brand', 'lg', 'h-14 bg-gradient-to-r from-brand to-teal px-7 text-lg')}>
            {s.cta} <Arrow />
          </Link>
        </Reveal>
      </div>
    </section>
  );
}

function DeveloperResources() {
  const { t } = useI18n();
  const s = t.landing.resources;
  return (
    <section className="section-wash py-24 sm:py-32">
      <div className="mx-auto max-w-5xl px-4">
        <SectionIntro eyebrow={s.eyebrow} top={s.top} accent={s.accent} accentFirst text={s.text} />
        <div className="mt-14 grid gap-6 sm:grid-cols-2">
          {s.items.map((item, i) => {
            const { icon: Icon, tint, href } = RESOURCES[i]!;
            return (
              <Reveal key={item.title} delay={i * 90}>
                <article className="lift group flex h-full flex-col rounded-xl border border-line bg-gradient-to-b from-[#161616] to-[#121722] p-6">
                  <h3 className="flex items-center gap-3 text-xl font-semibold">
                    <span className="flex size-10 items-center justify-center rounded-lg bg-white/5 transition-transform duration-300 group-hover:scale-110">
                      <Icon className={cx('size-5', tint)} />
                    </span>
                    {item.title}
                  </h3>
                  <p className="mt-4 flex-1 leading-relaxed text-ink-2">{item.text}</p>
                  <Link href={href} className="mt-5 inline-flex items-center justify-center gap-2 text-sm font-medium text-brand hover:underline">
                    {item.cta} <ArrowUpRight className={cx('size-4', flip)} />
                  </Link>
                </article>
              </Reveal>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  const { t } = useI18n();
  const s = t.landing.how;
  return (
    <section id="how" className="section-wash scroll-mt-16 py-24 sm:py-32">
      <div className="mx-auto max-w-5xl px-4">
        <SectionIntro eyebrow={s.eyebrow} top={s.top} accent={s.accent} text={s.text} />
        <ol className="mx-auto mt-16 max-w-3xl">
          {s.steps.map((step, i) => {
            const Icon = STEP_ICONS[i]!;
            return (
              <li key={step.title} className="relative pb-16 last:pb-0">
                {i < s.steps.length - 1 && <span className="absolute top-24 bottom-0 start-12 w-px bg-gradient-to-b from-brand/70 to-brand/0" />}
                <Reveal delay={i * 120} className="flex gap-8">
                  <span className="relative flex size-24 shrink-0 items-center justify-center rounded-full border border-line-strong bg-gradient-to-b from-[#1c1c1c] to-[#0f1a14] text-3xl font-bold shadow-[0_0_40px_-10px] shadow-brand/30">
                    {i + 1}
                  </span>
                  <div className="pt-2">
                    <span className="flex size-14 items-center justify-center rounded-xl bg-[#10281a] text-brand">
                      <Icon className="size-6" />
                    </span>
                    <h3 className="mt-4 text-2xl font-semibold">{step.title}</h3>
                    <p className="mt-3 text-lg leading-relaxed text-ink-2">{step.text}</p>
                  </div>
                </Reveal>
              </li>
            );
          })}
        </ol>
        <Reveal className="mt-14 flex justify-center">
          <Link href="/register" className={buttonClass('white', 'lg', 'h-12 px-8 text-lg')}>
            {s.cta} <Arrow />
          </Link>
        </Reveal>
      </div>
    </section>
  );
}

function SendReceive() {
  const { t } = useI18n();
  const s = t.landing.sendReceive;
  return (
    <section className="section-wash overflow-hidden py-24 sm:py-32">
      <div className="mx-auto grid max-w-7xl items-center gap-16 px-4 sm:px-6 lg:grid-cols-[1.1fr_1fr]">
        <div>
          <Reveal>
            <span className="eyebrow">{s.eyebrow}</span>
            <h2 className="mt-7 text-5xl leading-[1.1] font-bold tracking-tight sm:text-6xl">
              {s.title}
              <br />
              <span className="text-shimmer">{s.accent}</span>
            </h2>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-2">
              {s.textBefore}{' '}
              <a href="/docs" className="font-semibold text-brand hover:underline">
                {s.docs}
              </a>{' '}
              {s.textAfter}
            </p>
          </Reveal>
          <div className="mt-10 grid gap-8 sm:grid-cols-[2fr_1fr]">
            <div>
              <h3 className="mb-4 text-lg font-semibold">{s.typesTitle}</h3>
              <div className="grid grid-cols-2 gap-3">
                {s.types.map((type, i) => {
                  const Icon = MESSAGE_TYPE_ICONS[i]!;
                  return (
                    <Reveal key={type.title} delay={i * 60}>
                      <div className="lift h-full rounded-xl border border-line bg-white/[0.02] p-4">
                        <p className="flex items-center gap-2.5 font-semibold">
                          <span className="flex size-7 items-center justify-center rounded-full bg-brand text-black">
                            <Icon className="size-4" />
                          </span>
                          {type.title}
                        </p>
                        <p className="mt-2 text-sm text-ink-2">{type.text}</p>
                      </div>
                    </Reveal>
                  );
                })}
              </div>
            </div>
            <div>
              <h3 className="mb-4 text-lg font-semibold">{s.recipientsTitle}</h3>
              <div className="grid gap-3">
                {s.recipients.map((r, i) => {
                  const { icon: Icon, tint } = RECIPIENTS[i]!;
                  return (
                    <Reveal key={r.title} delay={i * 80}>
                      <div className="lift rounded-xl border border-line bg-white/[0.02] p-4">
                        <p className="flex items-center gap-2.5 font-semibold">
                          <span className={cx('flex size-7 items-center justify-center rounded-full bg-gradient-to-br text-white', tint)}>
                            <Icon className="size-4" />
                          </span>
                          {r.title}
                        </p>
                        <p className="mt-2 text-sm text-ink-2">{r.text}</p>
                      </div>
                    </Reveal>
                  );
                })}
              </div>
            </div>
          </div>
          <Reveal>
            <Link href="/register" className={buttonClass('brand', 'lg', 'mt-10 bg-gradient-to-r from-brand to-teal text-black')}>
              {s.cta} <Arrow />
            </Link>
          </Reveal>
        </div>
        <Reveal delay={150}>
          <div className="animate-float">
            <PhoneMock className="-rotate-3 rtl:rotate-3" />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function UseCases() {
  const { t } = useI18n();
  const s = t.landing.useCases;
  const tints = ['from-teal to-brand', 'from-emerald-600 to-teal', 'from-brand to-emerald-600'];
  return (
    <section className="section-wash py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionIntro eyebrow={s.eyebrow} top={s.top} accent={s.accent} text={s.text} />
        <div className="mt-16 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {s.items.map((u, i) => {
            const Icon = USE_CASE_ICONS[i]!;
            return (
              <Reveal key={u.title} delay={(i % 3) * 100}>
                <article className="lift group h-full rounded-2xl border border-line bg-gradient-to-b from-[#121212] to-[#0f141d] p-7">
                  <span
                    className={cx(
                      'flex size-16 items-center justify-center rounded-xl bg-gradient-to-br text-white transition-transform duration-500 group-hover:-rotate-6 group-hover:scale-110',
                      tints[i % tints.length],
                    )}
                  >
                    <Icon className="size-7" />
                  </span>
                  <h3 className="mt-7 text-2xl leading-snug font-semibold">{u.title}</h3>
                  <p className="mt-4 text-lg leading-relaxed text-ink-2">{u.text}</p>
                </article>
              </Reveal>
            );
          })}
        </div>
        <Reveal className="mt-14 flex justify-center">
          <Link href="/register" className={buttonClass('brand', 'lg', 'h-14 bg-gradient-to-r from-brand to-teal px-7 text-lg')}>
            {s.cta} <Arrow />
          </Link>
        </Reveal>
      </div>
    </section>
  );
}

function Pricing() {
  const { t } = useI18n();
  const s = t.landing.pricing;
  return (
    <section id="pricing" className="section-wash scroll-mt-16 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionIntro
          eyebrow={
            <>
              <Sparkles className="size-4 text-brand" /> {s.eyebrow}
            </>
          }
          top={s.top}
          accent={s.accent}
          text={s.text}
        />
        <div className="mt-20">
          <PlanCards />
        </div>
        <Reveal className="mx-auto mt-14 max-w-4xl">
          <div className="flex flex-wrap items-center justify-between gap-5 rounded-2xl border border-line bg-[#141821] p-6">
            <div className="flex items-center gap-4">
              <span className="flex size-12 items-center justify-center rounded-xl bg-white/[0.06]">
                <Users className="size-5" />
              </span>
              <div>
                <h3 className="text-lg font-semibold">{s.higherTitle}</h3>
                <p className="text-ink-2">{s.higherText}</p>
              </div>
            </div>
            <a href={`mailto:${BRAND.supportEmail}`} className={buttonClass('brand', 'lg')}>
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
    <section id="faq" className="section-wash scroll-mt-16 py-24 sm:py-32">
      <div className="mx-auto max-w-4xl px-4">
        <SectionIntro eyebrow={s.eyebrow} top={s.top} accent={s.accent} text={s.text} />
        <Reveal className="mt-14">
          <div className="space-y-4 rounded-2xl border border-line bg-[#131313] p-4 sm:p-7">
            {s.items.map((item) => (
              <details key={item.q} className="group rounded-xl border border-line bg-white/[0.02] transition-colors open:bg-white/[0.04] hover:border-white/15">
                <summary className="flex cursor-pointer list-none items-center gap-4 px-5 py-5 text-lg font-semibold [&::-webkit-details-marker]:hidden">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#10281a] text-brand">
                    <CircleHelp className="size-4" />
                  </span>
                  <span className="flex-1 text-center">{item.q}</span>
                  <ChevronDown className="size-5 shrink-0 text-muted transition-transform duration-300 group-open:rotate-180" />
                </summary>
                <p className="animate-fade-up px-5 pb-5 ps-[4.25rem] leading-relaxed text-ink-2">{item.a}</p>
              </details>
            ))}
          </div>
        </Reveal>
        <div className="mt-14 grid gap-8 sm:grid-cols-2">
          <Reveal className="flex flex-col items-center gap-4">
            <span className="eyebrow">{s.helpEyebrow}</span>
            <a href={`mailto:${BRAND.supportEmail}`} className={buttonClass('white', 'lg', 'h-12 px-7 text-lg')}>
              {s.helpCta} <Arrow />
            </a>
          </Reveal>
          <Reveal delay={100} className="flex flex-col items-center gap-4">
            <span className="eyebrow">{s.docsEyebrow}</span>
            <a href="/docs" className={buttonClass('outline', 'lg', 'h-12 px-7 text-lg')}>
              {s.docsCta} <Arrow />
            </a>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  const { t } = useI18n();
  const s = t.landing.finalCta;
  const icons = [CreditCard, Zap, Check];
  return (
    <section className="py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <Reveal>
          <div className="relative grid items-center gap-12 overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-[#121722] via-[#0f141d] to-[#0c1a14] p-8 sm:p-14 lg:grid-cols-2">
            <div aria-hidden className="animate-glow pointer-events-none absolute -end-24 -bottom-24 size-80 rounded-full bg-brand/10 blur-3xl" />
            <div className="relative">
              <h2 className="text-4xl leading-[1.15] font-bold tracking-tight sm:text-5xl">
                {s.title}
                <br />
                <span className="text-shimmer">{s.accent}</span>
              </h2>
              <p className="mt-6 text-lg text-ink-2">{s.text}</p>
              <ul className="mt-8 space-y-4">
                {s.points.map((text, i) => {
                  const Icon = icons[i]!;
                  return (
                    <li key={text} className="flex items-center gap-4 text-lg">
                      <span className="flex size-8 items-center justify-center rounded-full bg-brand/90 text-black">
                        <Icon className="size-4" />
                      </span>
                      {text}
                    </li>
                  );
                })}
              </ul>
              <Link href="/register" className={buttonClass('brand', 'lg', 'mt-10 h-14 w-full max-w-md bg-gradient-to-r from-brand to-teal text-lg')}>
                {s.cta} <Arrow />
              </Link>
              <p className="mt-3 text-sm text-faint">{s.note}</p>
            </div>
            <div className="relative grid items-end gap-6 sm:grid-cols-2" dir="ltr">
              <div className="rounded-2xl border border-line bg-[#0b0f17] p-4 font-mono text-[12px] leading-6 shadow-2xl">
                <div className="mb-3 flex gap-1.5">
                  <span className="size-2.5 rounded-full bg-[#ff5f57]" />
                  <span className="size-2.5 rounded-full bg-[#febc2e]" />
                  <span className="size-2.5 rounded-full bg-[#28c840]" />
                </div>
                <p className="text-[#569cd6]">
                  await <span className="text-[#dcdcaa]">send</span>
                  <span className="text-ink-2">({'{'}</span>
                </p>
                <p className="ps-4 text-ink-2">
                  to: <span className="text-[#ce9178]">'+201012345678'</span>,
                </p>
                <p className="ps-4 text-ink-2">
                  text: <span className="text-[#ce9178]">'Works like a charm!'</span>
                </p>
                <p className="text-ink-2">{'});'}</p>
                <p className="mt-3 animate-pulse text-brand">✓ Message sent</p>
              </div>
              <div className="animate-float" style={delay(800)}>
                <PhoneMock variant="mini" className="w-full max-w-[260px] sm:w-full" />
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function Footer() {
  const { t } = useI18n();
  return (
    <footer className="border-t border-line">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 py-16 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <Reveal className="space-y-5">
          <Logo />
          <p className="max-w-xs leading-relaxed text-ink-2">{t.brand.about}</p>
        </Reveal>
        {t.landing.footer.columns.map((col, c) => (
          <Reveal key={col.title} delay={(c + 1) * 80}>
            <h3 className="text-lg font-semibold">{col.title}</h3>
            <ul className="mt-5 space-y-3.5">
              {col.links.map((label, i) => (
                <li key={label}>
                  <Link href={FOOTER_HREFS[c]![i]!} className="text-ink-2 transition-colors hover:text-ink">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </Reveal>
        ))}
      </div>
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 border-t border-line px-4 py-6 text-sm text-faint sm:px-6">
        <p>
          © {new Date().getFullYear()} <span className="ltr">{BRAND.name}</span>. {t.landing.footer.rights}
        </p>
        <p className="max-w-2xl">{t.brand.disclaimer}</p>
      </div>
    </footer>
  );
}

export function Landing() {
  return (
    <div className="overflow-x-clip">
      <Header />
      <main>
        <Hero />
        <Integration />
        <DeveloperResources />
        <HowItWorks />
        <SendReceive />
        <UseCases />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
