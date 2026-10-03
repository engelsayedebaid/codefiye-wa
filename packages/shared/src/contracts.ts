import { z } from 'zod';

/** README §6 — fixed response contract from day one. */
export type ApiSuccess<T> = { success: true; data: T };
/**
 * `code` is a stable machine-readable reason (`validation_failed`, `rate_limited`, `account_suspended`, …);
 * `details` carries extra facts for it (e.g. `retryAfter`, `attemptsLeft`); `requestId` is set on server
 * errors so a report can be matched to the logs. All three are additive to the original contract.
 */
export type ApiFailure = {
  success: false;
  message: string;
  code?: string;
  errors?: Record<string, string[]>;
  details?: Record<string, unknown>;
  requestId?: string;
};

export const ok = <T>(data: T): ApiSuccess<T> => ({ success: true, data });

export const successSchema = <T extends z.ZodType>(data: T) => z.object({ success: z.literal(true), data });

export const errorSchema = z.object({
  success: z.literal(false),
  message: z.string(),
  code: z.string().optional(),
  errors: z.record(z.string(), z.array(z.string())).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  requestId: z.string().optional(),
});
