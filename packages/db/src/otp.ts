import type { Sql } from './client';

export type OtpSealRow = {
  id: string;
  delivery_ciphertext: Buffer | null;
  expires_at: Date;
  verify_status: string;
  delivery_status: string;
  send_started: boolean;
};

/** Drops queued OTP messages whose validity window has closed. Does not send them. */
export async function expireQueuedOtp(sql: Sql, sessionId: string): Promise<string[]> {
  const rows = await sql<{ id: string; otp_challenge_id: string }[]>`
    update messages set status = 'failed', error = 'OTP expired before it could be sent', updated_at = now()
    where session_id = ${sessionId} and status = 'queued' and otp_challenge_id is not null and expires_at <= now()
    returning id::text as id, otp_challenge_id`;
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.otp_challenge_id);
  await sql`
    update otp_challenges
    set delivery_status = 'expired', verify_status = case when verify_status = 'open' then 'expired' else verify_status end,
      delivery_ciphertext = null, failure = 'expired', updated_at = now()
    where id = any(${ids}::uuid[]) and delivery_status in ('queued', 'processing')`;
  return ids;
}

export async function loadOtpSeal(sql: Sql, challengeId: string): Promise<OtpSealRow | null> {
  const [row] = await sql<OtpSealRow[]>`
    select id, delivery_ciphertext, expires_at, verify_status, delivery_status, send_started
    from otp_challenges where id = ${challengeId}`;
  return row ?? null;
}

/** Called immediately before provider.send. A later crash is uncertain, not a silent retry. */
export async function markOtpSendStarted(sql: Sql, challengeId: string): Promise<void> {
  await sql`
    update otp_challenges
    set send_started = true, delivery_status = 'processing', updated_at = now()
    where id = ${challengeId} and delivery_status in ('queued', 'processing', 'failed')`;
}

export async function finishOtpDelivery(sql: Sql, challengeId: string, status: 'sent' | 'failed' | 'expired' | 'uncertain', failure: string | null): Promise<void> {
  await sql`
    update otp_challenges
    set delivery_status = ${status},
      verify_status = case
        when ${status} = 'expired' and verify_status = 'open' then 'expired'
        else verify_status end,
      delivery_ciphertext = case when ${status} in ('sent', 'expired', 'uncertain') then null else delivery_ciphertext end,
      failure = ${failure},
      updated_at = now()
    where id = ${challengeId} and delivery_status not in ('delivered', 'verified')`;
}

/** Receipts move sent → delivered. They never revive a failed or uncertain challenge. */
export async function noteOtpReceipt(sql: Sql, messageId: number, status: 'sent' | 'delivered' | 'read'): Promise<void> {
  if (status === 'sent') return;
  await sql`
    update otp_challenges
    set delivery_status = 'delivered', updated_at = now()
    where message_id = ${messageId} and delivery_status = 'sent'`;
}

/** Interrupted `sending` OTP rows may have reached WhatsApp. Do not queue them again. */
export async function markInterruptedOtpUncertain(sql: Sql, messageIds: number[]): Promise<void> {
  if (messageIds.length === 0) return;
  await sql`
    update otp_challenges
    set delivery_status = 'uncertain', delivery_ciphertext = null, failure = 'interrupted', updated_at = now()
    where message_id = any(${messageIds}::bigint[]) and delivery_status in ('queued', 'processing', 'sent')`;
}
