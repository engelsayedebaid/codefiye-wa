import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Clock,
  Code2,
  CreditCard,
  Menu,
  Shield,
  Sparkles,
  Terminal,
  Users,
  Webhook,
  X,
  Zap,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { sessionHint } from '../api';
import { BRAND } from '../brand';
import { useI18n } from '../i18n';
import { Link } from '../router';
import { buttonClass, cx, delay, flip, LangSwitch, Logo, Reveal, ThemeSwitch } from '../ui';
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
    <h2 className={cx('text-4xl leading-[1.12] font-bold tracking-tight text-balance sm:text-5xl lg:text-6xl', className)}>
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
      <span className="eyebrow">
        <span className="size-1.5 rounded-full bg-brand" />
        {eyebrow}
      </span>
      <Heading top={top} accent={accent} accentFirst={accentFirst} className="mt-6" />
      <p className="mx-auto mt-5 max-w-2xl text-lg leading-relaxed text-ink-2 sm:text-xl">{text}</p>
    </Reveal>
  );
}

export function SiteHeader() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // A UI hint only: the session itself is an HttpOnly cookie the page can't read.
  const signedIn = sessionHint.get();

  return (
    <header className="animate-fade-in sticky top-0 z-40 px-3 pt-3 sm:px-6">
      <div className="mx-auto max-w-7xl rounded-2xl border border-line/80 bg-card/80 px-4 py-3 shadow-[0_12px_40px_-16px_rgba(0,0,0,0.35)] backdrop-blur-xl sm:px-6">
        <div className="relative flex items-center justify-between gap-3 sm:gap-6">
          <Link href="/" aria-label={BRAND.name}>
            <Logo />
          </Link>
          <nav className="absolute left-1/2 hidden -translate-x-1/2 items-center gap-1 rounded-full border border-line/70 bg-ink/[0.03] p-1 lg:flex">
            {t.landing.nav.map((label, i) => (
              <Link
                key={label}
                href={NAV_HREFS[i]!}
                className="rounded-full px-4 py-1.5 text-sm font-medium whitespace-nowrap text-ink-2 transition-all duration-200 hover:bg-raised/80 hover:text-ink"
              >
                {label}
              </Link>
            ))}
          </nav>
          <div className="hidden min-w-[200px] items-center justify-end gap-2 lg:flex">
            <ThemeSwitch />
            <LangSwitch />
            {signedIn ? (
              <Link href="/dashboard" className={buttonClass('brand', 'md', 'shine rounded-xl bg-gradient-to-r from-brand to-teal text-on-brand')}>
                {t.landing.dashboard} <Arrow />
              </Link>
            ) : (
              <>
                <Link href="/login" className={buttonClass('ghost', 'md', 'rounded-xl text-ink-2 hover:bg-ink/[0.06] hover:text-ink')}>
                  {t.landing.login}
                </Link>
                <Link href="/register" className={buttonClass('brand', 'md', 'shine rounded-xl bg-gradient-to-r from-brand to-teal text-on-brand')}>
                  {t.landing.getStarted} <Arrow />
                </Link>
              </>
            )}
          </div>
          <div className="flex items-center gap-1 lg:hidden">
            {/* Below 640px the logo and three buttons don't fit one row: theme and language move into the menu. */}
            <div className="hidden items-center gap-1 sm:flex">
              <ThemeSwitch />
              <LangSwitch />
            </div>
            <button className="rounded-lg p-2 text-ink-2 hover:bg-raised" onClick={() => setOpen((o) => !o)} aria-label={t.common.menu} aria-expanded={open}>
              {open ? <X className="size-5" /> : <Menu className="size-5" />}
            </button>
          </div>
        </div>
        {open && (
          <div className="animate-fade-up mt-3 border-t border-line pt-3 pb-2 lg:hidden">
            <nav className="flex flex-col py-1">
              {t.landing.nav.map((label, i) => (
                <Link key={label} href={NAV_HREFS[i]!} onClick={() => setOpen(false)} className="rounded-lg px-3 py-2.5 text-ink-2 hover:bg-raised hover:text-ink">
                  {label}
                </Link>
              ))}
            </nav>
            <div className="mt-2 grid grid-cols-2 gap-3">
              <Link href={signedIn ? '/dashboard' : '/login'} className={buttonClass('outline', 'md', 'rounded-xl')}>
                {signedIn ? t.landing.dashboard : t.landing.login}
              </Link>
              <Link href="/register" className={buttonClass('brand', 'md', 'rounded-xl bg-gradient-to-r from-brand to-teal text-on-brand')}>
                {t.landing.getStarted}
              </Link>
            </div>
            {/* Theme last: its popup opens toward the start from the button's end edge. */}
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-line pt-3 sm:hidden">
              <LangSwitch />
              <ThemeSwitch />
            </div>
          </div>
        )}
      </div>
    </header>
  );
}

function HeroShowcase() {
  const { t } = useI18n();
  const h = t.landing.hero;
  const p = t.landing.phone;
  return (
    <div className="animate-fade-up relative z-[2] mt-14 w-full max-w-6xl" style={delay(650)}>
      <div className="card-luxury relative overflow-hidden rounded-3xl border border-line-strong/80 p-3 sm:p-5">
        <div aria-hidden className="pointer-events-none absolute -top-32 left-1/2 h-64 w-3/4 -translate-x-1/2 rounded-full bg-brand/15 blur-3xl" />

        {/* Architectural Console Top Bar */}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-line bg-surface/70 px-4 py-2.5 text-xs">
          <div className="flex items-center gap-2.5">
            <span className="relative flex size-2.5">
              <span className="absolute inset-0 animate-ping rounded-full bg-good opacity-75" />
              <span className="relative size-2.5 rounded-full bg-good" />
            </span>
            <span className="font-semibold text-ink">{h.preview.liveStatus}</span>
          </div>
          <div className="flex items-center gap-3 font-mono text-[11px] text-muted" dir="ltr">
            <span className="rounded-md border border-line bg-card px-2 py-0.5">TLS 1.3 · AES-256-GCM</span>
            <span className="hidden rounded-md border border-brand/30 bg-brand/10 px-2 py-0.5 text-brand sm:inline">v1 REST + Webhooks</span>
          </div>
        </div>

        {/* 2-Column Live Request → WhatsApp Delivery & Webhook */}
        <div className="grid gap-4 lg:grid-cols-[1.2fr_1fr]" dir="ltr">
          {/* Request Terminal */}
          <div className="flex flex-col justify-between rounded-2xl border border-white/10 bg-[#0b0f0e] p-5 text-start font-mono text-xs text-white/85 shadow-xl">
            <div>
              <div className="flex items-center justify-between border-b border-white/10 pb-3">
                <span className="inline-flex items-center gap-2 text-white/70">
                  <Terminal className="size-3.5 text-brand" />
                  <span>{h.preview.requestLabel}</span>
                </span>
                <span className="rounded-md bg-emerald-500/15 px-2 py-0.5 text-[11px] font-bold text-emerald-400">POST /api/send-message</span>
              </div>
              <pre className="mt-4 overflow-x-auto leading-6 text-[#d4d4d4]">
                <code>
                  <span className="text-[#569cd6]">await</span> <span className="text-[#dcdcaa]">fetch</span>(
                  <span className="text-[#ce9178]">'/api/send-message'</span>, {'{\n'}
                  {'  '}headers: {'{ '}Authorization: <span className="text-[#ce9178]">'Bearer was_live_9f8a…'</span>
                  {' },\n'}
                  {'  '}body: JSON.<span className="text-[#dcdcaa]">stringify</span>({'{'}
                  {'\n'}
                  {'    '}to: <span className="text-[#ce9178]">'+201012345678'</span>,{'\n'}
                  {'    '}text: <span className="text-[#ce9178]">'Your OTP code is 482910 🔐'</span>
                  {'\n'}
                  {'  }'}){'\n'}
                  {'}'});
                </code>
              </pre>
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/[0.07] px-3.5 py-2.5 text-[11px]">
              <span className="text-emerald-300">HTTP/1.1 200 OK · msgId: "3EB08F19A2"</span>
              <span className="font-semibold text-emerald-400">38 ms</span>
            </div>
          </div>

          {/* Instant WhatsApp + Webhook Output */}
          <div className="flex flex-col gap-3">
            {/* Simulated WhatsApp Message Card */}
            <div className="rounded-2xl border border-line bg-[#efeae2] p-4 text-start shadow-md dark:bg-[#111715]">
              <div className="mb-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="flex size-7 items-center justify-center rounded-full bg-[#008069] text-xs font-bold text-white">{p.initial}</span>
                  <span className="text-xs font-semibold text-[#111b21] dark:text-white">{p.contact}</span>
                </div>
                <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                  {h.preview.deliveredBadge}
                </span>
              </div>
              <div className="ms-auto max-w-[92%] rounded-xl rounded-se-xs bg-[#d9fdd3] px-3.5 py-2.5 text-[13px] text-[#111b21] shadow-xs dark:bg-[#10402d] dark:text-white">
                <p className="font-mono text-xs sm:text-[13px]">Your OTP code is 482910 🔐</p>
                <div className="mt-1 flex items-center justify-end gap-1 text-[10px] opacity-70">
                  <span>10:42</span>
                  <CheckCheck className="size-3.5 text-[#53bdeb]" />
                </div>
              </div>
            </div>

            {/* Webhook Event Stream Card */}
            <div className="flex-1 rounded-2xl border border-line bg-surface/90 p-4 text-start font-mono text-xs">
              <div className="flex items-center justify-between text-[11px] text-muted">
                <span className="inline-flex items-center gap-1.5 font-sans font-semibold text-ink-2">
                  <Webhook className="size-3.5 text-brand" />
                  {h.preview.webhookLabel}
                </span>
                <span className="text-brand">event: messages.update</span>
              </div>
              <pre className="mt-2.5 overflow-x-auto rounded-lg border border-line bg-card/90 p-3 text-[11px] leading-5 text-ink-2">
                <code>{`{ "msgId": "3EB08F19A2", "status": "delivered", "to": "+201012345678" }`}</code>
              </pre>
            </div>
          </div>
        </div>

        {/* Bottom Telemetry Metrics Strip */}
        <div className="mt-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {h.metrics.map((m) => (
            <div key={m.label} className="rounded-2xl border border-line bg-surface/60 px-4 py-3 text-center transition-colors hover:border-brand/40">
              <p className="ltr font-mono text-xl font-bold tracking-tight text-ink sm:text-2xl">{m.value}</p>
              <p className="mt-0.5 text-xs font-medium text-muted">{m.label}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function Hero() {
  const { t } = useI18n();
  const h = t.landing.hero;
  const icons = [CreditCard, Clock, Shield];
  return (
    <section className="relative overflow-hidden pt-10 pb-20 sm:pt-16 sm:pb-28">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="hero-grid absolute inset-0" />
        <div className="animate-glow absolute -end-72 -top-72 size-[540px] rounded-full bg-brand/12 blur-[130px]" />
        <div className="absolute start-0 top-1/3 size-[420px] rounded-full bg-teal/10 blur-[120px]" />
      </div>
      <div className="relative z-10 mx-auto flex max-w-7xl flex-col items-center px-4 text-center sm:px-6">
        <Spotlight />

        <div className="animate-fade-up relative z-[2]" style={delay(50)}>
          <span className="eyebrow">
            <span className="relative flex size-2">
              <span className="absolute inset-0 animate-ping rounded-full bg-brand opacity-75" />
              <span className="relative size-2 rounded-full bg-brand" />
            </span>
            {h.badge}
          </span>
        </div>

        <h1 className="relative z-[2] mt-7 max-w-4xl text-5xl leading-[1.08] font-bold tracking-tight text-balance sm:text-7xl sm:leading-[1.08]">
          <span className="animate-fade-up block" style={delay(140)}>
            {h.title}
          </span>
          <span className="animate-fade-up mt-1 block" style={delay(260)}>
            <span className="text-shimmer">{h.accent}</span>
          </span>
        </h1>

        <p className="animate-fade-up relative z-[2] mx-auto mt-7 max-w-2xl text-lg leading-relaxed text-ink-2 sm:text-xl" style={delay(380)}>
          {h.text}
        </p>

        <div className="animate-fade-up relative z-[2] mt-9 flex flex-wrap items-center justify-center gap-4" style={delay(500)}>
          <Link
            href="/register"
            className={buttonClass(
              'brand',
              'lg',
              'shine-auto h-13 rounded-2xl bg-gradient-to-r from-brand to-teal px-8 text-base font-semibold text-on-brand shadow-[0_14px_40px_-10px] shadow-brand/50',
            )}
          >
            {h.cta} <Arrow />
          </Link>
          <Link href="/guide" className={buttonClass('outline', 'lg', 'h-13 rounded-2xl border-line-strong bg-card/80 px-7 text-base backdrop-blur')}>
            <Code2 className="size-4.5 text-brand" />
            {h.docs} <Arrow />
          </Link>
        </div>

        <ul
          className="animate-fade-up relative z-[2] mx-auto mt-8 inline-flex flex-wrap items-center justify-center gap-x-5 gap-y-2 rounded-full border border-line bg-card/75 px-6 py-2.5 text-sm font-medium text-ink-2 shadow-xs backdrop-blur"
          style={delay(600)}
        >
          {h.trust.map((item, i) => {
            const Icon = icons[i]!;
            return (
              <li key={item} className="flex items-center gap-2">
                {i > 0 && <span className="me-3 hidden h-3.5 w-px bg-line-strong sm:block" />}
                <Icon className={cx('size-4', i === 0 ? 'text-brand' : i === 1 ? 'text-info' : 'text-good')} />
                {item}
              </li>
            );
          })}
        </ul>

        <HeroShowcase />
      </div>
    </section>
  );
}

function Integration() {
  const { t } = useI18n();
  const s = t.landing.integration;
  return (
    <section id="features" className="section-wash scroll-mt-20 py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionIntro eyebrow={s.eyebrow} top={s.top} accent={s.accent} text={s.text} />
        <Reveal delay={100}>
          <CodeTabs className="mt-14" />
        </Reveal>
        <Reveal>
          <ul className="mt-9 flex flex-wrap items-center justify-center gap-2.5" dir="ltr">
            {LANGUAGES.map((l) => (
              <li key={l}>
                <span className="block rounded-xl border border-line bg-card/80 px-3.5 py-1.5 font-mono text-xs font-semibold text-ink-2 shadow-2xs transition-all duration-300 hover:-translate-y-0.5 hover:border-brand/50 hover:text-brand">
                  {l}
                </span>
              </li>
            ))}
          </ul>
        </Reveal>
        <Reveal className="mt-11 flex justify-center">
          <Link href="/register" className={buttonClass('brand', 'lg', 'shine h-13 rounded-2xl bg-gradient-to-r from-brand to-teal px-8 text-base font-semibold')}>
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
  const badges = ['OpenAPI 3.1 · Scalar', 'was_*** · wap_***', 'Idempotency-Key', 'Drop-in REST'];
  return (
    <section className="section-wash py-24 sm:py-32">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <SectionIntro eyebrow={s.eyebrow} top={s.top} accent={s.accent} accentFirst text={s.text} />
        <div className="mt-16 grid gap-6 sm:grid-cols-2">
          {s.items.map((item, i) => {
            const { icon: Icon, tint, href } = RESOURCES[i]!;
            return (
              <Reveal key={item.title} delay={i * 90}>
                <article className="lift card-luxury group relative flex h-full flex-col overflow-hidden rounded-3xl border border-line p-7 sm:p-8">
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex size-12 items-center justify-center rounded-2xl border border-line bg-surface transition-transform duration-300 group-hover:scale-110 group-hover:border-brand/40">
                      <Icon className={cx('size-5.5', tint)} />
                    </span>
                    <span className="ltr rounded-full border border-line bg-surface/80 px-3 py-1 font-mono text-[11px] font-medium text-muted">
                      {badges[i]}
                    </span>
                  </div>
                  <h3 className="mt-6 text-xl font-bold tracking-tight sm:text-2xl">{item.title}</h3>
                  <p className="mt-3 flex-1 leading-relaxed text-ink-2">{item.text}</p>
                  <div className="mt-6 border-t border-line/70 pt-4">
                    <Link href={href} className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand transition-colors hover:text-brand-strong">
                      {item.cta} <ArrowUpRight className={cx('size-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5', flip)} />
                    </Link>
                  </div>
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
    <section id="how" className="section-wash scroll-mt-20 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionIntro eyebrow={s.eyebrow} top={s.top} accent={s.accent} text={s.text} />
        <ol className="mt-16 grid gap-6 lg:grid-cols-3">
          {s.steps.map((step, i) => {
            const Icon = STEP_ICONS[i]!;
            return (
              <Reveal key={step.title} delay={i * 120} className="h-full">
                <li className="lift card-luxury relative flex h-full flex-col overflow-hidden rounded-3xl border border-line p-7 sm:p-8">
                  <div className="flex items-center justify-between gap-4">
                    <span className="flex size-14 items-center justify-center rounded-2xl bg-brand/15 text-brand ring-1 ring-brand/25">
                      <Icon className="size-6" />
                    </span>
                    <span className="ltr font-mono text-4xl font-bold tracking-tighter text-ink/15">0{i + 1}</span>
                  </div>
                  <h3 className="mt-7 text-2xl font-bold tracking-tight">{step.title}</h3>
                  <p className="mt-3 flex-1 leading-relaxed text-ink-2">{step.text}</p>
                  <div className="mt-6 h-1 w-16 rounded-full bg-gradient-to-r from-brand to-teal opacity-70" />
                </li>
              </Reveal>
            );
          })}
        </ol>
        <Reveal className="mt-14 flex justify-center">
          <Link href="/register" className={buttonClass('white', 'lg', 'h-13 rounded-2xl px-8 text-base font-semibold')}>
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
      <div className="mx-auto grid max-w-7xl items-center gap-16 px-4 sm:px-6 lg:grid-cols-[1.15fr_1fr]">
        <div>
          <Reveal>
            <span className="eyebrow">
              <Activity className="size-3.5 text-brand" />
              {s.eyebrow}
            </span>
            <h2 className="mt-6 text-4xl leading-[1.12] font-bold tracking-tight sm:text-5xl lg:text-6xl">
              {s.title}
              <br />
              <span className="text-shimmer">{s.accent}</span>
            </h2>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-ink-2">
              {s.textBefore}{' '}
              <Link href="/guide" className="font-semibold text-brand underline decoration-brand/40 underline-offset-4 hover:decoration-brand">
                {s.docs}
              </Link>{' '}
              {s.textAfter}
            </p>
          </Reveal>
          <div className="mt-10 grid gap-8 sm:grid-cols-[2fr_1fr]">
            <div>
              <h3 className="mb-4 text-sm font-semibold tracking-wider text-muted uppercase">{s.typesTitle}</h3>
              <div className="grid grid-cols-2 gap-3">
                {s.types.map((type, i) => {
                  const Icon = MESSAGE_TYPE_ICONS[i]!;
                  return (
                    <Reveal key={type.title} delay={i * 60}>
                      <div className="lift card-luxury h-full rounded-2xl border border-line p-4">
                        <p className="flex items-center gap-2.5 font-semibold">
                          <span className="flex size-8 items-center justify-center rounded-xl bg-brand/15 text-brand">
                            <Icon className="size-4" />
                          </span>
                          {type.title}
                        </p>
                        <p className="mt-2 text-xs leading-relaxed text-ink-2">{type.text}</p>
                      </div>
                    </Reveal>
                  );
                })}
              </div>
            </div>
            <div>
              <h3 className="mb-4 text-sm font-semibold tracking-wider text-muted uppercase">{s.recipientsTitle}</h3>
              <div className="grid gap-3">
                {s.recipients.map((r, i) => {
                  const { icon: Icon, tint } = RECIPIENTS[i]!;
                  return (
                    <Reveal key={r.title} delay={i * 80}>
                      <div className="lift card-luxury rounded-2xl border border-line p-4">
                        <p className="flex items-center gap-2.5 font-semibold">
                          <span className={cx('flex size-8 items-center justify-center rounded-xl bg-gradient-to-br text-on-brand shadow-xs', tint)}>
                            <Icon className="size-4" />
                          </span>
                          {r.title}
                        </p>
                        <p className="mt-2 text-xs leading-relaxed text-ink-2">{r.text}</p>
                      </div>
                    </Reveal>
                  );
                })}
              </div>
            </div>
          </div>
          <Reveal>
            <Link href="/register" className={buttonClass('brand', 'lg', 'shine mt-10 h-13 rounded-2xl bg-gradient-to-r from-brand to-teal px-8 text-on-brand')}>
              {s.cta} <Arrow />
            </Link>
          </Reveal>
        </div>
        <Reveal delay={150}>
          <div className="animate-float relative">
            <PhoneMock className="-rotate-2 rtl:rotate-2" />
          </div>
        </Reveal>
      </div>
    </section>
  );
}

function UseCases() {
  const { t } = useI18n();
  const s = t.landing.useCases;
  const tints = ['from-teal to-brand', 'from-brand-strong to-teal', 'from-brand to-brand-deep'];
  return (
    <section className="section-wash py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionIntro eyebrow={s.eyebrow} top={s.top} accent={s.accent} text={s.text} />
        <div className="mt-16 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {s.items.map((u, i) => {
            const Icon = USE_CASE_ICONS[i]!;
            return (
              <Reveal key={u.title} delay={(i % 3) * 100}>
                <article className="lift card-luxury group flex h-full flex-col rounded-3xl border border-line p-7 sm:p-8">
                  <div className="flex items-center justify-between">
                    <span
                      className={cx(
                        'flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br text-on-brand shadow-md transition-transform duration-500 group-hover:-rotate-6 group-hover:scale-110',
                        tints[i % tints.length],
                      )}
                    >
                      <Icon className="size-6" />
                    </span>
                    <span className="ltr font-mono text-xs font-semibold text-faint">0{i + 1}</span>
                  </div>
                  <h3 className="mt-6 text-xl leading-snug font-bold tracking-tight sm:text-2xl">{u.title}</h3>
                  <p className="mt-3 flex-1 leading-relaxed text-ink-2">{u.text}</p>
                </article>
              </Reveal>
            );
          })}
        </div>
        <Reveal className="mt-14 flex justify-center">
          <Link href="/register" className={buttonClass('brand', 'lg', 'shine h-13 rounded-2xl bg-gradient-to-r from-brand to-teal px-8 text-base font-semibold')}>
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
    <section id="pricing" className="section-wash scroll-mt-20 py-24 sm:py-32">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <SectionIntro
          eyebrow={
            <>
              <Sparkles className="size-3.5 text-brand" /> {s.eyebrow}
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
          <div className="card-luxury flex flex-wrap items-center justify-between gap-5 rounded-3xl border border-line p-6 sm:p-8">
            <div className="flex items-center gap-4">
              <span className="flex size-13 items-center justify-center rounded-2xl bg-brand/15 text-brand">
                <Users className="size-6" />
              </span>
              <div>
                <h3 className="text-lg font-bold">{s.higherTitle}</h3>
                <p className="text-sm text-ink-2">{s.higherText}</p>
              </div>
            </div>
            <a href={`mailto:${BRAND.supportEmail}`} className={buttonClass('brand', 'lg', 'rounded-xl')}>
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
    <section id="faq" className="section-wash scroll-mt-20 py-24 sm:py-32">
      <div className="mx-auto max-w-4xl px-4 sm:px-6">
        <SectionIntro eyebrow={s.eyebrow} top={s.top} accent={s.accent} text={s.text} />
        <Reveal className="mt-14">
          <div className="card-luxury space-y-3 rounded-3xl border border-line p-4 sm:p-6">
            {s.items.map((item) => (
              <details
                key={item.q}
                className="group rounded-2xl border border-line bg-surface/40 transition-all open:border-brand/40 open:bg-surface/80 hover:border-line-strong"
              >
                <summary className="flex cursor-pointer list-none items-center gap-4 px-5 py-4 text-base font-semibold sm:text-lg [&::-webkit-details-marker]:hidden">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-brand/15 text-brand transition-colors group-open:bg-brand group-open:text-on-brand">
                    <CircleHelp className="size-4" />
                  </span>
                  <span className="flex-1 text-start">{item.q}</span>
                  <ChevronDown className="size-5 shrink-0 text-muted transition-transform duration-300 group-open:rotate-180 group-open:text-brand" />
                </summary>
                <p className="animate-fade-up px-5 pb-5 ps-[4.25rem] text-sm leading-relaxed text-ink-2 sm:text-base">{item.a}</p>
              </details>
            ))}
          </div>
        </Reveal>
        <div className="mt-12 grid gap-6 sm:grid-cols-2">
          <Reveal className="card-luxury flex flex-col items-center gap-4 rounded-2xl border border-line p-6 text-center">
            <span className="eyebrow">{s.helpEyebrow}</span>
            <a href={`mailto:${BRAND.supportEmail}`} className={buttonClass('white', 'lg', 'h-11 rounded-xl px-6')}>
              {s.helpCta} <Arrow />
            </a>
          </Reveal>
          <Reveal delay={100} className="card-luxury flex flex-col items-center gap-4 rounded-2xl border border-line p-6 text-center">
            <span className="eyebrow">{s.docsEyebrow}</span>
            <Link href="/guide" className={buttonClass('outline', 'lg', 'h-11 rounded-xl px-6')}>
              {s.docsCta} <Arrow />
            </Link>
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
          <div className="card-luxury relative grid items-center gap-12 overflow-hidden rounded-[2rem] border border-brand/30 bg-gradient-to-br from-surface via-card to-brand/10 p-8 sm:p-14 lg:grid-cols-2">
            <div aria-hidden className="hero-grid pointer-events-none absolute inset-0 opacity-60" />
            <div aria-hidden className="animate-glow pointer-events-none absolute -end-24 -bottom-24 size-80 rounded-full bg-brand/15 blur-3xl" />
            <div className="relative z-10">
              <h2 className="text-4xl leading-[1.12] font-bold tracking-tight sm:text-5xl">
                {s.title}
                <br />
                <span className="text-shimmer">{s.accent}</span>
              </h2>
              <p className="mt-5 text-lg leading-relaxed text-ink-2">{s.text}</p>
              <ul className="mt-8 space-y-3.5">
                {s.points.map((text, i) => {
                  const Icon = icons[i]!;
                  return (
                    <li key={text} className="flex items-center gap-3.5 text-base font-medium">
                      <span className="flex size-7 items-center justify-center rounded-full bg-brand text-on-brand shadow-xs">
                        <Icon className="size-3.5" />
                      </span>
                      {text}
                    </li>
                  );
                })}
              </ul>
              <Link
                href="/register"
                className={buttonClass('brand', 'lg', 'shine-auto mt-9 h-13 w-full max-w-md rounded-2xl bg-gradient-to-r from-brand to-teal text-base font-semibold')}
              >
                {s.cta} <Arrow />
              </Link>
              <p className="mt-3 text-xs text-faint">{s.note}</p>
            </div>
            <div className="relative z-10 grid items-end gap-6 sm:grid-cols-2" dir="ltr">
              <div className="rounded-2xl border border-white/10 bg-[#0b0f17] p-5 font-mono text-[12px] leading-6 shadow-2xl">
                <div className="mb-3 flex gap-1.5">
                  <span className="size-2.5 rounded-full bg-[#ff5f57]" />
                  <span className="size-2.5 rounded-full bg-[#febc2e]" />
                  <span className="size-2.5 rounded-full bg-[#28c840]" />
                </div>
                <p className="text-[#569cd6]">
                  await <span className="text-[#dcdcaa]">send</span>
                  <span className="text-white/70">({'{'}</span>
                </p>
                <p className="ps-4 text-white/70">
                  to: <span className="text-[#ce9178]">'+201012345678'</span>,
                </p>
                <p className="ps-4 text-white/70">
                  text: <span className="text-[#ce9178]">'Works like a charm!'</span>
                </p>
                <p className="text-white/70">{'});'}</p>
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

export function SiteFooter() {
  const { t } = useI18n();
  return (
    <footer className="border-t border-line bg-surface/30">
      <div className="mx-auto grid max-w-7xl gap-12 px-4 py-16 sm:px-6 md:grid-cols-[1.4fr_repeat(3,1fr)]">
        <Reveal className="space-y-4">
          <Logo />
          <p className="max-w-xs text-sm leading-relaxed text-ink-2">{t.brand.about}</p>
        </Reveal>
        {t.landing.footer.columns.map((col, c) => (
          <Reveal key={col.title} delay={(c + 1) * 80}>
            <h3 className="text-sm font-bold tracking-wider text-ink uppercase">{col.title}</h3>
            <ul className="mt-4 space-y-3 text-sm">
              {col.links.map((label, i) => (
                <li key={label}>
                  <Link href={FOOTER_HREFS[c]![i]!} className="text-ink-2 transition-colors hover:text-brand">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </Reveal>
        ))}
      </div>
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4 border-t border-line px-4 py-6 text-xs text-faint sm:px-6">
        <p>
          © {new Date().getFullYear()} <span className="ltr font-semibold text-ink-2">{BRAND.name}</span>. {t.landing.footer.rights}
        </p>
        <p className="max-w-2xl">{t.brand.disclaimer}</p>
      </div>
    </footer>
  );
}

export function Landing() {
  return (
    <div className="overflow-x-clip">
      <SiteHeader />
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
      <SiteFooter />
    </div>
  );
}
