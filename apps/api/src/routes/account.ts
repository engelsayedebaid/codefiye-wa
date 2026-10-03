import { pgError, PG_ERRORS, type Sql, type TxSql, type UserRole, type UserStatus, type workspaces } from '@wa/db';
import { getPlan, normalizePhone, ok, REQUESTABLE_PLANS, SESSION_STATUSES, successSchema, TRIAL_DAYS } from '@wa/shared';
import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps';
import { clearSessionCookie, CONSOLE_TTL_SEC, requirePat, SESSION_COOKIE, setSessionCookie, suspendedError } from '../lib/auth';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../lib/errors';
import { generateKey, hashKey } from '../lib/keys';
import { hashPassword, needsRehash, passwordProblems, verifyPassword } from '../lib/passwords';
import { createVerifications, type Lang } from '../lib/verification';

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
  note: z.string().nullable(),
  adminNote: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
});

type PlanRequestRow = {
  id: string;
  plan_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  note: string | null;
  admin_note: string | null;
  created_at: Date;
  decided_at: Date | null;
};

export const toPlanRequestDto = (r: { id: string; planId: string; status: PlanRequestRow['status']; note: string | null; adminNote: string | null; createdAt: Date; decidedAt: Date | null }) => ({
  id: r.id,
  planId: r.planId,
  status: r.status,
  note: r.note,
  adminNote: r.adminNote,
  createdAt: r.createdAt.toISOString(),
  decidedAt: r.decidedAt?.toISOString() ?? null,
});
const planRequestRowDto = (r: PlanRequestRow) =>
  toPlanRequestDto({ id: r.id, planId: r.plan_id, status: r.status, note: r.note, adminNote: r.admin_note, createdAt: r.created_at, decidedAt: r.decided_at });

const USER_COLUMNS = (sql: Sql | TxSql) => sql`id, name, email, password_hash, role, status, suspended_reason, phone, phone_verified_at`;

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

/**
 * Sign-up (email + phone + password, confirmed by a code sent to the phone) and login. The account,
 * its workspace and the trial are created only once the phone is confirmed.
 */
export function publicAccountRoutes(deps: Deps): FastifyPluginAsyncZod {
  const { sql, throttle, auth } = deps;
  const verifications = createVerifications(deps);

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
          description: 'Sets the dashboard session cookie. For API access, create a workspace token (`wap_…`) instead.',
          security: [],
          body: z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(200), remember: z.boolean().default(true) }),
          response: { 200: successSchema(sessionResponse) },
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
        setSessionCookie(reply, await issueConsoleToken(sql, workspace.id, req.body.remember), { remember: req.body.remember, secure: req.secureCookies });
        return ok({ user: toUserDto(user), workspace: workspaceRowDto(workspace) });
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

const meResponse = z.object({ user: userDto.nullable(), workspace: workspaceDto, plan: planDto, pendingRequest: planRequestDto.nullable() });

/** Authenticated account endpoints: who am I, session, password, phone, plan requests and the dashboard overview. */
export function accountRoutes(deps: Deps): FastifyPluginAsyncZod {
  const { sql, auth, throttle } = deps;
  const verifications = createVerifications(deps);

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
        request: PlanRequestRow | null;
      })[]
    >`
      select w.id, w.name, w.plan_id, w.trial_ends_at, w.plan_expires_at,
        u.id as user_id, u.name as user_name, u.email, u.role, u.status, u.phone, u.phone_verified_at,
        (select to_jsonb(r) from plan_requests r where r.workspace_id = w.id and r.status = 'pending' limit 1) as request
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
            })
          : null,
      workspace: workspaceRowDto(row),
      plan: getPlan(row.plan_id),
      pendingRequest: request,
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

    app.get(
      '/plan-requests',
      { schema: { tags, summary: 'Plan requests of this workspace, newest first', response: { 200: successSchema(z.array(planRequestDto)) } } },
      async (req) => {
        requirePat(req);
        const rows = await sql<PlanRequestRow[]>`
          select id, plan_id, status, note, admin_note, created_at, decided_at from plan_requests
          where workspace_id = ${req.auth.workspaceId} order by created_at desc limit 20`;
        return ok(rows.map(planRequestRowDto));
      },
    );

    app.post(
      '/plan-requests',
      {
        schema: {
          tags,
          summary: 'Request a plan',
          description:
            'Asks an admin to move the workspace to a plan. Needs an active account with a verified phone number. ' +
            'Replaces a pending request for another plan; asking again for the pending plan is a 409.',
          body: z.object({ planId: z.enum(REQUESTABLE_PLANS), note: z.string().trim().max(500).optional() }),
          response: { 201: successSchema(planRequestDto) },
        },
      },
      async (req, reply) => {
        requirePat(req);
        if (!req.auth.isAdmin && !req.auth.phoneVerified) {
          throw forbidden('Verify your phone number before requesting a plan', 'phone_unverified');
        }
        const ws = req.auth.workspaceId;
        const request = await sql
          .begin(async (tx) => {
            // Serializes concurrent requests of this workspace (the unique index is the backstop).
            await tx`select id from workspaces where id = ${ws} for update`;
            const [pending] = await tx<{ id: string; plan_id: string }[]>`select id, plan_id from plan_requests where workspace_id = ${ws} and status = 'pending'`;
            if (pending?.plan_id === req.body.planId) {
              throw conflict('You already have a pending request for this plan', 'duplicate_request');
            }
            if (pending) await tx`update plan_requests set status = 'cancelled', decided_at = now() where id = ${pending.id}`;
            const [row] = await tx<PlanRequestRow[]>`
              insert into plan_requests (workspace_id, plan_id, note) values (${ws}, ${req.body.planId}, ${req.body.note || null})
              returning id, plan_id, status, note, admin_note, created_at, decided_at`;
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
          returning id, plan_id, status, note, admin_note, created_at, decided_at`;
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

