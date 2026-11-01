import type { ReactNode } from 'react';
import { useCurrencyRates } from '../../currency';
import { Lock, ShieldCheck, TrendingUp } from '../../icons';
import { useI18n } from '../../i18n';
import { cx } from '../../ui';

/** Kashier's name as a wordmark, after "Secured by": the checkout is theirs, and customers know the name. */
export function KashierMark({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <span className={cx('ltr inline-flex items-baseline gap-1.5 text-xs text-muted', className)}>
      {t.subscription.payment.online.securedBy}
      <span className="text-sm font-bold tracking-tight text-brand">Kashier</span>
    </span>
  );
}

/** The card schemes Kashier takes in Egypt, as small marks (their colours; no artwork of theirs is shipped). */
export function CardMarks({ className }: { className?: string }) {
  const { t } = useI18n();
  const pill = 'flex h-6 items-center rounded-[5px] border border-black/10 bg-white px-1.5 shadow-sm';
  return (
    <span className={cx('ltr inline-flex items-center gap-1.5', className)} aria-label={t.subscription.payment.online.cards}>
      <span className={pill} title="Visa">
        <span className="text-[11px] leading-none font-black tracking-tight text-[#1a1f71] italic">VISA</span>
      </span>
      <span className={cx(pill, 'gap-0')} title="Mastercard">
        <span className="size-3.5 rounded-full bg-[#eb001b]" />
        <span className="-ms-1.5 size-3.5 rounded-full bg-[#f79e1b] opacity-90" />
      </span>
      <span className={pill} title="Meeza">
        <span className="text-[10px] leading-none font-extrabold tracking-tight text-[#5b2d90]">meeza</span>
      </span>
    </span>
  );
}

/** What protects the payment, as short facts: encryption, 3-D Secure, PCI DSS through Kashier, no card data kept. */
export function TrustStrip({ className, marks = true }: { className?: string; marks?: boolean }) {
  const { t } = useI18n();
  const o = t.subscription.payment.online;
  const items: [ReactNode, string][] = [
    [<Lock key="ssl" className="size-3.5" />, o.trust.ssl],
    [<ShieldCheck key="3ds" className="size-3.5" />, o.trust.threeDs],
    [<ShieldCheck key="pci" className="size-3.5" />, o.trust.pci],
  ];
  return (
    <div className={cx('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-line/70 bg-raised/20 px-3.5 py-2.5', className)}>
      <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] font-medium text-muted">
        {items.map(([icon, label]) => (
          <li key={label} className="flex items-center gap-1.5">
            <span className="text-brand">{icon}</span>
            {label}
          </li>
        ))}
      </ul>
      <span className="flex items-center gap-3">
        {marks && <CardMarks />}
        <KashierMark />
      </span>
    </div>
  );
}

/** The EGP rate behind every price in the popup: live market rate (with its source and age), or the platform's floor. */
export function RateLine({ className }: { className?: string }) {
  const { t, fmt } = useI18n();
  const o = t.subscription.payment.online;
  const egp = useCurrencyRates().data?.egp;
  if (!egp || egp.effective <= 0) return null;
  const rate = egp.effective.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const live = !egp.floored && egp.live !== null;
  const source = egp.source ? t.currency.fxSources[egp.source] : null;
  return (
    <p className={cx('flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted', className)}>
      <TrendingUp className="size-3.5 shrink-0 text-brand" />
      <span>{live ? o.rateLive(rate, egp.liveAt ? fmt.timeAgo(egp.liveAt) : '') : o.rateFixed(rate)}</span>
      {live && source && (
        <span className="text-faint">
          ·{' '}
          {egp.source === 'exchangerate-api' ? (
            <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
              {o.rateSource(source)}
            </a>
          ) : (
            o.rateSource(source)
          )}
        </span>
      )}
    </p>
  );
}
