import { z } from 'zod';

const optional = z
  .string()
  .optional()
  .transform((v) => (v?.trim() ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_UNPOOLED: z.string().optional(),
  WORKER_SECRET: z.string().min(16),
  /** Railway and most PaaS set PORT; API_PORT is the local default. */
  PORT: z.coerce.number().int().positive().optional(),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_HOST: z.string().default('0.0.0.0'),
  /** Comma-separated origins allowed to call the API from a browser with a bearer key. */
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  PUBLIC_URL: z.string().default('http://localhost:4000'),
  /** Built dashboard to serve at `/` (optional; in dev the Vite server is used instead). */
  DASHBOARD_DIST: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  /**
   * Which proxies may set X-Forwarded-For: a hop count (1 = the platform's edge proxy), `true`/`false`,
   * or comma-separated addresses/CIDRs. Trusting every hop would let clients forge their IP.
   */
  TRUST_PROXY: z.string().default('1'),
  /** Session cookie `Secure` flag: `auto` = when the request arrived over HTTPS. */
  COOKIE_SECURE: z.enum(['auto', 'true', 'false']).default('auto'),

  // --- phone verification (docs/HARDENING.md §3.3); credentials live here only, never in the dashboard
  OTP_CHANNEL: z.enum(['sms', 'whatsapp']).optional(),
  /** HMAC key for stored codes (≥32 chars). Defaults to a key derived from WORKER_SECRET. */
  OTP_SECRET: z.string().min(32).optional(),
  /** `whatsapp` channel: the connected session codes are sent from. */
  OTP_WHATSAPP_SESSION_ID: z.uuid().optional(),
  /** `sms` channel: Twilio Programmable Messaging. TWILIO_FROM is a number or a Messaging Service SID (MG…). */
  TWILIO_ACCOUNT_SID: optional,
  TWILIO_AUTH_TOKEN: optional,
  TWILIO_FROM: optional,
  /** Platform-wide cap on verification codes sent per 24h (abuse brake). */
  OTP_DAILY_LIMIT: z.coerce.number().int().positive().default(1000),
});

export type Config = z.infer<typeof schema> & {
  port: number;
  corsOrigins: string[];
  trustProxy: boolean | number | string;
};

function parseTrustProxy(value: string): boolean | number | string {
  const v = value.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false' || v === '') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return value.trim();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.parse(env);
  return {
    ...parsed,
    port: parsed.PORT ?? parsed.API_PORT,
    corsOrigins: parsed.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: parseTrustProxy(parsed.TRUST_PROXY),
  };
}
