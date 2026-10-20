import type { PaymentDetails, PaymentMethod, PaymentSettings } from '@wa/shared/payments';
import { useQuery } from '@tanstack/react-query';
import { Check, Copy, Landmark, Smartphone, Zap } from '../../icons';
import { type ReactNode, useState } from 'react';
import { api } from '../../api';
import { useI18n } from '../../i18n';
import { qk } from '../../queries';
import { cx } from '../../ui';

/** Each method's look: a glyph and its brand colours (Vodafone red, InstaPay purple, banks blue). */
export const METHOD_LOOK: Record<PaymentMethod, { icon: typeof Smartphone; tint: string; ring: string; soft: string }> = {
  vodafone_cash: { icon: Smartphone, tint: 'bg-[#e60000] text-white', ring: 'border-[#e60000]/50', soft: 'bg-[#e60000]/10 text-[#e60000] light:text-[#c00000]' },
  instapay: { icon: Zap, tint: 'bg-[#6f3fa3] text-white', ring: 'border-[#6f3fa3]/50', soft: 'bg-[#6f3fa3]/10 text-[#9b6ad6] light:text-[#6f3fa3]' },
  bank_transfer: { icon: Landmark, tint: 'bg-sky-600 text-white', ring: 'border-sky-500/50', soft: 'bg-sky-500/10 text-sky-400 light:text-sky-700' },
};

export function MethodGlyph({ method, size = 'md' }: { method: PaymentMethod; size?: 'sm' | 'md' | 'lg' }) {
  const look = METHOD_LOOK[method];
  const dims = { sm: 'size-6 rounded-md [&>svg]:size-3.5', md: 'size-9 rounded-lg [&>svg]:size-4.5', lg: 'size-11 rounded-xl [&>svg]:size-5' }[size];
  return (
    <span className={cx('flex shrink-0 items-center justify-center shadow-sm', dims, look.tint)}>
      <look.icon />
    </span>
  );
}

/** Small coloured chip naming the method. */
export function MethodChip({ method }: { method: PaymentMethod }) {
  const { t } = useI18n();
  const look = METHOD_LOOK[method];
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium', look.soft)}>
      <look.icon className="size-3" />
      {t.subscription.payment.methods[method]}
    </span>
  );
}

/** The admin's receiving accounts (also what the admin page edits). */
export function usePaymentSettings(enabled = true) {
  return useQuery({ queryKey: qk.paymentMethods, queryFn: ({ signal }) => api<PaymentSettings>('/api/payment-methods', { signal }), enabled, staleTime: 5 * 60_000 });
}

/** A value with a copy button, for account numbers the customer transfers to. */
export function CopyLine({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const { t } = useI18n();
  const p = t.subscription.payment;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // selectable anyway
    }
  };
  return (
    <div className="flex items-center gap-2 rounded-lg bg-ink/[0.04] px-3 py-2">
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] text-muted">{label}</span>
        <span className={cx('block truncate text-sm font-semibold select-all', mono && 'ltr font-mono tracking-wide')}>{value}</span>
      </span>
      <button type="button" onClick={copy} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted transition-colors hover:bg-raised hover:text-ink" aria-label={p.copy}>
        {copied ? <Check className="animate-scale-in size-3.5 text-brand" /> : <Copy className="size-3.5" />}
        <span className="hidden sm:inline">{copied ? p.copied : p.copy}</span>
      </button>
    </div>
  );
}

/** What the customer filled in, as label/value rows (shown to the admin and in the pending card). */
export function PaymentDetailsRows({ payment, className }: { payment: PaymentDetails; className?: string }) {
  const { t } = useI18n();
  const r = t.admin.requests;
  const p = t.subscription.payment;
  const rows: [string, ReactNode][] = [];
  if (payment.method === 'vodafone_cash') rows.push([r.sender, <span className="ltr font-mono">{payment.senderPhone}</span>]);
  if (payment.method === 'instapay') rows.push([r.sender, <span className="ltr font-mono">{payment.sender}</span>]);
  if (payment.method === 'bank_transfer') {
    rows.push([r.sender, <bdi>{payment.senderName}</bdi>]);
    if (payment.bankName) rows.push([r.bank, <bdi>{payment.bankName}</bdi>]);
    if (payment.reference) rows.push([r.reference, <span className="ltr font-mono">{payment.reference}</span>]);
  }
  if (payment.amount) rows.push([r.amount, p.egp(payment.amount)]);
  return (
    <dl className={cx('grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm', className)}>
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="min-w-0 truncate font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const MAX_SIDE = 1600;

/**
 * Shrinks a screenshot before upload (phones produce 3–8 MB images; the API takes 2 MB): longest
 * side ≤ 1600 px, re-encoded as JPEG. Returns the base64 body and a preview URL.
 */
export async function shrinkImage(file: File): Promise<{ mimetype: 'image/jpeg'; data: string; previewUrl: string; bytes: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  // Screenshots with transparency land on white, not black.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let quality = 0.85;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  // Dense screenshots can still be big: step the quality down until it fits comfortably.
  while (dataUrl.length > 1.6 * 1024 * 1024 && quality > 0.5) {
    quality -= 0.1;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }
  const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return { mimetype: 'image/jpeg', data, previewUrl: dataUrl, bytes: Math.floor((data.length * 3) / 4) };
}
