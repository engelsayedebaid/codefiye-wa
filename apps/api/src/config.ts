const num = (v: string | undefined, d: number) => (v ? Number(v) : d);

export const config = {
  port: num(process.env.PORT ?? process.env.API_PORT, 4000),
  host: process.env.API_HOST ?? '0.0.0.0',
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'http://localhost:4000'),
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  rpcTimeoutMs: 15_000,
  /** Emails that get the platform admin console (server-enforced). Comma-separated. */
  adminEmails: new Set((process.env.PLATFORM_ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)),
};
