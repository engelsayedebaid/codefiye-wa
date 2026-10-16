import { Ban, ChevronDown, Eye, LockKeyhole, Mail, ShieldCheck } from 'lucide-react';
import { BRAND } from '../brand';
import { useI18n } from '../i18n';
import { delay, Reveal } from '../ui';
import { SiteFooter, SiteHeader } from './Landing';

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

  const toc = (
    <ol className="space-y-1 text-sm">
      {p.sections.map((s, i) => (
        <li key={s.id}>
          <a href={`#${s.id}`} className="flex gap-2 rounded-md px-2.5 py-1.5 text-ink-2 transition-colors hover:bg-raised hover:text-ink">
            <span className="w-5 shrink-0 text-faint tabular-nums">{i + 1}.</span>
            <span>{s.title}</span>
          </a>
        </li>
      ))}
      <li>
        <a href="#contact" className="flex gap-2 rounded-md px-2.5 py-1.5 text-ink-2 transition-colors hover:bg-raised hover:text-ink">
          <span className="w-5 shrink-0 text-faint tabular-nums">{p.sections.length + 1}.</span>
          <span>{p.contactTitle}</span>
        </a>
      </li>
    </ol>
  );

  return (
    <div className="page-wash min-h-svh">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 pt-12 pb-20 sm:px-6 sm:pt-16">
        <header className="animate-fade-up mx-auto max-w-3xl text-center">
          <span className="eyebrow">
            <span className="size-1.5 rounded-full bg-brand" />
            {p.eyebrow}
          </span>
          <h1 className="mt-5 text-4xl font-bold tracking-tight text-balance sm:text-5xl">{p.title}</h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg text-ink-2">{p.lead}</p>
          <p className="mt-3 text-sm text-muted">
            {p.updatedLabel}: <span className="text-ink-2">{p.updated}</span>
          </p>
        </header>

        <ul className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {p.highlights.map((h, i) => {
            const Icon = HIGHLIGHT_ICONS[i] ?? ShieldCheck;
            return (
              <li key={h.title} className="animate-fade-up rounded-2xl border border-line bg-card p-5 shadow-sm" style={delay(100 + i * 60)}>
                <span className="flex size-10 items-center justify-center rounded-xl bg-brand/12 text-brand">
                  <Icon className="size-5" />
                </span>
                <h2 className="mt-4 font-semibold">{h.title}</h2>
                <p className="mt-1.5 text-sm text-muted">{h.text}</p>
              </li>
            );
          })}
        </ul>

        <div className="mt-14 grid gap-10 lg:grid-cols-[230px_minmax(0,1fr)]">
          <aside className="hidden lg:block">
            <nav aria-label={p.tocTitle} className="sticky top-28">
              <p className="mb-2 px-2.5 text-xs font-semibold text-muted uppercase">{p.tocTitle}</p>
              {toc}
            </nav>
          </aside>

          <article className="min-w-0 max-w-3xl">
            {/* Phones and tablets: the contents fold away above the text instead of a side column. */}
            <details className="group mb-10 rounded-xl border border-line bg-card lg:hidden">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
                {p.tocTitle}
                <ChevronDown className="size-4 text-muted transition-transform group-open:rotate-180" />
              </summary>
              <nav aria-label={p.tocTitle} className="border-t border-line p-2">
                {toc}
              </nav>
            </details>

            <div className="space-y-12">
              {p.sections.map((s, i) => (
                <Reveal key={s.id}>
                  <section id={s.id} className="scroll-mt-28">
                    <h2 className="flex gap-3 text-xl font-bold sm:text-2xl">
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
                <section id="contact" className="scroll-mt-28 rounded-2xl border border-line bg-card p-6 shadow-sm">
                  <h2 className="flex gap-3 text-xl font-bold sm:text-2xl">
                    <span className="text-brand tabular-nums">{p.sections.length + 1}.</span>
                    <span>{p.contactTitle}</span>
                  </h2>
                  <p className="mt-3 text-ink-2">{p.contactText}</p>
                  <a href={`mailto:${BRAND.supportEmail}`} className="ltr mt-3 inline-flex max-w-full items-center gap-2 font-semibold break-all text-brand hover:underline">
                    <Mail className="size-4 shrink-0" />
                    {BRAND.supportEmail}
                  </a>
                </section>
              </Reveal>
            </div>
          </article>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
