/**
 * How a customer pays for a plan. Each method asks for different details in the dashboard's
 * payment popup, and the admin configures where the money goes (`PaymentSettings`).
 * Zod-free so the dashboard can import it; the schemas live in `payments-schema.ts`.
 */
export const PAYMENT_METHODS = ['vodafone_cash', 'instapay', 'bank_transfer'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Subscription lengths a customer can pay for at once. */
export const PAYMENT_MONTHS = [1, 3, 6, 12] as const;
export type PaymentMonths = (typeof PAYMENT_MONTHS)[number];

/** What the customer fills in, per method (sent with the plan request). */
export type PaymentDetails =
  | { method: 'vodafone_cash'; senderPhone: string; amount?: number }
  /** `sender`: the sender's mobile number or InstaPay address (e.g. `name@instapay`). */
  | { method: 'instapay'; sender: string; amount?: number }
  | { method: 'bank_transfer'; senderName: string; bankName?: string; reference?: string; amount?: number };

/** The admin's receiving accounts, shown to customers in the payment popup. */
export type PaymentSettings = {
  /** Price conversion for the amount shown in the popup (plans are priced in USD). */
  egpPerUsd: number;
  vodafone_cash: { enabled: boolean; number: string; name: string };
  instapay: { enabled: boolean; address: string; name: string };
  bank_transfer: { enabled: boolean; bankName: string; accountName: string; accountNumber: string; iban: string };
  /** Free text under the methods, e.g. "send the screenshot within an hour". */
  instructions: string;
};

export const DEFAULT_PAYMENT_SETTINGS: PaymentSettings = {
  egpPerUsd: 50,
  vodafone_cash: { enabled: false, number: '', name: '' },
  instapay: { enabled: false, address: '', name: '' },
  bank_transfer: { enabled: false, bankName: '', accountName: '', accountNumber: '', iban: '' },
  instructions: '',
};

/** Methods the admin switched on with their details filled in — the only ones customers may pick. */
export function enabledPaymentMethods(s: PaymentSettings): PaymentMethod[] {
  return PAYMENT_METHODS.filter((m) => {
    if (m === 'vodafone_cash') return s.vodafone_cash.enabled && s.vodafone_cash.number !== '';
    if (m === 'instapay') return s.instapay.enabled && s.instapay.address !== '';
    return s.bank_transfer.enabled && (s.bank_transfer.accountNumber !== '' || s.bank_transfer.iban !== '');
  });
}

/** Screenshot of the transfer: small images only (the dashboard shrinks them before upload). */
export const PROOF_MIMETYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const PROOF_MAX_BYTES = 2 * 1024 * 1024;

/** What a plan costs for `months`, in EGP, rounded to whole pounds. Null for custom-priced plans. */
export function planPriceEgp(priceUsd: number | null, months: number, egpPerUsd: number): number | null {
  if (priceUsd === null) return null;
  return Math.round(priceUsd * months * egpPerUsd);
}
