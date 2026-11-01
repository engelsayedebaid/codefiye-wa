import type { FastifyRequest } from 'fastify';

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/i;

/** PUBLIC_URL still names this machine (its `http://localhost:4000` default): it wasn't set for this deployment. */
export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK.test(new URL(url).hostname);
  } catch {
    return true;
  }
}

/**
 * The site's public base URL, for links shown to admins (XPay webhook URLs) and given to XPay (the
 * return link after a bank check). PUBLIC_URL wins whenever it names a real host. Left at its
 * localhost default on a deployment, the request's own origin is used instead (Host, or
 * X-Forwarded-Host/-Proto from the proxies TRUST_PROXY trusts) — so production never hands out a
 * localhost link. A forged Host header only changes the links in that caller's own response.
 */
export function publicBaseUrl(configured: string, req: FastifyRequest): string {
  const fallback = configured.replace(/\/+$/, '');
  if (!isLoopbackUrl(configured)) return fallback;
  if (!req.host || LOOPBACK.test(req.hostname)) return fallback;
  return `${req.protocol}://${req.host}`;
}
