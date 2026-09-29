import { createAuthClient } from '@neondatabase/auth';

export const NEON_AUTH_URL = import.meta.env.VITE_NEON_AUTH_URL as string | undefined;
export const neonAuth = NEON_AUTH_URL ? createAuthClient(NEON_AUTH_URL) : null;

/** Fresh JWT (15-min expiry) for API calls; throws when the session is gone. */
export async function neonToken(): Promise<string> {
  if (!neonAuth) throw new Error('Neon Auth is not configured');
  const { data, error } = await neonAuth.token();
  if (error || !data?.token) throw new Error(error?.message ?? 'انتهت الجلسة — سجّل الدخول من جديد');
  return data.token;
}
