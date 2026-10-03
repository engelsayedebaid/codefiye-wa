import { z } from 'zod';

export * from './template-text';

/** Template names are what API callers pass as `template`, so keep them URL- and JSON-friendly. */
export const templateName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Use 1–64 letters, digits, "-" or "_"');

export const templateBody = z.string().trim().min(1).max(4096);

/** Request shape for placeholder values, e.g. `{ "code": "123456", "name": "Sara" }`. */
export const templateVariablesInput = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.union([z.string().max(1024), z.number()]));
