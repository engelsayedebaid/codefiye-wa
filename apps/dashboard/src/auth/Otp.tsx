import { asciiDigits, normalizePhone } from '@wa/shared/phone';
import { useQueryClient } from '@tanstack/react-query';
import { MessageSquareText, RotateCw } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import { useI18n } from '../i18n';
import type { Dict } from '../i18n/ar';
import { qk } from '../queries';
import { Button, ErrorNote, Field, Modal, SuccessNote } from '../ui';

/** What the API returns after sending a code. */
export type Ticket = { verificationId: string; phone: string; channel: string; expiresAt: string; resendAfter: number };

/** The user's words for a failed code check or resend. `restart`: the verification is gone, go back to the details. */
export function codeError(err: unknown, t: Dict): { message: string; restart?: boolean } {
  const v = t.auth.verify;
  if (err instanceof ApiRequestError) {
    switch (err.code) {
      case 'code_invalid':
        return { message: v.wrongCode(Number(err.details?.attemptsLeft ?? 0)) };
      case 'code_expired':
        return { message: v.expired };
      case 'too_many_attempts':
        return { message: v.tooManyAttempts };
      case 'verification_not_found':
        return { message: v.restart, restart: true };
      case 'too_many_sends':
        return { message: v.restart, restart: true };
      case 'phone_unreachable':
        return { message: t.auth.errors.phoneUnreachable, restart: true };
      case 'otp_unavailable':
        return { message: t.auth.errors.otpUnavailable };
      case 'phone_taken':
        return { message: t.auth.errors.phoneTaken, restart: true };
    }
  }
  return { message: errorMessage(err) };
}

/**
 * Second step of a phone verification: type the code that was sent, or ask for a new one once the
 * cooldown is over. Digits typed on an Arabic keyboard are accepted.
 */
export function CodeStep({
  ticket: initial,
  submitLabel,
  onVerify,
  onResend,
  onRestart,
}: {
  ticket: Ticket;
  submitLabel: string;
  /** Throws on a wrong/expired code; resolves when verified. */
  onVerify: (verificationId: string, code: string) => Promise<void>;
  onResend: (verificationId: string) => Promise<Ticket>;
  /** Back to the first step (edit details), e.g. after the verification expired. */
  onRestart: (message?: string) => void;
}) {
  const { t } = useI18n();
  const v = t.auth.verify;
  const [ticket, setTicket] = useState(initial);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [wait, setWait] = useState(initial.resendAfter);

  useEffect(() => {
    if (wait <= 0) return;
    const timer = setTimeout(() => setWait((w) => w - 1), 1_000);
    return () => clearTimeout(timer);
  }, [wait]);

  const fail = (err: unknown) => {
    const { message, restart } = codeError(err, t);
    if (restart) return onRestart(message);
    if (err instanceof ApiRequestError && err.code === 'resend_cooldown') setWait(Number(err.details?.retryAfter ?? 30));
    setError(message);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (code.length !== 6 || verifying) return;
    setVerifying(true);
    setError(null);
    setNotice(null);
    try {
      await onVerify(ticket.verificationId, code);
    } catch (err) {
      setCode('');
      fail(err);
    } finally {
      setVerifying(false);
    }
  };

  const resend = async () => {
    setResending(true);
    setError(null);
    setNotice(null);
    try {
      const next = await onResend(ticket.verificationId);
      setTicket(next);
      setWait(next.resendAfter);
      setCode('');
      setNotice(v.resent);
    } catch (err) {
      fail(err);
    } finally {
      setResending(false);
    }
  };

  const sent = ticket.channel === 'whatsapp' ? v.sentWhatsapp(ticket.phone) : v.sentSms(ticket.phone);
  const [before, after] = sent.split(ticket.phone);

  return (
    <form onSubmit={submit} className="grid gap-5">
      <p className="flex items-start gap-2.5 rounded-lg border border-line bg-raised/30 p-3 text-sm text-ink-2">
        <MessageSquareText className="mt-0.5 size-4 shrink-0 text-brand" />
        <span>
          {before}
          <bdi dir="ltr" className="font-mono">
            {ticket.phone}
          </bdi>
          {after} {v.validFor}
        </span>
      </p>
      <Field
        label={v.code}
        value={code}
        onChange={(e) => setCode(asciiDigits(e.target.value).replace(/\D/g, '').slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        dir="ltr"
        placeholder="••••••"
        className="text-center font-mono text-xl tracking-[0.5em]"
        autoFocus
        required
      />
      <ErrorNote>{error}</ErrorNote>
      <SuccessNote>{notice}</SuccessNote>
      <Button type="submit" loading={verifying} disabled={code.length !== 6} className="w-full">
        {submitLabel}
      </Button>
      <div className="flex items-center justify-between gap-3 text-sm">
        <button type="button" onClick={() => onRestart()} className="text-muted underline-offset-4 transition-colors hover:text-ink hover:underline">
          {v.change}
        </button>
        <Button variant="ghost" size="sm" icon={<RotateCw className="size-3.5" />} loading={resending} disabled={wait > 0} onClick={() => void resend()}>
          {wait > 0 ? v.resendIn(wait) : v.resend}
        </Button>
      </div>
    </form>
  );
}

/** For accounts without a verified number: enter it, then confirm the code (needed to request a plan). */
export function PhoneVerifyModal({ onClose }: { onClose: () => void }) {
  const { t, lang } = useI18n();
  const p = t.app.phone;
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState('');
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string[] | undefined>();
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  const send = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldError(undefined);
    const normalized = normalizePhone(phone);
    if (!normalized) return setFieldError([t.auth.errors.phoneInvalid]);
    setSending(true);
    try {
      setTicket(await api<Ticket>('/api/account/phone', { method: 'POST', body: { phone: normalized, lang } }));
    } catch (err) {
      const { message } = codeError(err, t);
      if (err instanceof ApiRequestError && (err.code === 'phone_taken' || err.code === 'phone_unreachable' || err.errors?.phone)) setFieldError([message]);
      else setError(message);
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal title={p.title} description={ticket || done ? undefined : p.text} onClose={onClose}>
      {done ? (
        <div className="space-y-4">
          <SuccessNote>{p.done}</SuccessNote>
          <Button className="w-full" onClick={onClose}>
            {t.common.close}
          </Button>
        </div>
      ) : ticket ? (
        <CodeStep
          ticket={ticket}
          submitLabel={p.submit}
          onVerify={async (verificationId, code) => {
            await api('/api/account/phone/verify', { method: 'POST', body: { verificationId, code } });
            await queryClient.invalidateQueries({ queryKey: qk.me });
            setDone(true);
          }}
          onResend={(verificationId) => api<Ticket>('/api/account/phone/resend', { method: 'POST', body: { verificationId } })}
          onRestart={(message) => {
            setTicket(null);
            setError(message ?? null);
          }}
        />
      ) : (
        <form onSubmit={send} className="grid gap-4">
          <Field
            label={t.auth.register.phone}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder={t.auth.register.phonePlaceholder}
            type="tel"
            autoComplete="tel"
            dir="ltr"
            required
            autoFocus
            hint={t.auth.register.phoneHint}
            error={fieldError}
          />
          <ErrorNote>{error}</ErrorNote>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={onClose}>
              {t.common.cancel}
            </Button>
            <Button type="submit" loading={sending}>
              {p.send}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
