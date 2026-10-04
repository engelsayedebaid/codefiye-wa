import { createHmac, hkdfSync, randomInt, timingSafeEqual } from 'node:crypto';
import type { Logger } from 'pino';
import type { WorkerClient } from './workers';
import { ApiError } from './errors';

/** Verification policy (docs/HARDENING.md §3.3). */
export const OTP_POLICY = {
  length: 6,
  /** A code is valid this long after it was sent. */
  ttlSec: 10 * 60,
  /** Wrong guesses allowed per code; a resend issues a new code and a new budget. */
  maxAttempts: 5,
  /** Minimum gap between two sends of the same verification. */
  resendCooldownSec: 60,
  /** Sends per verification, including the first. */
  maxSends: 5,
  /** A verification can be resent for this long after it started; then the flow restarts. */
  lifetimeSec: 60 * 60,
} as const;

export const generateOtp = () => String(randomInt(0, 10 ** OTP_POLICY.length)).padStart(OTP_POLICY.length, '0');

/** HMAC key for stored codes: OTP_SECRET, or derived from WORKER_SECRET so a fresh install works without one more secret. */
export function otpKey(otpSecret: string | undefined, workerSecret: string): Buffer {
  if (otpSecret) return Buffer.from(otpSecret);
  return Buffer.from(hkdfSync('sha256', workerSecret, 'wa-platform', 'otp-hmac-v1', 32));
}

/** Only this is stored: an HMAC bound to the verification id, so a leaked table can't be matched against codes offline without the key. */
export const hashOtp = (key: Buffer, verificationId: string, code: string) => createHmac('sha256', key).update(`${verificationId}:${code}`).digest('base64url');

export function otpMatches(key: Buffer, verificationId: string, code: string, stored: string): boolean {
  const actual = Buffer.from(hashOtp(key, verificationId, code));
  const expected = Buffer.from(stored);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Fallback texts; admins can override per language in `settings` (`otp_text`). `{{code}}` and `{{minutes}}` placeholders. */
export const OTP_DEFAULT_TEXTS = {
  ar: 'رمز التحقق الخاص بك في WA CodeFiye هو: {{code}}\nصالح لمدة {{minutes}} دقائق. لا تشاركه مع أي شخص.',
  en: "Your WA CodeFiye verification code is: {{code}}\nIt expires in {{minutes}} minutes. Don't share it with anyone.",
} as const;

const MINUTES_RE = /\{\{\s*minutes\s*\}\}/g;
const CODE_RE = /\{\{\s*code\s*\}\}/g;

export const otpText = (code: string, lang: string, custom?: string | null) => {
  const template = custom?.trim() || (lang === 'en' ? OTP_DEFAULT_TEXTS.en : OTP_DEFAULT_TEXTS.ar);
  return template.replace(CODE_RE, code).replace(MINUTES_RE, String(OTP_POLICY.ttlSec / 60));
};

/** Delivery failed. `recipient`: the number can't receive it (wrong number, not on WhatsApp); otherwise the channel is down. */
export class OtpDeliveryError extends Error {
  constructor(
    readonly kind: 'recipient' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'OtpDeliveryError';
  }
}

export type OtpSender = {
  channel: string;
  /** `phone` is E.164. Must not log `text`: it contains the code. */
  send(phone: string, text: string): Promise<void>;
};

/** Twilio Programmable Messaging over its REST API (no SDK). */
export function twilioSender(options: { accountSid: string; authToken: string; from: string; logger: Logger }): OtpSender {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(options.accountSid)}/Messages.json`;
  const auth = `Basic ${Buffer.from(`${options.accountSid}:${options.authToken}`).toString('base64')}`;
  return {
    channel: 'sms',
    async send(phone, text) {
      const form = new URLSearchParams({ To: phone, Body: text });
      form.set(options.from.startsWith('MG') ? 'MessagingServiceSid' : 'From', options.from);
      let res: Response;
      try {
        res = await fetch(url, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' }, body: form, signal: AbortSignal.timeout(10_000) });
      } catch (err) {
        options.logger.error({ err: (err as Error).message }, 'sms provider unreachable');
        throw new OtpDeliveryError('unavailable', 'SMS provider is unreachable');
      }
      if (res.ok) return;
      const body = (await res.json().catch(() => ({}))) as { code?: number };
      options.logger.warn({ status: res.status, twilioCode: body.code }, 'sms send rejected');
      // 21211/21614/21408/21610: invalid, non-mobile, unsupported region or opted-out number.
      if (res.status === 400 && [21211, 21614, 21408, 21610].includes(body.code ?? 0)) throw new OtpDeliveryError('recipient', 'This number cannot receive SMS');
      throw new OtpDeliveryError('unavailable', 'SMS provider rejected the request');
    },
  };
}

/** Sends from a connected WhatsApp session of this platform, straight through its worker (never queued in `messages`). */
export function whatsappSender(workers: WorkerClient, sessionId: string, logger?: Logger): OtpSender {
  return {
    channel: 'whatsapp',
    async send(phone, text) {
      try {
        await workers.call(sessionId, 'send-text', { to: phone.replace(/^\+/, ''), text });
      } catch (err) {
        if (err instanceof ApiError && err.statusCode === 422) throw new OtpDeliveryError('recipient', 'This number is not on WhatsApp');
        // e.g. session_not_running, or worker_unreachable when the owning worker is not on the API's network.
        logger?.warn({ sessionId, code: err instanceof ApiError ? err.code : undefined, err: err instanceof ApiError ? undefined : err }, 'whatsapp otp send failed');
        throw new OtpDeliveryError('unavailable', 'WhatsApp verification sender is unavailable');
      }
    },
  };
}
