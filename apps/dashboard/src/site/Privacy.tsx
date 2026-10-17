import { Ban, CalendarDays, Eye, LockKeyhole, Mail, ShieldCheck } from 'lucide-react';
import { BRAND } from '../brand';
import { useI18n } from '../i18n';
import { delay, Reveal } from '../ui';
import { SiteFooter, SiteHeader } from './SiteChrome';
import { TocAside, TocFold, useActiveSection } from './TocNav';

const HIGHLIGHT_ICONS = [ShieldCheck, Eye, LockKeyhole, Ban];

/** A list item written as "Label: text" shows its label in bold. */
function Item({ text }: { text: string }) {
  const at = text.indexOf(':');
  if (at <= 0 || at > 60) return <li>{text}</li>;
  return (
    <li>
      <span className="font-semibold text-ink">{text.slice(0, at + 1)}</span>
      {text.slice(at + 1)}
    </li>
  );
}

export function PrivacyPage() {
  const { t } = useI18n();
  const p = t.privacy;
  const toc = [...p.sections.map((s) => ({ id: s.id, label: s.title })), { id: 'contact', label: p.contactTitle }];
  const active = useActiveSection(toc.map((item) => item.id));

  return (
    <div className="min-h-svh overflow-x-clip">
      <SiteHeader />
      <main id="main">
        <header className="relative isolate overflow-hidden border-b border-line">
          <div aria-hidden className="hero-aura absolute inset-0 -z-10" />
          <div aria-hidden className="site-grid absolute inset-0 -z-10" />
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
            <p className="kicker animate-fade-up">{p.eyebrow}</p>
            <h1 className="animate-fade-up mt-4 text-4xl font-semibold tracking-tight text-balance sm:text-5xl" style={delay(60)}>
              {p.title}
            </h1>
            <p className="animate-fade-up mt-5 max-w-2xl text-lg leading-relaxed text-muted" style={delay(120)}>
              {p.lead}
            </p>
            <p className="animate-fade-up mt-7 inline-flex items-center gap-2 rounded-full border border-line bg-card/70 px-3.5 py-1.5 text-xs text-muted" style={delay(180)}>
              <CalendarDays className="size-3.5" />
              {p.updatedLabel}: <span className="font-medium text-ink-2">{p.updated}</span>
            </p>
          </div>
        </header>

        <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 sm:py-16 lg:px-8">
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {p.highlights.map((h, i) => {
              const Icon = HIGHLIGHT_ICONS[i] ?? ShieldCheck;
              return (
                <li key={h.title} className="site-card animate-fade-up rounded-2xl p-5" style={delay(120 + i * 60)}>
                  <span className="flex size-10 items-center justify-center rounded-xl bg-brand/10 text-brand ring-1 ring-brand/20">
                    <Icon className="size-5" />
                  </span>
                  <h2 className="mt-4 font-semibold">{h.title}</h2>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{h.text}</p>
                </li>
              );
            })}
          </ul>

          <div className="mt-16 grid gap-10 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-16">
            <TocAside title={p.tocTitle} items={toc} active={active} numbered />

            <article className="max-w-3xl min-w-0">
              <TocFold title={p.tocTitle} items={toc} active={active} numbered className="mb-10" />
              <div className="space-y-14">
                {p.sections.map((s, i) => (
                  <Reveal key={s.id}>
                    <section id={s.id} className="scroll-mt-24">
                      <h2 className="flex gap-3 text-xl font-semibold sm:text-2xl">
                        <span className="text-brand tabular-nums">{i + 1}.</span>
                        <span>{s.title}</span>
                      </h2>
                      <div className="mt-4 space-y-4 leading-relaxed text-ink-2">
                        {s.body.map((block, b) =>
                          typeof block === 'string' ? (
                            <p key={b}>{block}</p>
                          ) : (
                            <ul key={b} className="list-disc space-y-2.5 ps-5 marker:text-brand">
                              {block.map((item) => (
                                <Item key={item} text={item} />
                              ))}
                            </ul>
                          ),
                        )}
                      </div>
                    </section>
                  </Reveal>
                ))}

                <Reveal>
                  <section id="contact" className="site-card scroll-mt-24 rounded-2xl p-6 sm:p-8">
                    <h2 className="flex gap-3 text-xl font-semibold sm:text-2xl">
                      <span className="text-brand tabular-nums">{p.sections.length + 1}.</span>
                      <span>{p.contactTitle}</span>
                    </h2>
                    <p className="mt-3 text-ink-2">{p.contactText}</p>
                    <a href={`mailto:${BRAND.supportEmail}`} className="ltr mt-4 inline-flex max-w-full items-center gap-2 font-semibold break-all text-brand hover:underline">
                      <Mail className="size-4 shrink-0" />
                      {BRAND.supportEmail}
                    </a>
                  </section>
                </Reveal>
              </div>
            </article>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
