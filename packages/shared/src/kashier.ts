/**
 * Kashier (Egypt) online payments: Payment Sessions with Kashier's hosted checkout. Test and Live are
 * fully separate (own hosts, own Merchant ID, Secret Key and Payment API Key, own webhook endpoint),
 * and a payment is only ever handled with the credentials of the mode it was opened in.
 * Zod-free so the dashboard can import it; the schemas live in `kashier-schema.ts`.
 * https://developers.kashier.io/docs
 */

export const KASHIER_MODES = ['test', 'live'] as const;
export type KashierMode = (typeof KASHIER_MODES)[number];

/**
 * Checkout methods, by Kashier's method names (`GET /v2/constants/payment-method-definition`,
 * `allowedMethods`). Meeza is a card brand and Apple Pay a card-side wallet, so both come with `card`
 * (Apple Pay only once enabled on the merchant account); `wallet` is Egypt's mobile wallets (Vodafone
 * Cash and the other R2P wallets). Fawry isn't routed by Kashier today and InstaPay isn't offered on
 * the hosted checkout, so neither is listed. A method shows only when the merchant account has it.
 */
export const KASHIER_METHODS = ['card', 'wallet', 'bank_installments', 'valu', 'souhoola', 'aman', 'contact'] as const;
export type KashierMethod = (typeof KASHIER_METHODS)[number];

/** Buy-now-pay-later providers: requested in `allowedMethods` as `bnpl[<provider>]`. */
export const KASHIER_BNPL: readonly KashierMethod[] = ['valu', 'souhoola', 'aman', 'contact'];

/** At most this many test-mode accounts besides the admins. */
export const KASHIER_MAX_TESTERS = 50;

/** What the dashboard needs to offer the Kashier checkout (`GET /api/payments/kashier`). */
export type KashierPublicConfig = {
  /** This caller pays online: live mode for everyone; test mode for admins and listed test accounts only. */
  enabled: boolean;
  mode: KashierMode;
  /** What the customer can pick from before leaving for Kashier (empty when off). */
  methods: KashierMethod[];
};

export const KASHIER_CONNECTION_ERRORS = ['invalid_secret_key', 'invalid_api_key', 'invalid_merchant', 'forbidden', 'wrong_mode', 'unreachable', 'unexpected', 'missing_key'] as const;
export type KashierConnectionError = (typeof KASHIER_CONNECTION_ERRORS)[number];

/** One mode's account as the admin sees it: secrets only as masked hints. */
export type KashierModeView = {
  /** `MID-…` */
  merchantId: string;
  /** e.g. `••••a1b2`; null when not saved. */
  secretKeyHint: string | null;
  apiKeyHint: string | null;
  /** A key is stored but can't be opened (AUTH_ENCRYPTION_KEY changed): enter it again. */
  unreadable: boolean;
  /** Where Kashier posts this mode's events (also sent with every payment as `serverWebhook`). */
  webhookUrl: string;
  /** Last passing connection test (ISO), and the last failure since then. */
  validatedAt: string | null;
  validationError: KashierConnectionError | null;
  /** Kashier couldn't confirm the Payment API Key through its API; the first signed webhook does. */
  apiKeyUnconfirmed: boolean;
  /** Last webhook with a valid signature (ISO): proves the Payment API Key and the URL work. */
  lastWebhookAt: string | null;
  /** Methods the merchant account has in this mode (`GET /v2/merchants/{mid}/paymentMethods`); null until a test. */
  accountMethods: KashierMethod[] | null;
};

/** The admin's Kashier configuration (`GET /api/admin/kashier`). */
export type KashierSettings = {
  enabled: boolean;
  mode: KashierMode;
  methods: KashierMethod[];
  test: KashierModeView;
  live: KashierModeView;
  /** AUTH_ENCRYPTION_KEY is set: without it no key can be stored or read, and Kashier stays off. */
  encryptionReady: boolean;
  /** Accounts (by email) allowed to pay in test mode besides the admins. */
  testers: string[];
};

/** One mode's credentials to save; blank or missing secrets keep the stored ones. */
export type KashierModeInput = { merchantId?: string; secretKey?: string; apiKey?: string; clear?: boolean };

/** What the admin saves (`PUT /api/admin/kashier`). */
export type KashierSettingsInput = {
  enabled: boolean;
  mode: KashierMode;
  methods: KashierMethod[];
  test?: KashierModeInput;
  live?: KashierModeInput;
  /** Required to switch live payments on (the dashboard asks for confirmation first). */
  confirmLive?: boolean;
  /** Replaces the test-mode allow list when given. */
  testers?: string[];
};

/** A mode is complete with its Merchant ID and both keys, readable. */
export function kashierModeComplete(v: Pick<KashierModeView, 'merchantId' | 'secretKeyHint' | 'apiKeyHint' | 'unreadable'>): boolean {
  return /^MID-[\w-]+$/i.test(v.merchantId) && v.secretKeyHint !== null && v.apiKeyHint !== null && !v.unreadable;
}

/** What a checkout of this mode offers: the admin's choice, narrowed to the account's methods once known. */
export function kashierAvailableMethods(selected: readonly KashierMethod[], accountMethods: readonly KashierMethod[] | null): KashierMethod[] {
  return accountMethods ? selected.filter((m) => accountMethods.includes(m)) : [...selected];
}

/** Kashier takes payments once switched on with the active mode complete and at least one method its account has. */
export function kashierReady(s: Pick<KashierSettings, 'enabled' | 'mode' | 'methods' | 'test' | 'live' | 'encryptionReady'>): boolean {
  const active = s[s.mode];
  return s.enabled && s.encryptionReady && kashierModeComplete(active) && kashierAvailableMethods(s.methods, active.accountMethods).length > 0;
}

/** Customers (not only admins and testers) pay through Kashier: live mode, ready. */
export const kashierLiveForCustomers = (s: Parameters<typeof kashierReady>[0]) => s.mode === 'live' && kashierReady(s);
