import { z } from 'zod';
import {
  KASHIER_CONNECTION_ERRORS,
  KASHIER_MAX_TESTERS,
  KASHIER_METHODS,
  KASHIER_MODES,
  type KashierModeInput,
  type KashierModeView,
  type KashierSettings,
  type KashierSettingsInput,
} from './kashier';

const methods = z.array(z.enum(KASHIER_METHODS)).max(KASHIER_METHODS.length);

const modeView: z.ZodType<KashierModeView> = z.object({
  merchantId: z.string(),
  secretKeyHint: z.string().nullable(),
  apiKeyHint: z.string().nullable(),
  unreadable: z.boolean(),
  webhookUrl: z.string(),
  validatedAt: z.string().nullable(),
  validationError: z.enum(KASHIER_CONNECTION_ERRORS).nullable(),
  apiKeyUnconfirmed: z.boolean(),
  lastWebhookAt: z.string().nullable(),
  accountMethods: z.array(z.enum(KASHIER_METHODS)).nullable(),
});

export const kashierSettingsDto: z.ZodType<KashierSettings> = z.object({
  enabled: z.boolean(),
  mode: z.enum(KASHIER_MODES),
  methods,
  test: modeView,
  live: modeView,
  encryptionReady: z.boolean(),
  testers: z.array(z.string()),
});

const secret = (label: string) =>
  z
    .string()
    .trim()
    .max(400)
    .refine((s) => s === '' || /^[\x21-\x7e]{8,}$/.test(s), `Paste the whole ${label}`)
    .optional();

const modeInput: z.ZodType<KashierModeInput> = z.object({
  merchantId: z
    .string()
    .trim()
    .max(60)
    .refine((s) => s === '' || /^MID-[\w-]+$/i.test(s), 'Paste the Merchant ID (MID-…)')
    .optional(),
  secretKey: secret('Secret Key'),
  apiKey: secret('Payment API Key'),
  clear: z.boolean().optional(),
});

export const kashierSettingsInputSchema: z.ZodType<KashierSettingsInput> = z.object({
  enabled: z.boolean(),
  mode: z.enum(KASHIER_MODES),
  methods,
  test: modeInput.optional(),
  live: modeInput.optional(),
  confirmLive: z.boolean().optional(),
  testers: z.array(z.string().trim().toLowerCase().max(254).pipe(z.email())).max(KASHIER_MAX_TESTERS).optional(),
});
