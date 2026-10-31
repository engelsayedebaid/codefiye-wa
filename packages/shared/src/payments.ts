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
  /**
   * Paid online through XPay (recorded by the platform, never sent by customers). `test`: paid with test
   * keys. `review`: why the payment didn't pass the amount/order checks and waits for an admin.
   */
  | { method: 'xpay'; sessionId: string; paymentId?: string; amount?: number; test?: boolean; review?: string[] };

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

/**
 * XPay keeps Test and Live apart (own keys, own webhook endpoint and secret, own data); so do we. The
 * admin picks the active mode; there is never a fallback from one to the other.
 */
export const XPAY_MODES = ['test', 'live'] as const;
export type XPayMode = (typeof XPAY_MODES)[number];

/** What the dashboard needs to open XPay's checkout (`GET /api/payments/xpay`). */
export type XPayPublicConfig = {
  /**
   * On = this caller pays online through XPay (and the manual transfers are hidden). Live mode: everyone;
   * test mode: admins only, so test cards can't buy real plans.
   */
  enabled: boolean;
  publishableKey: string;
  mode: XPayMode;
};

/** One mode's account as the admin sees it: secrets only as a masked hint. */
export type XPayModeView = {
  /** `pk_test_…` / `pk_live_…` */
  publishableKey: string;
  /** e.g. `sk_live_••••a1b2`; null when not saved. */
  secretKeyHint: string | null;
  /** e.g. `whsec_••••9f3c`; null when not saved. */
  webhookSecretHint: string | null;
  /** A secret is stored but can't be opened (AUTH_ENCRYPTION_KEY changed): enter it again. */
  unreadable: boolean;
  /** Where XPay must post this mode's events (XPay → Developers → Webhooks, in the same mode). */
  webhookUrl: string;
  /** Last successful connection test (ISO), and the last failure since then. */
  validatedAt: string | null;
  validationError: XPayConnectionError | null;
  /** Last event with a valid signature (ISO): proves the webhook secret and URL work. */
  lastWebhookAt: string | null;
};

/** The admin's XPay configuration (`GET /api/admin/xpay`). */
export type XPaySettings = {
  enabled: boolean;
  mode: XPayMode;
  methods: XPayMethod[];
  test: XPayModeView;
  live: XPayModeView;
  /** AUTH_ENCRYPTION_KEY is set: without it no secret can be stored or read, and XPay stays off. */
  encryptionReady: boolean;
};

/** One mode's keys to save; blank or missing secrets keep the stored ones. */
export type XPayModeInput = { publishableKey?: string; secretKey?: string; webhookSecret?: string; clear?: boolean };

/** What the admin saves (`PUT /api/admin/xpay`). */
export type XPaySettingsInput = {
  enabled: boolean;
  mode: XPayMode;
  methods: XPayMethod[];
  test?: XPayModeInput;
  live?: XPayModeInput;
  /** Required to switch live payments on (the dashboard asks for confirmation first). */
  confirmLive?: boolean;
};

export type XPayConnectionError = 'invalid_key' | 'forbidden' | 'wrong_mode' | 'unreachable' | 'unexpected' | 'missing_key';

/** A key belongs to a mode by its prefix: `pk_test_…`, `sk_live_…`. */
export const keyMode = (key: string): XPayMode | null => (/^(pk|sk)_test_/.test(key) ? 'test' : /^(pk|sk)_live_/.test(key) ? 'live' : null);

/** A mode is complete with a publishable key of that mode, a secret key and the webhook secret. */
export function xpayModeComplete(v: Pick<XPayModeView, 'publishableKey' | 'secretKeyHint' | 'webhookSecretHint' | 'unreadable'>, mode: XPayMode): boolean {
  return keyMode(v.publishableKey) === mode && v.secretKeyHint !== null && v.webhookSecretHint !== null && !v.unreadable;
}

/** XPay takes payments once switched on with the active mode complete and at least one method. */
export function xpayReady(s: Pick<XPaySettings, 'enabled' | 'mode' | 'methods' | 'test' | 'live' | 'encryptionReady'>): boolean {
  return s.enabled && s.encryptionReady && s.methods.length > 0 && xpayModeComplete(s[s.mode], s.mode);
}

/** Customers (not only admins) pay through XPay: live mode, ready. */
export const xpayLiveForCustomers = (s: Parameters<typeof xpayReady>[0]) => s.mode === 'live' && xpayReady(s);

/** Test keys charge nothing; the admin page and the payment popup say so. */
export const isTestKey = (key: string) => keyMode(key) === 'test';

/**
 * `review`: XPay reports it paid but it failed our amount/order checks: no plan was activated and an
 * admin decides (it shows as a pending plan request). `refunded`: refunded in XPay after it was paid.
 */
export const ONLINE_PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'review', 'refunded'] as const;
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
