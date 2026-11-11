import type { ReactNode } from 'react';
import { useCurrencyRates } from '../../currency';
import { Lock, ShieldCheck, TrendingUp } from '../../icons';
import { useI18n } from '../../i18n';
import { cx } from '../../ui';

/** Kashier's name as a wordmark, after "Secured by": the checkout is theirs, and customers know the name. */
export function KashierMark({ className }: { className?: string }) {
  const { t } = useI18n();
  return (
    <span className={cx('inline-flex items-center gap-1.5 text-xs text-muted', className)}>
      <span>{t.subscription.payment.online.poweredByKashier}</span>
      <span className="ltr inline-flex items-center gap-1 font-bold tracking-tight text-ink">
        <ShieldCheck className="size-3.5 text-brand" />
        <span>Kashier</span>
      </span>
    </span>
  );
}

/** The card schemes Kashier takes in Egypt, as small marks (their colours; no artwork of theirs is shipped). */
export function CardMarks({ activeBrand, className }: { activeBrand?: 'visa' | 'mastercard' | 'meeza' | null; className?: string }) {
  const { t } = useI18n();
  const base = 'flex h-5.5 items-center rounded-[5px] border border-black/10 bg-white px-1.5 shadow-2xs transition-opacity';
  const dim = (scheme: 'visa' | 'mastercard' | 'meeza') => (activeBrand && activeBrand !== scheme ? 'opacity-35' : 'opacity-100');
  return (
    <span className={cx('ltr inline-flex items-center gap-1', className)} aria-label={t.subscription.payment.online.cards}>
      <span className={cx(base, dim('visa'))} title="Visa">
        <span className="text-[10px] leading-none font-black tracking-tight text-[#1a1f71] italic">VISA</span>
      </span>
      <span className={cx(base, 'gap-0 px-1', dim('mastercard'))} title="Mastercard">
        <span className="size-3 rounded-full bg-[#eb001b]" />
        <span className="-ms-1 size-3 rounded-full bg-[#f79e1b] opacity-90" />
      </span>
      <span className={cx(base, dim('meeza'))} title="Meeza">
        <span className="text-[9.5px] leading-none font-extrabold tracking-tight text-[#5b2d90]">meeza</span>
      </span>
    </span>
  );
}

/** Unobtrusive security and provider footer at the bottom of the checkout form. */
export function PaymentSecurityFooter({ className, showKashier = true }: { className?: string; showKashier?: boolean }) {
  const { t } = useI18n();
  const l = t.legal;
  const linkClass = 'underline decoration-line-strong underline-offset-3 transition-colors hover:text-ink';
  return (
    <footer className={cx('space-y-2.5 pt-2 text-center', className)}>
      {showKashier && (
        <div className="flex items-center justify-center">
          <KashierMark />
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-muted">
        {l.payAgree.lead}{' '}
        <a href="/terms" target="_blank" rel="noreferrer" className={linkClass}>
          {l.terms}
        </a>
        {l.payAgree.and}
        <a href="/refund" target="_blank" rel="noreferrer" className={linkClass}>
          {l.refund}
        </a>
        {' · '}
        <a href="/privacy" target="_blank" rel="noreferrer" className={linkClass}>
          {l.privacy}
        </a>
        {l.payAgree.tail}
      </p>
    </footer>
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
    <div className={cx('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-line/70 bg-raised/30 px-3.5 py-2.5', className)}>
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
    <p className={cx('rate-line flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted', className)}>
      <TrendingUp className="size-3.5 shrink-0 text-brand" />
      <span>{live ? o.rateLive(rate, egp.liveAt ? fmt.timeAgo(egp.liveAt) : '') : o.rateFixed(rate)}</span>
      {live && source && (
        <span className="opacity-75">
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
