import { z } from 'zod';
import { PAYMENT_MONTHS, type PaymentDetails, type PaymentSettings, type TransferDetails, XPAY_CONNECTION_ERRORS, XPAY_METHODS, XPAY_MODES, type XPayMode, type XPayModeInput, type XPayModeView, type XPaySettings, type XPaySettingsInput } from './payments';

const egyptianMobile = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, '').replace(/^\+?2/, ''))
  .pipe(z.string().regex(/^01[0125]\d{8}$/, 'Enter an Egyptian mobile number (01xxxxxxxxx)'));

const amount = z.number().positive().max(1_000_000).optional();

export const paymentMonthsSchema = z.union(PAYMENT_MONTHS.map((n) => z.literal(n)) as [z.ZodLiteral<1>, z.ZodLiteral<3>, z.ZodLiteral<6>, z.ZodLiteral<12>]);

export const paymentDetailsSchema: z.ZodType<TransferDetails, unknown> =z.discriminatedUnion('method', [
  z.object({ method: z.literal('vodafone_cash'), senderPhone: egyptianMobile, amount }),
  z.object({
    method: z.literal('instapay'),
    sender: z
      .string()
      .trim()
      .min(3)
      .max(80)
      .regex(/^(\+?2?01[0125]\d{8}|[\w.-]{3,40}@[\w.-]{2,30})$/i, 'Enter a mobile number or an InstaPay address like name@instapay'),
    amount,
  }),
  z.object({
    method: z.literal('bank_transfer'),
    senderName: z.string().trim().min(2).max(120),
    bankName: z.string().trim().max(80).optional(),
    reference: z.string().trim().max(80).optional(),
    amount,
  }),
]);

/**
 * Stored payment details, for responses. Fastify serializes responses with `z.encode`, which throws on the
 * one-way transforms of `paymentDetailsSchema` (and stored rows shouldn't be re-validated against input rules).
 */
export const paymentDetailsDto: z.ZodType<PaymentDetails> = z.discriminatedUnion('method', [
  z.object({ method: z.literal('vodafone_cash'), senderPhone: z.string(), amount: z.number().optional() }),
  z.object({ method: z.literal('instapay'), sender: z.string(), amount: z.number().optional() }),
  z.object({
    method: z.literal('bank_transfer'),
    senderName: z.string(),
    bankName: z.string().optional(),
    reference: z.string().optional(),
    amount: z.number().optional(),
  }),
  z.object({
    method: z.literal('xpay'),
    sessionId: z.string(),
    paymentId: z.string().optional(),
    amount: z.number().optional(),
    test: z.boolean().optional(),
    review: z.array(z.string()).optional(),
  }),
]);

export const paymentSettingsSchema: z.ZodType<PaymentSettings> = z.object({
  egpPerUsd: z.number().positive().max(1_000),
  vodafone_cash: z.object({ enabled: z.boolean(), number: z.string().trim().max(20), name: z.string().trim().max(120) }),
  instapay: z.object({ enabled: z.boolean(), address: z.string().trim().max(120), name: z.string().trim().max(120) }),
  bank_transfer: z.object({
    enabled: z.boolean(),
    bankName: z.string().trim().max(80),
    accountName: z.string().trim().max(120),
    accountNumber: z.string().trim().max(60),
    iban: z.string().trim().max(40),
  }),
  instructions: z.string().trim().max(500),
});

const xpayMethods = z.array(z.enum(XPAY_METHODS)).max(XPAY_METHODS.length);

const connectionErrors = z.enum(XPAY_CONNECTION_ERRORS);

const capabilities = z.object({ accountName: z.string().nullable(), methods: z.array(z.enum(XPAY_METHODS)), applePayOnWebsite: z.boolean(), livePaymentsEnabled: z.boolean() });

const modeView: z.ZodType<XPayModeView> = z.object({
  publishableKey: z.string(),
  secretKeyHint: z.string().nullable(),
  webhookSecretHint: z.string().nullable(),
  unreadable: z.boolean(),
  webhookUrl: z.string(),
  validatedAt: z.string().nullable(),
  validationError: connectionErrors.nullable(),
  lastWebhookAt: z.string().nullable(),
  capabilities: capabilities.nullable(),
});

export const xpaySettingsDto: z.ZodType<XPaySettings> = z.object({
  enabled: z.boolean(),
  mode: z.enum(XPAY_MODES),
  methods: xpayMethods,
  test: modeView,
  live: modeView,
  encryptionReady: z.boolean(),
});

const blankOr = (re: RegExp, message: string) => z.string().trim().max(300).refine((s) => s === '' || re.test(s), message).optional();

/** Each mode takes only its own keys: a live key pasted into Test (or the reverse) is refused. */
const modeInput = (mode: XPayMode): z.ZodType<XPayModeInput> =>
  z.object({
    publishableKey: blankOr(new RegExp(`^pk_${mode}_\\w+$`), `Paste the ${mode} publishable key (pk_${mode}_…)`),
    secretKey: blankOr(new RegExp(`^sk_${mode}_\\w+$`), `Paste the ${mode} secret key (sk_${mode}_…)`),
    webhookSecret: blankOr(/^whsec_\w+$/, 'Paste the webhook signing secret (whsec_…)'),
    clear: z.boolean().optional(),
  });

export const xpaySettingsInputSchema: z.ZodType<XPaySettingsInput> = z.object({
  enabled: z.boolean(),
  mode: z.enum(XPAY_MODES),
  methods: xpayMethods,
  test: modeInput('test').optional(),
  live: modeInput('live').optional(),
  confirmLive: z.boolean().optional(),
});
