import type { ReactNode } from 'react';
import { ArrowRight, Check } from '../icons';
import { Link } from '../router';
import { flip } from '../ui';

interface FeatureAccessProps {
  icon: ReactNode;
  title: string;
  description: string;
  featuresLabel: string;
  features: readonly string[];
  upgradeLabel?: string;
}

export function FeatureAccess({ icon, title, description, featuresLabel, features, upgradeLabel }: FeatureAccessProps) {
  return (
    <section className="animate-fade-up grid overflow-hidden rounded-2xl border border-line bg-card shadow-sm lg:grid-cols-[1.1fr_1fr]">
      <div className="relative isolate flex flex-col items-start overflow-hidden bg-[#10382b] p-6 text-white sm:p-9">
        <svg aria-hidden="true" viewBox="0 0 240 200" fill="none" className="pointer-events-none absolute -end-12 -bottom-16 -z-10 w-64 text-[#9ce0b6]/15 rtl:-scale-x-100">
          {[32, 52, 72, 92, 112, 132, 152].map((r) => <circle key={r} cx="160" cy="160" r={r} stroke="currentColor" />)}
        </svg>
        <span className="mb-6 grid size-12 place-items-center rounded-2xl border border-white/15 bg-white/5 text-[#aee8c4]">{icon}</span>
        <h2 className="max-w-lg text-2xl leading-snug font-semibold tracking-tight sm:text-3xl">{title}</h2>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-[#c9dfd1]">{description}</p>
        {upgradeLabel && (
          <Link href="/subscription" className="mt-7 inline-flex min-h-10 items-center gap-2 rounded-full bg-[#c2f5d3] px-5 py-2 text-sm font-semibold text-[#10382b] transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-4">
            {upgradeLabel} <ArrowRight className={`size-4 ${flip}`} />
          </Link>
        )}
      </div>
      <div className="self-center p-6 sm:p-9">
        <h3 className="mb-3 text-base font-semibold text-ink">{featuresLabel}</h3>
        <ul className="divide-y divide-line">
          {features.map((feature) => (
            <li key={feature} className="flex items-start gap-3 py-3 text-sm leading-relaxed text-ink-2">
              <span className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-brand/10 text-brand"><Check className="size-3.5" /></span>
              {feature}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
