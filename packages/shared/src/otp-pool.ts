/**
 * OTP sender pools: eligibility and resend policy. No I/O.
 * Session choice prefers the sender that can finish before the code expires.
 * It does not rotate numbers to hide automation or to move a restricted send.
 */

export const OTP_PURPOSES = ['login', 'register', 'verify', 'reset', 'transaction'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export const OTP_DELIVERY_STATUSES = ['queued', 'processing', 'sent', 'delivered', 'failed', 'expired', 'uncertain'] as const;
export type OtpDeliveryStatus = (typeof OTP_DELIVERY_STATUSES)[number];

export const OTP_VERIFY_STATUSES = ['open', 'verified', 'expired', 'locked'] as const;
export type OtpVerifyStatus = (typeof OTP_VERIFY_STATUSES)[number];

/** Assumed Baileys service time when a session has no measured average yet. Not a provider guarantee. */
export const OTP_DEFAULT_SEND_MS = 2_000;

/** How long a WhatsApp restriction (error 463) keeps a session out of new OTP jobs. */
export const OTP_RESTRICTION_MS = 24 * 60 * 60 * 1000;

export type OtpPlanLimits = {
  pools: number;
  sessionsPerPool: number;
  /** Null = no daily admission cap (internal unlimited plan). */
  daily: number | null;
  /** Queued + in-flight OTP jobs allowed on one session. */
  queuePerSession: number;
};

const OTP_LIMITS: Record<string, OtpPlanLimits> = {
  trial: { pools: 1, sessionsPerPool: 1, daily: 50, queuePerSession: 20 },
  basic: { pools: 1, sessionsPerPool: 1, daily: 300, queuePerSession: 30 },
  pro: { pools: 2, sessionsPerPool: 3, daily: 1_000, queuePerSession: 40 },
  plus: { pools: 3, sessionsPerPool: 6, daily: 3_000, queuePerSession: 40 },
  business: { pools: 5, sessionsPerPool: 10, daily: 8_000, queuePerSession: 40 },
  enterprise: { pools: 10, sessionsPerPool: 25, daily: 20_000, queuePerSession: 60 },
  unlimited: { pools: 100, sessionsPerPool: 100, daily: null, queuePerSession: 80 },
};

export function otpPlanLimits(planId: string): OtpPlanLimits {
  return OTP_LIMITS[planId] ?? OTP_LIMITS.trial!;
}

export type OtpSenderCandidate = {
  sessionId: string;
  enabled: boolean;
  membership: 'active' | 'draining';
  connected: boolean;
  restricted: boolean;
  queued: number;
  inFlight: number;
  avgSendMs: number;
  lastAssignedAt: number | null;
};

export type OtpChoice = { sessionId: string; waitMs: number };

/**
 * Picks one eligible session. Among sessions that can finish inside the remaining TTL,
 * the smallest projected wait wins. Ties go to the session that has been idle longer.
 */
export function chooseOtpSession(candidates: OtpSenderCandidate[], opts: { ttlRemainingMs: number; maxQueue: number }): OtpChoice | null {
  const eligible = candidates.filter((c) => {
    if (!c.enabled || c.membership !== 'active' || !c.connected || c.restricted) return false;
    const depth = c.queued + c.inFlight;
    if (depth >= opts.maxQueue) return false;
    const waitMs = (depth + 1) * Math.max(1, c.avgSendMs);
    return waitMs <= opts.ttlRemainingMs;
  });
  if (eligible.length === 0) return null;
  eligible.sort((a, b) => {
    const wa = (a.queued + a.inFlight + 1) * a.avgSendMs;
    const wb = (b.queued + b.inFlight + 1) * b.avgSendMs;
    if (wa !== wb) return wa - wb;
    const la = a.lastAssignedAt ?? 0;
    const lb = b.lastAssignedAt ?? 0;
    if (la !== lb) return la - lb;
    return a.sessionId < b.sessionId ? -1 : 1;
  });
  const pick = eligible[0]!;
  return { sessionId: pick.sessionId, waitMs: (pick.queued + pick.inFlight + 1) * pick.avgSendMs };
}

export type ResendDecision =
  | { action: 'replay'; sessionId: string }
  | { action: 'reroute' }
  | { action: 'reject'; code: 'uncertain_delivery' | 'in_flight' | 'consumed' | 'expired' | 'cooldown' | 'too_many_sends' | 'session_restricted' | 'locked' };

/**
 * Whether an existing challenge may be sent again.
 * A restricted session is not replaced. An uncertain delivery is not replayed.
 * Reroute is only offered when sending never started.
 */
export function decideResend(input: {
  verifyStatus: OtpVerifyStatus;
  deliveryStatus: OtpDeliveryStatus;
  sendStarted: boolean;
  sends: number;
  maxSends: number;
  lastSentAtMs: number;
  cooldownSec: number;
  expiresAtMs: number;
  nowMs: number;
  sessionRestricted: boolean;
  sessionId: string | null;
}): ResendDecision {
  if (input.verifyStatus === 'verified' || input.verifyStatus === 'expired') return { action: 'reject', code: input.verifyStatus === 'verified' ? 'consumed' : 'expired' };
  if (input.verifyStatus === 'locked') return { action: 'reject', code: 'locked' };
  if (input.expiresAtMs <= input.nowMs) return { action: 'reject', code: 'expired' };
  if (input.sends >= input.maxSends) return { action: 'reject', code: 'too_many_sends' };
  if (input.nowMs < input.lastSentAtMs + input.cooldownSec * 1000) return { action: 'reject', code: 'cooldown' };
  if (input.deliveryStatus === 'uncertain') return { action: 'reject', code: 'uncertain_delivery' };
  if (input.deliveryStatus === 'queued' || input.deliveryStatus === 'processing') return { action: 'reject', code: 'in_flight' };
  if (input.sessionRestricted) return { action: 'reject', code: 'session_restricted' };
  if (!input.sendStarted && (input.deliveryStatus === 'failed' || input.deliveryStatus === 'expired')) return { action: 'reroute' };
  if (!input.sessionId) return { action: 'reject', code: 'session_restricted' };
  return { action: 'replay', sessionId: input.sessionId };
}

export function formatOtpMessage(code: string, lang: string, ttlSeconds: number): string {
  const minutes = Math.max(1, Math.round(ttlSeconds / 60));
  if (lang === 'en') return `Your verification code is ${code}. It expires in ${minutes} minutes. Don't share it.`;
  return `رمز التحقق هو ${code}. ينتهي خلال ${minutes} دقائق. لا تشاركه مع أي شخص.`;
}

/** Safe retry hint in seconds for a full session, based on the projected wait. */
export function retryAfterSeconds(waitMs: number): number {
  return Math.max(1, Math.ceil(waitMs / 1000));
}
