import { pgError, PG_ERRORS, type Sql, type TxSql, type UserRole, type UserStatus, type workspaces } from '@wa/db';
import {
  enabledPaymentMethods,
  getPlan,
  normalizePhone,
  ok,
  type PaymentDetails,
  paymentDetailsSchema,
  paymentMonthsSchema,
  paymentSettingsSchema,
  PROOF_MAX_BYTES,
  PROOF_MIMETYPES,
  REQUESTABLE_PLANS,
  SESSION_STATUSES,
  successSchema,
  TRIAL_DAYS,
} from '@wa/shared';
import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import QRCode from 'qrcode';
import { z } from 'zod';
import type { Deps } from '../deps';
import { clearSessionCookie, CONSOLE_TTL_SEC, requirePat, SESSION_COOKIE, setSessionCookie, suspendedError } from '../lib/auth';
import { ApiError, badRequest, conflict, forbidden, notFound, tooMany, unprocessable } from '../lib/errors';
import { getFeatures } from '../lib/features';
import { generateKey, hashKey } from '../lib/keys';
import { getPaymentSettings } from '../lib/payments';
import { hashPassword, needsRehash, passwordProblems, verifyPassword } from '../lib/passwords';
import { generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, looksLikeRecoveryCode, matchTotp, otpauthUrl, totpCipher, type TotpCipher } from '../lib/totp';
import { createVerifications, type Lang, normalizeCode, type VerificationTicket } from '../lib/verification';

const tags = ['Account'];

const userDto = z.object({
  id: z.uuid(),
  name: z.string().nullable(),
  email: z.string(),
  role: z.enum(['user', 'admin']),
  /** Same as `role === 'admin'`; kept for clients written before roles. */
  isAdmin: z.boolean(),
  status: z.enum(['active', 'suspended']),
  phone: z.string().nullable(),
  phoneVerified: z.boolean(),
  /** An authenticator app is set up. Dashboard sessions of a user without one can only set it up (`two_factor_required`). */
  twoFactorEnabled: z.boolean(),
});
const workspaceDto = z.object({
  id: z.uuid(),
  name: z.string(),
  planId: z.string(),
  trialEndsAt: z.string().nullable(),
  planExpiresAt: z.string().nullable(),
});
export const planDto = z.object({
  id: z.string(),
  name: z.string(),
  priceUsd: z.number().nullable(),
  sessions: z.number(),
  rpm: z.number(),
  dailyMessages: z.number().nullable(),
  retentionDays: z.number(),
  /** Features bundled with the plan (`ads` = bulk campaigns page). */
  features: z.array(z.string()).readonly(),
});
/** Login and signup: the session itself travels in the HttpOnly cookie, never in the body. */
const sessionResponse = z.object({ user: userDto, workspace: workspaceDto });
const ticketDto = z.object({
  verificationId: z.uuid(),
  phone: z.string().describe('The number the code went to, partly masked'),
  channel: z.string().describe('`sms` or `whatsapp`'),
  expiresAt: z.string(),
  resendAfter: z.number().describe('Seconds before another code can be requested'),
});

/** For drizzle rows (admin routes). */
export const toWorkspaceDto = (w: typeof workspaces.$inferSelect) => ({
  id: w.id,
  name: w.name,
  planId: w.planId,
  trialEndsAt: w.trialEndsAt?.toISOString() ?? null,
  planExpiresAt: w.planExpiresAt?.toISOString() ?? null,
});

type UserRow = {
  id: string;
  name: string | null;
  email: string;
  password_hash: string | null;
  role: UserRole;
  status: UserStatus;
  suspended_reason: string | null;
  phone: string | null;
  phone_verified_at: Date | null;
  totp_enabled_at: Date | null;
};
type WorkspaceRow = { id: string; name: string; plan_id: string; trial_ends_at: Date | null; plan_expires_at: Date | null };

const toUserDto = (u: UserRow): z.infer<typeof userDto> => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  isAdmin: u.role === 'admin',
  status: u.status,
  phone: u.phone,
  phoneVerified: u.phone_verified_at !== null,
  twoFactorEnabled: u.totp_enabled_at !== null,
});
const workspaceRowDto = (w: WorkspaceRow): z.infer<typeof workspaceDto> => ({
  id: w.id,
  name: w.name,
  planId: w.plan_id,
  trialEndsAt: w.trial_ends_at?.toISOString() ?? null,
  planExpiresAt: w.plan_expires_at?.toISOString() ?? null,
});

export const planRequestDto = z.object({
  id: z.uuid(),
  planId: z.string(),
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']),
  /** Months the customer paid for. */
  months: z.number(),
  /** How the customer paid; null for requests without payment details. */
  payment: paymentDetailsSchema.nullable(),
  /** A transfer screenshot is attached (admins fetch it from `/api/admin/plan-requests/:id/proof`). */
  hasProof: z.boolean(),
  note: z.string().nullable(),
  adminNote: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});

/** Columns of a request without the screenshot bytes (`has_proof` says whether there is one). */
export const PLAN_REQUEST_COLUMNS = 'id, plan_id, status, months, payment, (proof is not null) as has_proof, note, admin_note, created_at, decided_at';

export type PlanRequestRow = {
  id: string;
  plan_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  months: number;
  payment: PaymentDetails | null;
  has_proof: boolean;
  note: string | null;
  admin_note: string | null;
  created_at: Date;
  decided_at: Date | null;
};

export const toPlanRequestDto = (r: {
  id: string;
  planId: string;
  status: PlanRequestRow['status'];
  months: number;
  payment: PaymentDetails | null;
  hasProof: boolean;
  note: string | null;
  adminNote: string | null;
  createdAt: Date;
  decidedAt: Date | null;
}) => ({
  id: r.id,
  planId: r.planId,
  status: r.status,
  months: r.months,
  payment: r.payment,
  hasProof: r.hasProof,
  note: r.note,
  adminNote: r.adminNote,
  createdAt: r.createdAt.toISOString(),
  decidedAt: r.decidedAt?.toISOString() ?? null,
});
export const planRequestRowDto = (r: PlanRequestRow) =>
  toPlanRequestDto({
    id: r.id,
    planId: r.plan_id,
    status: r.status,
    months: r.months,
    payment: r.payment,
    hasProof: r.has_proof,
    note: r.note,
    adminNote: r.admin_note,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  });

const USER_COLUMNS = (sql: Sql | TxSql) => sql`id, name, email, password_hash, role, status, suspended_reason, phone, phone_verified_at, totp_enabled_at`;

/** A dashboard login token: a workspace token with scope `console` that expires; it lives in the session cookie. */
async function issueConsoleToken(sql: Sql | TxSql, workspaceId: string, remember: boolean) {
  const key = generateKey('pat');
  const ttl = remember ? CONSOLE_TTL_SEC.remember : CONSOLE_TTL_SEC.session;
  await sql`
    insert into api_keys (workspace_id, name, key_hash, prefix, scopes, expires_at)
    values (${workspaceId}, 'Dashboard login', ${key.hash}, ${key.prefix}, ${['console']}::text[], now() + make_interval(secs => ${ttl}))`;
  return key.key;
}

/** The user's first workspace (single-workspace accounts; `pnpm bootstrap` can add more). */
async function primaryWorkspace(sql: Sql | TxSql, userId: string) {
  const [w] = await sql<WorkspaceRow[]>`
    select id, name, plan_id, trial_ends_at, plan_expires_at from workspaces where owner_id = ${userId} order by created_at limit 1`;
  return w ?? null;
}

/**
 * Public auth endpoints write the session cookie, so a browser may only call them from our own
 * pages (stops login CSRF). Clients that aren't browsers send no Sec-Fetch-Site and are unaffected.
 */
function assertNotCrossSite(req: FastifyRequest) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') throw forbidden('Cross-site request blocked', 'csrf_blocked');
}

const lang = z.enum(['ar', 'en']).default('ar');
const phoneInput = z.string().trim().min(3).max(32).describe('With the country code, e.g. +201012345678');
const codeInput = z.string().trim().min(4).max(16);
const PHONE_HINT = 'Enter the number with its country code, e.g. +201012345678';

function parsePhone(value: string) {
  const phone = normalizePhone(value);
  if (!phone) throw unprocessable('Validation failed', { phone: [PHONE_HINT] });
  return phone;
}

/** A unique violation while creating or updating a user, as the field the client should fix. */
function takenError(err: unknown) {
  const pg = pgError(err);
  if (pg?.code !== PG_ERRORS.uniqueViolation) return null;
  if (pg.constraint === 'users_email_unique') return conflict('This email is already registered', 'email_taken', { email: ['Already registered — log in instead'] });
  if (pg.constraint === 'users_verified_phone_idx') return conflict('This phone number is already used by another account', 'phone_taken', { phone: ['Already used by another account'] });
  return null;
}

/** Name shown in authenticator apps next to the account. */
const TOTP_ISSUER = 'WA CodeFiye';
/** A login must be finished (codes typed, other device answered) within this. */
const LOGIN_TTL_SEC = 15 * 60;
/** Authenticator codes allowed per login attempt (a recovery code counts too). */
const LOGIN_TOTP_ATTEMPTS = 5;

type LoginStep = 'phone' | 'totp' | 'done';

const loginResponse = z.object({
  step: z.enum(['phone', 'totp', 'done']).describe('What the client does next; `done` = the session cookie is set'),
  loginId: z.uuid(),
  /** Returned once, by `/api/auth/login`: send it with every later step of this login. */
  loginToken: z.string().optional(),
  expiresAt: z.string(),
  /** `phone` step: where the code went. */
  ticket: ticketDto.nullable(),
  /** `done`: the signed-in account. */
  session: sessionResponse.nullable(),
});
const loginRef = { loginId: z.uuid(), loginToken: z.string().min(16).max(128) };

type AttemptRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  remember: boolean;
  phone_verification_id: string | null;
  phone_verified_at: Date | null;
  totp_verified_at: Date | null;
  totp_attempts: number;
  expires_at: Date;
};

type FactorUser = UserRow & { totp_secret: string | null; totp_last_step: number | null };

const loginGone = () => notFound('This login has expired. Log in again.', 'login_expired');
const codeWrong = (attemptsLeft: number) => unprocessable('The code is incorrect', { code: ['Incorrect code'] }, { code: 'code_invalid', details: { attemptsLeft } });

/**
 * Checks an authenticator code for a user and records its step (replay guard; the conditional
 * update also settles two requests racing with the same code). Returns false when it doesn't match.
 */
async function acceptTotp(sql: Sql | TxSql, cipher: TotpCipher, user: { id: string; totp_secret: string | null; totp_last_step: number | null }, code: string) {
  if (!user.totp_secret) return false;
  let secret: string;
  try {
    secret = cipher.open(user.totp_secret, user.id);
  } catch {
    throw new ApiError(500, 'Two-factor secret could not be read (the OTP key changed?)', undefined, { code: 'totp_unreadable' });
  }
  const step = matchTotp(secret, normalizeCode(code), user.totp_last_step === null ? null : Number(user.totp_last_step));
  if (step === null) return false;
  const [won] = await sql`
    update users set totp_last_step = ${step}
    where id = ${user.id} and (totp_last_step is null or totp_last_step < ${step}) returning id`;
  return Boolean(won);
}

/** Spends a recovery code (each works once). Returns false when it isn't one of the user's. */
async function spendRecoveryCode(sql: Sql | TxSql, userId: string, code: string) {
  if (!looksLikeRecoveryCode(code)) return false;
  const hash = hashRecoveryCode(code);
  const [row] = await sql`
    update users set recovery_codes = array_remove(recovery_codes, ${hash})
    where id = ${userId} and ${hash} = any(recovery_codes) returning id`;
  return Boolean(row);
}

/**
 * Sign-up (email + phone + password, confirmed by a code sent to the phone) and login. The account,
 * its workspace and the trial are created only once the phone is confirmed.
 *
 * Login is a sequence of steps on a `login_attempts` row: password → code sent to the verified phone
 * → authenticator code (once two-factor is set up). The session cookie is set only when every step
 * passed.
 */
export function publicAccountRoutes(deps: Deps): FastifyPluginAsyncZod {
  const { sql, throttle, auth } = deps;
  const verifications = createVerifications(deps);
  const cipher = totpCipher(deps.otp.key);

  const loadUser = async (id: string) => {
    const [user] = await sql<FactorUser[]>`select ${USER_COLUMNS(sql)}, totp_secret, totp_last_step from users where id = ${id}`;
    if (!user) throw loginGone();
    if (user.status === 'suspended') throw suspendedError(user.suspended_reason);
    return user;
  };

  /** The open login the client holds (id + secret token). */
  async function loadAttempt(id: string, token: string) {
    const [attempt] = await sql<AttemptRow[]>`
      select id, user_id, workspace_id, remember, phone_verification_id, phone_verified_at, totp_verified_at, totp_attempts, expires_at
      from login_attempts
      where id = ${id} and token_hash = ${hashKey(token)} and completed_at is null and expires_at > now()`;
    if (!attempt) throw loginGone();
    return attempt;
  }

  const phonePending = (a: AttemptRow) => a.phone_verification_id !== null && a.phone_verified_at === null;

  const stepResponse = (a: AttemptRow, step: LoginStep, extra: Partial<z.infer<typeof loginResponse>> = {}): z.infer<typeof loginResponse> => ({
    step,
    loginId: a.id,
    expiresAt: a.expires_at.toISOString(),
    ticket: null,
    session: null,
    ...extra,
  });

  /** Moves a login as far as it can go: the next factor it needs, or — when everything passed — the session cookie. */
  async function advance(attempt: AttemptRow, req: FastifyRequest, reply: FastifyReply) {
    const user = await loadUser(attempt.user_id);
    if (phonePending(attempt)) return stepResponse(attempt, 'phone');
    if (user.totp_enabled_at && !attempt.totp_verified_at) return stepResponse(attempt, 'totp');

    const [done] = await sql`update login_attempts set completed_at = now() where id = ${attempt.id} and completed_at is null returning id`;
    if (!done) throw loginGone();
    const workspace = await primaryWorkspace(sql, user.id);
    if (!workspace) throw unprocessable('This account has no workspace', undefined, { code: 'no_workspace' });
    setSessionCookie(reply, await issueConsoleToken(sql, workspace.id, attempt.remember), { remember: attempt.remember, secure: req.secureCookies });
    return stepResponse(attempt, 'done', { session: { user: toUserDto(user), workspace: workspaceRowDto(workspace) } });
  }

  /**
   * One guess at the authenticator/recovery step, spent up front (parallel guesses can't exceed the
   * budget). Returns the guesses left after this one; past the budget the login must start over.
   */
  async function spendFactorAttempt(attemptId: string) {
    const [row] = await sql<{ totp_attempts: number }[]>`
      update login_attempts set totp_attempts = totp_attempts + 1
      where id = ${attemptId} and totp_attempts < ${LOGIN_TOTP_ATTEMPTS} returning totp_attempts`;
    if (!row) {
      await sql`update login_attempts set expires_at = now() where id = ${attemptId}`;
      throw tooMany('Too many incorrect codes. Log in again.', 60, 'too_many_codes');
    }
    return LOGIN_TOTP_ATTEMPTS - row.totp_attempts;
  }

  /** A recovery code stands in for the authenticator and signs every other session of the account out. */
  async function recover(attempt: AttemptRow, code: string, req: FastifyRequest, reply: FastifyReply) {
    const user = await loadUser(attempt.user_id);
    if (!user.totp_enabled_at) throw badRequest('Two-factor authentication is not set up on this account', 'two_factor_off');
    const left = await spendFactorAttempt(attempt.id);
    const ended = await sql.begin(async (tx) => {
      if (!(await spendRecoveryCode(tx, user.id, code))) return null;
      await tx`update login_attempts set totp_verified_at = coalesce(totp_verified_at, now()) where id = ${attempt.id}`;
      return tx<{ id: string }[]>`
        update api_keys set revoked_at = now()
        where workspace_id in (select id from workspaces where owner_id = ${user.id}) and 'console' = any(scopes) and revoked_at is null
        returning id`;
    });
    if (!ended) throw codeWrong(left);
    if (ended.length) await auth.revoke({ keyIds: ended.map((k) => k.id) });
    req.log.info({ userId: user.id, sessionsEnded: ended.length }, 'login with a recovery code');
    return advance({ ...attempt, totp_verified_at: new Date() }, req, reply);
  }

  return async (app) => {
    app.addHook('onRequest', async (req) => assertNotCrossSite(req));

    app.post(
      '/register',
      {
        schema: {
          tags,
          summary: 'Start signing up',
          description:
            'Validates the details and sends a verification code to the phone (SMS or WhatsApp). Nothing is created yet: ' +
            `confirm the code with \`/api/auth/register/verify\` to create the account and its ${TRIAL_DAYS}-day trial.`,
          security: [],
          body: z.object({
            name: z.string().trim().min(1).max(100),
            email: z.email().trim().max(254),
            phone: phoneInput,
            password: z.string().min(8).max(200),
            lang,
          }),
          response: { 202: successSchema(ticketDto) },
        },
      },
      async (req, reply) => {
        await throttle.consume([{ key: `register:ip:${req.ip}`, limit: 10, windowSec: 3600 }], 'Too many sign-up attempts. Try again later.');
        const email = req.body.email.toLowerCase();
        const phone = parsePhone(req.body.phone);
        const problems = passwordProblems(req.body.password, email);
        if (problems) throw unprocessable('Validation failed', { password: problems });

        const [taken] = await sql<{ email_taken: boolean; phone_taken: boolean }[]>`
          select exists(select 1 from users where email = ${email}) as email_taken,
            exists(select 1 from users where phone = ${phone} and phone_verified_at is not null) as phone_taken`;
        if (taken?.email_taken) throw conflict('This email is already registered', 'email_taken', { email: ['Already registered — log in instead'] });
        if (taken?.phone_taken) throw conflict('This phone number is already used by another account', 'phone_taken', { phone: ['Already used by another account'] });

        const ticket = await verifications.start({
          purpose: 'register',
          phone,
          lang: req.body.lang,
          ip: req.ip,
          details: async () => ({ email, name: req.body.name, passwordHash: await hashPassword(req.body.password) }),
        });
        reply.code(202);
        return ok(ticket);
      },
    );

    app.post(
      '/register/verify',
      {
        schema: {
          tags,
          summary: 'Confirm the phone code and create the account',
          description: 'Creates the user, a workspace on the trial plan, and the dashboard session cookie.',
          security: [],
          body: z.object({ verificationId: z.uuid(), code: codeInput, remember: z.boolean().default(true) }),
          response: { 201: successSchema(sessionResponse) },
        },
      },
      async (req, reply) => {
        const { user, workspace, token } = await verifications
          .confirm(req.body.verificationId, req.body.code, req.ip, { purpose: 'register' }, async (row, tx) => {
            const [user] = await tx<UserRow[]>`
              insert into users (name, email, password_hash, phone, phone_verified_at)
              values (${row.name}, ${row.email}, ${row.password_hash}, ${row.phone}, now())
              returning ${USER_COLUMNS(tx)}`;
            const [workspace] = await tx<WorkspaceRow[]>`
              insert into workspaces (owner_id, name, plan_id, trial_ends_at)
              values (${user!.id}, ${row.name ?? row.email}, 'trial', now() + make_interval(days => ${TRIAL_DAYS}))
              returning id, name, plan_id, trial_ends_at, plan_expires_at`;
            return { user: user!, workspace: workspace!, token: await issueConsoleToken(tx, workspace!.id, req.body.remember) };
          })
          .catch((err) => {
            throw takenError(err) ?? err;
          });
        setSessionCookie(reply, token, { remember: req.body.remember, secure: req.secureCookies });
        reply.code(201);
        return ok({ user: toUserDto(user), workspace: workspaceRowDto(workspace) });
      },
    );

    app.post(
      '/register/resend',
      {
        schema: {
          tags,
          summary: 'Send a new sign-up code',
          security: [],
          body: z.object({ verificationId: z.uuid() }),
          response: { 200: successSchema(ticketDto) },
        },
      },
      async (req) => ok(await verifications.resend(req.body.verificationId, req.ip, { purpose: 'register' })),
    );

    app.post(
      '/login',
      {
        schema: {
          tags,
          summary: 'Log in',
          description:
            'Checks the password and starts a login. Next steps, as `step` says: `phone` (a code was sent to the account\'s number → ' +
            '`/api/auth/login/phone`), `totp` (authenticator code → `/api/auth/login/totp`), `done` (the dashboard session cookie is set). ' +
            'For API access, create a workspace token (`wap_…`) instead.',
          security: [],
          body: z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(200), remember: z.boolean().default(true), lang }),
          response: { 200: successSchema(loginResponse) },
        },
      },
      async (req, reply) => {
        const email = req.body.email.toLowerCase();
        const rules = [
          { key: `login:ip:${req.ip}`, limit: 20, windowSec: 900 },
          { key: `login:email:${email}`, limit: 10, windowSec: 900 },
        ];
        await throttle.check(rules, 'Too many failed login attempts. Try again later.');
        const [user] = await sql<UserRow[]>`select ${USER_COLUMNS(sql)} from users where email = ${email}`;
        // verifyPassword spends the same time when there's no user, so timing doesn't reveal accounts.
        const valid = await verifyPassword(req.body.password, user?.password_hash ?? null);
        if (!user || !valid) {
          await throttle.consume(rules, 'Too many failed login attempts. Try again later.');
          throw unprocessable('Invalid email or password', { email: ['Invalid email or password'] }, { code: 'invalid_credentials' });
        }
        await throttle.reset([`login:email:${email}`]);
        // Only someone who knows the password learns that the account is suspended.
        if (user.status === 'suspended') throw suspendedError(user.suspended_reason);
        if (needsRehash(user.password_hash)) await sql`update users set password_hash = ${await hashPassword(req.body.password)} where id = ${user.id}`;
        const workspace = await primaryWorkspace(sql, user.id);
        if (!workspace) throw unprocessable('This account has no workspace', undefined, { code: 'no_workspace' });

        // The code goes to the account's verified number. If the channel is down (or the number can no
        // longer receive it) the step is skipped rather than locking everyone out — including the admin
        // who would fix the channel; the authenticator code is still required.
        let ticket: VerificationTicket | null = null;
        if (user.phone && user.phone_verified_at) {
          try {
            ticket = await verifications.start({ purpose: 'login', phone: user.phone, lang: req.body.lang, ip: req.ip, userId: user.id });
          } catch (err) {
            if (!(err instanceof ApiError) || (err.code !== 'otp_unavailable' && err.code !== 'phone_unreachable')) throw err;
            req.log.warn({ userId: user.id, code: err.code }, 'login phone code not sent; step skipped');
          }
        }
        const loginToken = randomBytes(24).toString('base64url');
        const [attempt] = await sql<AttemptRow[]>`
          insert into login_attempts (user_id, workspace_id, token_hash, remember, ip, user_agent, phone_verification_id, expires_at)
          values (${user.id}, ${workspace.id}, ${hashKey(loginToken)}, ${req.body.remember}, ${req.ip},
                  ${req.headers['user-agent']?.slice(0, 400) ?? null}, ${ticket?.verificationId ?? null}, now() + make_interval(secs => ${LOGIN_TTL_SEC}))
          returning id, user_id, workspace_id, remember, phone_verification_id, phone_verified_at, totp_verified_at, totp_attempts, expires_at`;
        const next = await advance(attempt!, req, reply);
        return ok({ ...next, loginToken, ticket: next.step === 'phone' ? ticket : null });
      },
    );

    app.post(
      '/login/phone',
      {
        schema: {
          tags,
          summary: 'Log in: confirm the phone code',
          security: [],
          body: z.object({ ...loginRef, code: codeInput }),
          response: { 200: successSchema(loginResponse) },
        },
      },
      async (req, reply) => {
        const attempt = await loadAttempt(req.body.loginId, req.body.loginToken);
        if (phonePending(attempt)) {
          await verifications.confirm(attempt.phone_verification_id!, req.body.code, req.ip, { purpose: 'login', userId: attempt.user_id }, async (_row, tx) => {
            await tx`update login_attempts set phone_verified_at = now() where id = ${attempt.id}`;
          });
          attempt.phone_verified_at = new Date();
        }
        return ok(await advance(attempt, req, reply));
      },
    );

    app.post(
      '/login/phone/resend',
      {
        schema: { tags, summary: 'Log in: send a new phone code', security: [], body: z.object(loginRef), response: { 200: successSchema(ticketDto) } },
      },
      async (req) => {
        const attempt = await loadAttempt(req.body.loginId, req.body.loginToken);
        if (!phonePending(attempt)) throw badRequest('The phone step of this login is already done', 'step_done');
        return ok(await verifications.resend(attempt.phone_verification_id!, req.ip, { purpose: 'login', userId: attempt.user_id }));
      },
    );

    app.post(
      '/login/totp',
      {
        schema: {
          tags,
          summary: 'Log in: authenticator code',
          description: 'The 6-digit code from the authenticator app. A recovery code is accepted too (see `/api/auth/login/recovery`).',
          security: [],
          body: z.object({ ...loginRef, code: z.string().trim().min(6).max(32) }),
          response: { 200: successSchema(loginResponse) },
        },
      },
      async (req, reply) => {
        const attempt = await loadAttempt(req.body.loginId, req.body.loginToken);
        if (phonePending(attempt)) throw badRequest('Confirm the phone code first', 'step_order');
        if (looksLikeRecoveryCode(req.body.code)) return ok(await recover(attempt, req.body.code, req, reply));
        const user = await loadUser(attempt.user_id);
        if (user.totp_enabled_at && !attempt.totp_verified_at) {
          const left = await spendFactorAttempt(attempt.id);
          if (!(await acceptTotp(sql, cipher, user, req.body.code))) throw codeWrong(left);
          await sql`update login_attempts set totp_verified_at = now() where id = ${attempt.id}`;
          attempt.totp_verified_at = new Date();
        }
        return ok(await advance(attempt, req, reply));
      },
    );

    app.post(
      '/login/recovery',
      {
        schema: {
          tags,
          summary: 'Log in: use a recovery code',
          description:
            'For a lost phone or authenticator: replaces the authenticator code and ends every other dashboard session of the ' +
            'account. Each recovery code works once.',
          security: [],
          body: z.object({ ...loginRef, code: z.string().trim().min(10).max(32) }),
          response: { 200: successSchema(loginResponse) },
        },
      },
      async (req, reply) => {
        const attempt = await loadAttempt(req.body.loginId, req.body.loginToken);
        if (phonePending(attempt)) throw badRequest('Confirm the phone code first', 'step_order');
        return ok(await recover(attempt, req.body.code, req, reply));
      },
    );

    app.post(
      '/login/cancel',
      {
        schema: { tags, summary: 'Log in: give up this login', security: [], body: z.object(loginRef), response: { 200: successSchema(z.object({ cancelled: z.literal(true) })) } },
      },
      async (req) => {
        await sql`
          update login_attempts set expires_at = now()
          where id = ${req.body.loginId} and token_hash = ${hashKey(req.body.loginToken)} and completed_at is null`;
        return ok({ cancelled: true as const });
      },
    );

    app.post(
      '/logout',
      {
        schema: {
          tags,
          summary: 'Log out',
          description: 'Revokes the dashboard session (cookie or a console bearer token) and clears the cookie. Always succeeds.',
          security: [],
          response: { 200: successSchema(z.object({ loggedOut: z.literal(true) })) },
        },
      },
      async (req, reply) => {
        const header = req.headers.authorization;
        const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : (req.cookies[SESSION_COOKIE] ?? '');
        if (token) {
          // Only dashboard sessions end here; API keys are revoked from the keys page.
          const revoked = await sql<{ id: string }[]>`
            update api_keys set revoked_at = now()
            where key_hash = ${hashKey(token)} and 'console' = any(scopes) and revoked_at is null
            returning id`;
          if (revoked.length) await auth.revoke({ keyIds: revoked.map((r) => r.id) });
        }
        clearSessionCookie(reply, req.secureCookies);
        return ok({ loggedOut: true as const });
      },
    );
  };
}

const RECENT = z.object({
  id: z.number(),
  sessionId: z.uuid(),
  sessionName: z.string(),
  direction: z.enum(['in', 'out']),
  jid: z.string(),
  type: z.string(),
  status: z.string(),
  text: z.string().nullable(),
  createdAt: z.string(),
});

const meResponse = z.object({
  user: userDto.nullable(),
  workspace: workspaceDto,
  plan: planDto,
  pendingRequest: planRequestDto.nullable(),
  /** Runtime feature flags (admin-controlled): `ads` live for plans that bundle it. */
  features: z.object({ ads: z.boolean() }),
});

/** Authenticated account endpoints: who am I, session, password, phone, plan requests and the dashboard overview. */
export function accountRoutes(deps: Deps): FastifyPluginAsyncZod {
  const { sql, auth, throttle } = deps;
  const verifications = createVerifications(deps);
  const cipher = totpCipher(deps.otp.key);

  /** Workspace, owner and pending plan request in one round trip. */
  async function loadMe(workspaceId: string): Promise<z.infer<typeof meResponse>> {
    const [row] = await sql<
      (WorkspaceRow & {
        user_id: string | null;
        user_name: string | null;
        email: string | null;
        role: UserRole | null;
        status: UserStatus | null;
        phone: string | null;
        phone_verified_at: Date | null;
        totp_enabled_at: Date | null;
        request: PlanRequestRow | null;
      })[]
    >`
      select w.id, w.name, w.plan_id, w.trial_ends_at, w.plan_expires_at,
        u.id as user_id, u.name as user_name, u.email, u.role, u.status, u.phone, u.phone_verified_at, u.totp_enabled_at,
        (select to_jsonb(r) from (select ${sql.unsafe(PLAN_REQUEST_COLUMNS)} from plan_requests x where x.workspace_id = w.id and x.status = 'pending' limit 1) r) as request
      from workspaces w
      left join users u on u.id = w.owner_id
      where w.id = ${workspaceId}`;
    if (!row) throw notFound('Workspace not found');
    const request = row.request
      ? planRequestRowDto({ ...row.request, created_at: new Date(row.request.created_at), decided_at: row.request.decided_at ? new Date(row.request.decided_at) : null })
      : null;
    return {
      user:
        row.user_id && row.email
          ? toUserDto({
              id: row.user_id,
              name: row.user_name,
              email: row.email,
              password_hash: null,
              role: row.role ?? 'user',
              status: row.status ?? 'active',
              suspended_reason: null,
              phone: row.phone,
              phone_verified_at: row.phone_verified_at,
              totp_enabled_at: row.totp_enabled_at,
            })
          : null,
      workspace: workspaceRowDto(row),
      plan: getPlan(row.plan_id),
      pendingRequest: request,
      features: { ads: (await getFeatures(sql)).ads },
    };
  }

  const requireUser = (req: FastifyRequest) => {
    requirePat(req);
    if (!req.auth.userId) throw notFound('This workspace has no owner account', 'no_owner');
    return req.auth.userId;
  };

  /** Workspaces owned by a user, for revoking cached credentials after a change to the user. */
  const ownedWorkspaces = async (userId: string) => (await sql<{ id: string }[]>`select id from workspaces where owner_id = ${userId}`).map((w) => w.id);

  return async (app) => {
    app.get(
      '/me',
      { schema: { tags, summary: 'Current workspace, owner and plan', response: { 200: successSchema(meResponse) } } },
      async (req) => {
        requirePat(req);
        return ok(await loadMe(req.auth.workspaceId));
      },
    );

    app.post(
      '/auth/session',
      {
        schema: {
          tags,
          summary: 'Open a dashboard session with a workspace token',
          description: 'Exchanges a `wap_…` token (sent as a bearer) for the HttpOnly dashboard session cookie.',
          body: z.object({ remember: z.boolean().default(true) }).default({ remember: true }),
          response: { 200: successSchema(meResponse) },
        },
      },
      async (req, reply) => {
        requirePat(req);
        if (req.authVia !== 'bearer') throw badRequest('Send the workspace token in the Authorization header', 'bearer_required');
        const token = await issueConsoleToken(sql, req.auth.workspaceId, req.body.remember);
        // A console token from older dashboards (kept in browser storage) is retired once it has a cookie.
        if (req.auth.console) {
          await sql`update api_keys set revoked_at = now() where id = ${req.auth.keyId}`;
          await auth.revoke({ keyIds: [req.auth.keyId] });
        }
        setSessionCookie(reply, token, { remember: req.body.remember, secure: req.secureCookies });
        return ok(await loadMe(req.auth.workspaceId));
      },
    );

    app.put(
      '/account/profile',
      {
        schema: {
          tags,
          summary: 'Edit the profile: your name and the workspace name',
          body: z.object({ name: z.string().trim().min(2).max(120).optional(), workspaceName: z.string().trim().min(2).max(120).optional() }),
          response: { 200: successSchema(meResponse) },
        },
      },
      async (req) => {
        const userId = requireUser(req);
        if (!req.auth.console) throw forbidden('Edit the profile from the dashboard', 'console_required');
        const { name, workspaceName } = req.body;
        await sql.begin(async (tx) => {
          if (name !== undefined) await tx`update users set name = ${name} where id = ${userId}`;
          if (workspaceName !== undefined) await tx`update workspaces set name = ${workspaceName} where id = ${req.auth.workspaceId} and owner_id = ${userId}`;
        });
        return ok(await loadMe(req.auth.workspaceId));
      },
    );

    app.post(
      '/auth/password',
      {
        schema: {
          tags,
          summary: 'Change the owner password',
          description: 'Ends every other dashboard session of the account.',
          body: z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(8).max(200) }),
          response: { 200: successSchema(z.object({ changed: z.literal(true), otherSessionsEnded: z.number() })) },
        },
      },
      async (req) => {
        const userId = requireUser(req);
        // A stolen session can't be used to brute-force the current password.
        await throttle.consume([{ key: `password:user:${userId}`, limit: 10, windowSec: 900 }], 'Too many attempts. Try again later.');
        const [owner] = await sql<UserRow[]>`select ${USER_COLUMNS(sql)} from users where id = ${userId}`;
        if (!owner) throw notFound('This workspace has no owner account', 'no_owner');
        if (!(await verifyPassword(req.body.currentPassword, owner.password_hash))) {
          throw unprocessable('Current password is incorrect', { currentPassword: ['Incorrect password'] }, { code: 'invalid_credentials' });
        }
        const problems = passwordProblems(req.body.newPassword, owner.email);
        if (problems) throw unprocessable('Validation failed', { newPassword: problems });
        const passwordHash = await hashPassword(req.body.newPassword);
        const ended = await sql.begin(async (tx) => {
          await tx`update users set password_hash = ${passwordHash} where id = ${userId}`;
          return tx<{ id: string }[]>`
            update api_keys set revoked_at = now()
            where workspace_id in (select id from workspaces where owner_id = ${userId})
              and 'console' = any(scopes) and revoked_at is null and id <> ${req.auth.keyId}
            returning id`;
        });
        if (ended.length) await auth.revoke({ keyIds: ended.map((k) => k.id) });
        return ok({ changed: true as const, otherSessionsEnded: ended.length });
      },
    );

    app.post(
      '/account/phone',
      {
        schema: {
          tags,
          summary: 'Add or change the phone number',
          description: 'Sends a verification code to the number; confirm it with `/api/account/phone/verify`.',
          body: z.object({ phone: phoneInput, lang }),
          response: { 202: successSchema(ticketDto) },
        },
      },
      async (req, reply) => {
        const userId = requireUser(req);
        const phone = parsePhone(req.body.phone);
        const [taken] = await sql`select 1 from users where phone = ${phone} and phone_verified_at is not null and id <> ${userId}`;
        if (taken) throw conflict('This phone number is already used by another account', 'phone_taken', { phone: ['Already used by another account'] });
        reply.code(202);
        return ok(await verifications.start({ purpose: 'phone', phone, lang: req.body.lang as Lang, ip: req.ip, userId }));
      },
    );

    app.post(
      '/account/phone/resend',
      {
        schema: { tags, summary: 'Send a new phone code', body: z.object({ verificationId: z.uuid() }), response: { 200: successSchema(ticketDto) } },
      },
      async (req) => ok(await verifications.resend(req.body.verificationId, req.ip, { purpose: 'phone', userId: requireUser(req) })),
    );

    app.post(
      '/account/phone/verify',
      {
        schema: {
          tags,
          summary: 'Confirm the phone code',
          body: z.object({ verificationId: z.uuid(), code: codeInput }),
          response: { 200: successSchema(meResponse) },
        },
      },
      async (req) => {
        const userId = requireUser(req);
        await verifications
          .confirm(req.body.verificationId, req.body.code, req.ip, { purpose: 'phone', userId }, async (row, tx) => {
            await tx`update users set phone = ${row.phone}, phone_verified_at = now() where id = ${userId}`;
          })
          .catch((err) => {
            throw takenError(err) ?? err;
          });
        await auth.revoke({ workspaceIds: await ownedWorkspaces(userId) });
        return ok(await loadMe(req.auth.workspaceId));
      },
    );

    app.post(
      '/account/2fa/setup',
      {
        schema: {
          tags,
          summary: 'Start setting up two-factor authentication',
          description:
            'Creates a new authenticator secret (replacing an unconfirmed one). Scan `qrImage` (or type `secret`) in the app, then ' +
            'confirm a code with `/api/account/2fa/enable`.',
          response: { 200: successSchema(z.object({ secret: z.string(), otpauthUrl: z.string(), qrImage: z.string() })) },
        },
      },
      async (req) => {
        const userId = requireUser(req);
        const [user] = await sql<{ email: string; totp_enabled_at: Date | null; totp_secret: string | null }[]>`
          select email, totp_enabled_at, totp_secret from users where id = ${userId}`;
        if (!user) throw notFound('This workspace has no owner account', 'no_owner');
        if (user.totp_enabled_at) throw conflict('Two-factor authentication is already on', 'two_factor_on');
        // An unconfirmed secret is kept: the page asking again (a reload, a second tab, a double mount)
        // must not replace the secret the app already scanned, or every code it shows is "incorrect".
        const readable = (sealed: string | null) => {
          if (!sealed) return null;
          try {
            return cipher.open(sealed, userId);
          } catch {
            return null;
          }
        };
        let secret = readable(user.totp_secret);
        if (!secret) {
          const fresh = generateTotpSecret();
          const sealed = cipher.seal(fresh, userId);
          // Two first requests at once: one stores its secret, the other reads it back.
          const [stored] = await sql<{ totp_secret: string }[]>`
            update users set totp_secret = case when totp_secret is null or ${user.totp_secret !== null} then ${sealed} else totp_secret end, totp_last_step = null
            where id = ${userId} and totp_enabled_at is null
            returning totp_secret`;
          secret = readable(stored?.totp_secret ?? sealed) ?? fresh;
        }
        const url = otpauthUrl(secret, user.email, TOTP_ISSUER);
        return ok({ secret, otpauthUrl: url, qrImage: await QRCode.toDataURL(url, { margin: 1, width: 240 }) });
      },
    );

    app.post(
      '/account/2fa/enable',
      {
        schema: {
          tags,
          summary: 'Turn two-factor authentication on',
          description: 'Confirms a code from the app. Returns the recovery codes — shown only now, each works once.',
          body: z.object({ code: z.string().trim().min(6).max(16) }),
          response: { 200: successSchema(z.object({ recoveryCodes: z.array(z.string()) })) },
        },
      },
      async (req) => {
        const userId = requireUser(req);
        await throttle.consume([{ key: `totp-setup:user:${userId}`, limit: 15, windowSec: 900 }], 'Too many attempts. Try again later.');
        const [user] = await sql<{ id: string; totp_secret: string | null; totp_last_step: number | null; totp_enabled_at: Date | null }[]>`
          select id, totp_secret, totp_last_step, totp_enabled_at from users where id = ${userId}`;
        if (!user) throw notFound('This workspace has no owner account', 'no_owner');
        if (user.totp_enabled_at) throw conflict('Two-factor authentication is already on', 'two_factor_on');
        if (!user.totp_secret) throw badRequest('Start the setup first', 'two_factor_not_started');
        if (!(await acceptTotp(sql, cipher, user, req.body.code))) {
          throw unprocessable('The code is incorrect', { code: ['Incorrect code'] }, { code: 'code_invalid' });
        }
        const codes = generateRecoveryCodes();
        await sql`
          update users set totp_enabled_at = now(), recovery_codes = ${codes.map(hashRecoveryCode)}::text[]
          where id = ${userId} and totp_enabled_at is null`;
        // Cached credentials carry the "two-factor required" flag; drop them so this session is let through now.
        await auth.revoke({ workspaceIds: await ownedWorkspaces(userId) });
        return ok({ recoveryCodes: codes });
      },
    );

    app.post(
      '/account/2fa/recovery-codes',
      {
        schema: {
          tags,
          summary: 'New recovery codes',
          description: 'Replaces every recovery code (the old ones stop working). Needs a current code from the authenticator app.',
          body: z.object({ code: z.string().trim().min(6).max(16) }),
          response: { 200: successSchema(z.object({ recoveryCodes: z.array(z.string()) })) },
        },
      },
      async (req) => {
        const userId = requireUser(req);
        await throttle.consume([{ key: `totp-setup:user:${userId}`, limit: 15, windowSec: 900 }], 'Too many attempts. Try again later.');
        const [user] = await sql<{ id: string; totp_secret: string | null; totp_last_step: number | null; totp_enabled_at: Date | null }[]>`
          select id, totp_secret, totp_last_step, totp_enabled_at from users where id = ${userId}`;
        if (!user?.totp_enabled_at) throw badRequest('Two-factor authentication is not set up', 'two_factor_off');
        if (!(await acceptTotp(sql, cipher, user, req.body.code))) {
          throw unprocessable('The code is incorrect', { code: ['Incorrect code'] }, { code: 'code_invalid' });
        }
        const codes = generateRecoveryCodes();
        await sql`update users set recovery_codes = ${codes.map(hashRecoveryCode)}::text[] where id = ${userId}`;
        return ok({ recoveryCodes: codes });
      },
    );

    app.get(
      '/account/2fa',
      {
        schema: {
          tags,
          summary: 'Two-factor status',
          response: { 200: successSchema(z.object({ enabled: z.boolean(), recoveryCodesLeft: z.number() })) },
        },
      },
      async (req) => {
        const userId = requireUser(req);
        const [row] = await sql<{ enabled: boolean; left: number }[]>`
          select totp_enabled_at is not null as enabled, cardinality(recovery_codes)::int as left from users where id = ${userId}`;
        return ok({ enabled: row?.enabled ?? false, recoveryCodesLeft: row?.left ?? 0 });
      },
    );

    app.get(
      '/plan-requests',
      { schema: { tags, summary: 'Plan requests of this workspace, newest first', response: { 200: successSchema(z.array(planRequestDto)) } } },
      async (req) => {
        requirePat(req);
        const rows = await sql<PlanRequestRow[]>`
          select ${sql.unsafe(PLAN_REQUEST_COLUMNS)} from plan_requests
          where workspace_id = ${req.auth.workspaceId} order by created_at desc limit 20`;
        return ok(rows.map(planRequestRowDto));
      },
    );

    app.get(
      '/payment-methods',
      {
        schema: {
          tags,
          summary: 'How to pay for a plan: the methods the operator accepts, with their receiving accounts',
          response: { 200: successSchema(paymentSettingsSchema) },
        },
      },
      async (req) => {
        requirePat(req);
        return ok(await getPaymentSettings(sql));
      },
    );

    const proofSchema = z.object({
      mimetype: z.enum(PROOF_MIMETYPES),
      /** The image, base64 (no data: prefix). */
      data: z.string().min(1).max(Math.ceil((PROOF_MAX_BYTES * 4) / 3) + 4),
    });

    app.post(
      '/plan-requests',
      {
        // The screenshot travels inside the JSON body.
        bodyLimit: 4 * 1024 * 1024,
        schema: {
          tags,
          summary: 'Request a plan',
          description:
            'Asks an admin to move the workspace to a plan. Needs an active account with a verified phone number. ' +
            'Priced plans need `payment` (how you paid, per method) and `proof` (a screenshot of the transfer) when the operator ' +
            'accepts at least one payment method (see `GET /api/payment-methods`). ' +
            'Replaces a pending request for another plan; asking again for the pending plan is a 409.',
          body: z.object({
            planId: z.enum(REQUESTABLE_PLANS),
            months: paymentMonthsSchema.default(1),
            payment: paymentDetailsSchema.optional(),
            proof: proofSchema.optional(),
            note: z.string().trim().max(500).optional(),
          }),
          response: { 201: successSchema(planRequestDto) },
        },
      },
      async (req, reply) => {
        requirePat(req);
        if (!req.auth.isAdmin && !req.auth.phoneVerified) {
          throw forbidden('Verify your phone number before requesting a plan', 'phone_unverified');
        }
        const { planId, months, payment, note } = req.body;
        const settings = await getPaymentSettings(sql);
        const accepted = enabledPaymentMethods(settings);
        // Payment is expected when the plan has a price and there is a way to pay; custom-priced plans are arranged by hand.
        if (getPlan(planId).priceUsd !== null && accepted.length > 0) {
          if (!payment) throw unprocessable('Choose how you paid', { payment: ['Pick a payment method'] });
          if (!accepted.includes(payment.method)) throw unprocessable('This payment method is not accepted', { payment: ['Pick an accepted payment method'] });
          if (!req.body.proof) throw unprocessable('Attach a screenshot of the transfer', { proof: ['Attach a screenshot'] });
        }
        let proof: Buffer | null = null;
        if (req.body.proof) {
          proof = Buffer.from(req.body.proof.data, 'base64');
          if (proof.length === 0) throw unprocessable('The screenshot is empty', { proof: ['Attach a screenshot'] });
          if (proof.length > PROOF_MAX_BYTES) throw unprocessable('The screenshot is too large', { proof: ['Use an image under 2 MB'] });
        }
        const proofMimetype = req.body.proof?.mimetype ?? null;
        const ws = req.auth.workspaceId;
        const request = await sql
          .begin(async (tx) => {
            // Serializes concurrent requests of this workspace (the unique index is the backstop).
            await tx`select id from workspaces where id = ${ws} for update`;
            const [pending] = await tx<{ id: string; plan_id: string }[]>`select id, plan_id from plan_requests where workspace_id = ${ws} and status = 'pending'`;
            if (pending?.plan_id === planId) {
              throw conflict('You already have a pending request for this plan', 'duplicate_request');
            }
            if (pending) await tx`update plan_requests set status = 'cancelled', decided_at = now() where id = ${pending.id}`;
            const [row] = await tx<PlanRequestRow[]>`
              insert into plan_requests (workspace_id, plan_id, months, payment, proof_mimetype, proof, note)
              values (${ws}, ${planId}, ${months}, ${payment ? sql.json(payment) : null}, ${proofMimetype}, ${proof}, ${note || null})
              returning ${sql.unsafe(PLAN_REQUEST_COLUMNS)}`;
            return row!;
          })
          .catch((err) => {
            if (pgError(err)?.code === PG_ERRORS.uniqueViolation) throw conflict('Another request is being submitted. Refresh and try again.', 'duplicate_request');
            throw err;
          });
        reply.code(201);
        return ok(planRequestRowDto(request));
      },
    );

    app.post(
      '/plan-requests/:id/cancel',
      {
        schema: {
          tags,
          summary: 'Cancel a pending plan request',
          params: z.object({ id: z.uuid() }),
          response: { 200: successSchema(planRequestDto) },
        },
      },
      async (req) => {
        requirePat(req);
        const [row] = await sql<PlanRequestRow[]>`
          update plan_requests set status = 'cancelled', decided_at = now()
          where id = ${req.params.id} and workspace_id = ${req.auth.workspaceId} and status = 'pending'
          returning ${sql.unsafe(PLAN_REQUEST_COLUMNS)}`;
        if (!row) throw notFound('No pending request with this id');
        return ok(planRequestRowDto(row));
      },
    );

    app.get(
      '/overview',
      {
        schema: {
          tags,
          summary: 'Dashboard overview',
          querystring: z.object({ days: z.coerce.number().int().min(7).max(90).default(14) }),
          response: {
            200: successSchema(
              z.object({
                sessions: z.object({ total: z.number(), byStatus: z.record(z.enum(SESSION_STATUSES), z.number()) }),
                messages: z.object({
                  today: z.object({ sent: z.number(), received: z.number(), failed: z.number() }),
                  daily: z.array(z.object({ day: z.string(), sent: z.number(), received: z.number(), failed: z.number() })),
                }),
                recent: z.array(RECENT),
              }),
            ),
          },
        },
      },
      async (req) => {
        requirePat(req);
        const ws = req.auth.workspaceId;
        const days = req.query.days;
        const [statusRows, daily, recent] = await Promise.all([
          sql<{ status: (typeof SESSION_STATUSES)[number]; n: number }[]>`
            select status, count(*)::int as n from sessions where workspace_id = ${ws} group by status`,
          sql<{ day: string; sent: number; received: number; failed: number }[]>`
            select to_char(d.day, 'YYYY-MM-DD') as day,
              count(m.id) filter (where m.direction = 'out' and m.status in ('sent', 'delivered', 'read'))::int as sent,
              count(m.id) filter (where m.direction = 'in')::int as received,
              count(m.id) filter (where m.direction = 'out' and m.status = 'failed')::int as failed
            from generate_series(date_trunc('day', now()) - (${days - 1} * interval '1 day'), date_trunc('day', now()), interval '1 day') as d(day)
            left join messages m on m.workspace_id = ${ws} and m.created_at >= d.day and m.created_at < d.day + interval '1 day'
            group by d.day
            order by d.day`,
          sql<{ id: number; session_id: string; session_name: string; direction: 'in' | 'out'; remote_jid: string; type: string; status: string; text: string | null; created_at: Date }[]>`
            select m.id, m.session_id, s.name as session_name, m.direction, m.remote_jid, m.type, m.status,
              coalesce(m.content->>'text', m.content->>'caption', m.content->>'name') as text, m.created_at
            from messages m join sessions s on s.id = m.session_id
            where m.workspace_id = ${ws}
            order by m.id desc
            limit 8`,
        ]);
        const byStatus = Object.fromEntries(SESSION_STATUSES.map((s) => [s, 0])) as Record<(typeof SESSION_STATUSES)[number], number>;
        for (const r of statusRows) byStatus[r.status] = r.n;
        const today = daily.at(-1) ?? { sent: 0, received: 0, failed: 0 };
        return ok({
          sessions: { total: statusRows.reduce((sum, r) => sum + r.n, 0), byStatus },
          messages: { today: { sent: today.sent, received: today.received, failed: today.failed }, daily },
          recent: recent.map((r) => ({
            id: r.id,
            sessionId: r.session_id,
            sessionName: r.session_name,
            direction: r.direction,
            jid: r.remote_jid,
            type: r.type,
            status: r.status,
            text: r.text,
            createdAt: r.created_at.toISOString(),
          })),
        });
      },
    );
  };
}

