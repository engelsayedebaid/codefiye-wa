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
  | { method: 'bank_transfer'; senderName: string; bankName?: string; reference?: string; amount?: number }
  /** Paid online through XPay (recorded by the platform, never sent by customers). */
  | { method: 'xpay'; sessionId: string; paymentId?: string; amount?: number };

/** Every way a plan can be paid: the manual transfers above, plus XPay. */
export type PaidMethod = PaymentDetails['method'];

/** What a customer sends with a manual plan request. */
export type TransferDetails = Extract<PaymentDetails, { method: PaymentMethod }>;

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

/** XPay methods a checkout may offer (each must be switched on in the XPay account too). */
export const XPAY_METHODS = ['card', 'apple_pay', 'valu', 'fawry'] as const;
export type XPayMethod = (typeof XPAY_METHODS)[number];

/** What the dashboard needs to open XPay's checkout (`GET /api/payments/xpay`). */
export type XPayPublicConfig = {
  /** On = customers pay online through XPay and the manual transfers are hidden. */
  enabled: boolean;
  publishableKey: string;
};

/** The admin's XPay account. The secrets are write-only: responses only say whether they are set. */
export type XPaySettings = {
  enabled: boolean;
  /** `pk_test_…` / `pk_live_…` */
  publishableKey: string;
  methods: XPayMethod[];
  hasSecretKey: boolean;
  hasWebhookSecret: boolean;
  /** The endpoint to add in XPay → Developers → Webhooks. */
  webhookUrl: string;
};

/** What the admin saves; a blank or missing secret keeps the stored one. */
export type XPaySettingsInput = {
  enabled: boolean;
  publishableKey: string;
  methods: XPayMethod[];
  /** `sk_test_…` / `sk_live_…` */
  secretKey?: string;
  /** `whsec_…` */
  webhookSecret?: string;
};

/** XPay is usable once switched on with both keys, the webhook secret and at least one method. */
export function xpayReady(s: Pick<XPaySettings, 'enabled' | 'publishableKey' | 'methods' | 'hasSecretKey' | 'hasWebhookSecret'>): boolean {
  return s.enabled && s.publishableKey !== '' && s.methods.length > 0 && s.hasSecretKey && s.hasWebhookSecret;
}

/** Test keys charge nothing; the admin page and the payment popup say so. */
export const isTestKey = (key: string) => /^(pk|sk)_test_/.test(key);

export const ONLINE_PAYMENT_STATUSES = ['pending', 'paid', 'failed'] as const;
export type OnlinePaymentStatus = (typeof ONLINE_PAYMENT_STATUSES)[number];

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
