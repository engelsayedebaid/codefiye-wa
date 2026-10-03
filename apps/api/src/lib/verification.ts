import { randomUUID } from 'node:crypto';
import type { TxSql, VerificationPurpose } from '@wa/db';
import { asciiDigits, maskPhoneNumber } from '@wa/shared';
import type { Deps } from '../deps';
import { notFound, tooMany, unavailable, unprocessable } from './errors';
import { generateOtp, hashOtp, OTP_POLICY, OtpDeliveryError, otpMatches, otpText } from './otp';
import { getOtpTexts } from './otp-text';
import type { Rule } from './throttle';

export type Lang = 'ar' | 'en';

export type VerificationRow = {
  id: string;
  purpose: VerificationPurpose;
  user_id: string | null;
  phone: string;
  email: string | null;
  name: string | null;
  password_hash: string | null;
  lang: string;
  code_hash: string;
  attempts: number;
  sends: number;
};

/** What the client gets after a code was sent: enough to show "sent to +20•••678, resend in 60s". */
export type VerificationTicket = { verificationId: string; phone: string; channel: string; expiresAt: string; resendAfter: number };

const gone = () => notFound('This verification has expired or was already used. Start again.', 'verification_not_found');

/** A typed-in code: Arabic-Indic digits become ASCII, separators are ignored. */
export const normalizeCode = (code: string) => asciiDigits(code).replace(/[\s-]/g, '');

/**
 * Phone verification by one-time code (docs/HARDENING.md §3.3): only an HMAC of the code is
 * stored; codes expire, allow a few guesses, can be resent after a cooldown, and every send is
 * rate-limited per number, per IP and platform-wide.
 */
export function createVerifications({ sql, otp, throttle }: Pick<Deps, 'sql' | 'otp' | 'throttle'>) {
  const sendRules = (phone: string, ip: string): Rule[] => [
    { key: `otp:phone:${phone}`, limit: 5, windowSec: 3600 },
    { key: `otp:phone-day:${phone}`, limit: 10, windowSec: 86_400 },
    { key: `otp:ip:${ip}`, limit: 10, windowSec: 3600 },
    { key: 'otp:global-day', limit: otp.dailyLimit, windowSec: 86_400 },
  ];

  const ticket = (id: string, phone: string, expiresAt: Date): VerificationTicket => ({
    verificationId: id,
    phone: maskPhoneNumber(phone),
    channel: otp.sender?.channel ?? 'none',
    expiresAt: expiresAt.toISOString(),
    resendAfter: OTP_POLICY.resendCooldownSec,
  });

  function sender() {
    if (!otp.sender) throw unavailable('Phone verification is temporarily unavailable. Please try again later.', 'otp_unavailable');
    return otp.sender;
  }

  async function deliver(phone: string, code: string, lang: string) {
    const custom = (await getOtpTexts(sql))[lang === 'en' ? 'en' : 'ar'];
    try {
      await sender().send(phone, otpText(code, lang, custom));
    } catch (err) {
      if (err instanceof OtpDeliveryError && err.kind === 'recipient') {
        throw unprocessable('We could not send a code to this number', { phone: ['This number cannot receive the code. Check it and try again.'] }, { code: 'phone_unreachable' });
      }
      throw unavailable('Could not send the verification code right now. Please try again shortly.', 'otp_unavailable');
    }
  }

  return {
    /**
     * Sends a code to `phone` and records the verification. `details` runs after the rate limits
     * pass (e.g. hashing the signup password), so a throttled request costs nothing.
     */
    async start(input: {
      purpose: VerificationPurpose;
      phone: string;
      lang: Lang;
      ip: string;
      userId?: string;
      details?: () => Promise<{ email: string; name: string; passwordHash: string }>;
    }): Promise<VerificationTicket> {
      sender();
      await throttle.consume(sendRules(input.phone, input.ip), 'Too many verification codes requested. Try again later.');
      const extra = input.details ? await input.details() : null;
      const id = randomUUID();
      const code = generateOtp();
      const [row] = await sql<{ expires_at: Date }[]>`
        insert into phone_verifications (id, purpose, user_id, phone, email, name, password_hash, lang, code_hash, expires_at, ip)
        values (${id}, ${input.purpose}, ${input.userId ?? null}, ${input.phone}, ${extra?.email ?? null}, ${extra?.name ?? null},
                ${extra?.passwordHash ?? null}, ${input.lang}, ${hashOtp(otp.key, id, code)},
                now() + make_interval(secs => ${OTP_POLICY.ttlSec}), ${input.ip})
        returning expires_at`;
      try {
        await deliver(input.phone, code, input.lang);
      } catch (err) {
        await sql`delete from phone_verifications where id = ${id}`.catch(() => {});
        throw err;
      }
      return ticket(id, input.phone, row!.expires_at);
    },

    /** A new code for the same verification, after the cooldown and within the send budget. */
    async resend(id: string, ip: string, scope: { purpose: VerificationPurpose; userId?: string }): Promise<VerificationTicket> {
      sender();
      const [row] = await sql<(VerificationRow & { wait: number })[]>`
        select id, phone, lang, sends,
          ceil(extract(epoch from last_sent_at + make_interval(secs => ${OTP_POLICY.resendCooldownSec}) - now()))::int as wait
        from phone_verifications
        where id = ${id} and purpose = ${scope.purpose} and consumed_at is null
          and created_at > now() - make_interval(secs => ${OTP_POLICY.lifetimeSec})
          ${scope.userId ? sql`and user_id = ${scope.userId}` : sql``}`;
      if (!row) throw gone();
      if (row.wait > 0) throw tooMany('Wait a little before requesting another code.', row.wait, 'resend_cooldown');
      if (row.sends >= OTP_POLICY.maxSends) throw tooMany('Too many codes requested for this verification. Start again later.', 3600, 'too_many_sends');
      await throttle.consume(sendRules(row.phone, ip), 'Too many verification codes requested. Try again later.');
      const code = generateOtp();
      // The cooldown condition makes concurrent resends of the same verification send only once.
      const [updated] = await sql<{ expires_at: Date }[]>`
        update phone_verifications
        set code_hash = ${hashOtp(otp.key, id, code)}, attempts = 0, sends = sends + 1, last_sent_at = now(),
          expires_at = now() + make_interval(secs => ${OTP_POLICY.ttlSec})
        where id = ${id} and consumed_at is null and last_sent_at <= now() - make_interval(secs => ${OTP_POLICY.resendCooldownSec})
        returning expires_at`;
      if (!updated) throw tooMany('Wait a little before requesting another code.', OTP_POLICY.resendCooldownSec, 'resend_cooldown');
      await deliver(row.phone, code, row.lang);
      return ticket(id, row.phone, updated.expires_at);
    },

    /**
     * Checks a code and, when it matches, runs `onVerified` in the transaction that consumes the
     * verification — if it throws, nothing is consumed. Each check spends one attempt up front, so
     * parallel guesses can't exceed the budget.
     */
    async confirm<T>(
      id: string,
      rawCode: string,
      ip: string,
      scope: { purpose: VerificationPurpose; userId?: string },
      onVerified: (row: VerificationRow, tx: TxSql) => Promise<T>,
    ): Promise<T> {
      await throttle.consume([{ key: `verify:ip:${ip}`, limit: 30, windowSec: 3600 }], 'Too many attempts. Try again later.');
      const code = normalizeCode(rawCode);
      const userFilter = scope.userId ? sql`and user_id = ${scope.userId}` : sql``;
      const [row] = await sql<(VerificationRow & { expired: boolean })[]>`
        update phone_verifications set attempts = attempts + 1
        where id = ${id} and purpose = ${scope.purpose} and consumed_at is null and attempts < ${OTP_POLICY.maxAttempts}
          and created_at > now() - make_interval(secs => ${OTP_POLICY.lifetimeSec}) ${userFilter}
        returning id, purpose, user_id, phone, email, name, password_hash, lang, code_hash, attempts, sends, expires_at <= now() as expired`;
      if (!row) {
        const [spent] = await sql`
          select 1 from phone_verifications
          where id = ${id} and purpose = ${scope.purpose} and consumed_at is null and attempts >= ${OTP_POLICY.maxAttempts} ${userFilter}`;
        if (spent) throw tooMany('Too many incorrect codes. Request a new code.', OTP_POLICY.resendCooldownSec, 'too_many_attempts');
        throw gone();
      }
      if (row.expired) throw unprocessable('This code has expired. Request a new one.', { code: ['The code has expired'] }, { code: 'code_expired' });
      if (!/^\d{6}$/.test(code) || !otpMatches(otp.key, id, code, row.code_hash)) {
        const attemptsLeft = OTP_POLICY.maxAttempts - row.attempts;
        throw unprocessable('The code is incorrect', { code: ['Incorrect code'] }, { code: 'code_invalid', details: { attemptsLeft } });
      }
      return sql.begin(async (tx) => {
        const [consumed] = await tx`update phone_verifications set consumed_at = now() where id = ${id} and consumed_at is null returning id`;
        if (!consumed) throw gone();
        return onVerified(row, tx);
      }) as Promise<T>;
    },
  };
}

export type Verifications = ReturnType<typeof createVerifications>;
