import { z } from 'zod';
import { PAYMENT_MONTHS, type PaymentDetails, type PaymentSettings } from './payments';

const egyptianMobile = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s-]/g, '').replace(/^\+?2/, ''))
  .pipe(z.string().regex(/^01[0125]\d{8}$/, 'Enter an Egyptian mobile number (01xxxxxxxxx)'));

const amount = z.number().positive().max(1_000_000).optional();

export const paymentMonthsSchema = z.union(PAYMENT_MONTHS.map((n) => z.literal(n)) as [z.ZodLiteral<1>, z.ZodLiteral<3>, z.ZodLiteral<6>, z.ZodLiteral<12>]);

export const paymentDetailsSchema: z.ZodType<PaymentDetails, unknown> = z.discriminatedUnion('method', [
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
