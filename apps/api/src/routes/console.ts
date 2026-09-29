import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, apiKeys, asc, auditLogs, desc, eq, isNull, messages, paymentMethods, paymentRequests, plans, sessions, sql, users, workers, workspaces } from '@wa/db';
import { ok } from '@wa/shared';
import { requireAdmin, requirePat, resolveSession } from '../plugins/auth';
import { badRequest, conflict, notFound } from '../lib/errors';
import { generateApiKey } from '../lib/keys';
import { effectivePlan, getPlan, publicPlans, refreshPlans } from '../lib/plans';

const paymentRow = {
  id: paymentRequests.id,
  planId: paymentRequests.planId,
  amountEgp: paymentRequests.amountEgp,
  months: paymentRequests.months,
  method: paymentRequests.method,
  reference: paymentRequests.reference,
  note: paymentRequests.note,
  status: paymentRequests.status,
  adminNote: paymentRequests.adminNote,
  createdAt: paymentRequests.createdAt,
  reviewedAt: paymentRequests.reviewedAt,
};

export function consoleRoutes(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = app.db;
  const pageSchema = z.object({ page: z.coerce.number().int().min(1).default(1), search: z.string().max(100).default(''), status: z.enum(['all', 'pending', 'sent', 'delivered', 'read', 'played', 'failed']).default('all') });

  r.get('/api/console/me', async (req) => {
    requirePat(req);
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, req.auth.workspaceId), columns: { id: true, name: true, planId: true, createdAt: true, trialEndsAt: true, planExpiresAt: true, suspendedAt: true } });
    if (!workspace) throw notFound();
    return ok({
      workspace,
      plan: effectivePlan(workspace),
      isAdmin: req.auth.isAdmin === true,
      authType: req.auth.authType ?? 'key',
      email: req.auth.email ?? null,
      billingEnabled: false,
      webhooksEnabled: false,
    });
  });

  r.get('/api/console/overview', async (req) => {
    requirePat(req);
    const scope = eq(sessions.workspaceId, req.auth.workspaceId);
    const [sessionStats, messageStats, daily, keyStats] = await Promise.all([
      db.select({ total: sql<number>`count(*)::int`, connected: sql<number>`count(*) filter (where ${sessions.status} = 'connected')::int` }).from(sessions).where(scope),
      db.select({ total: sql<number>`count(*)::int`, sent: sql<number>`count(*) filter (where ${messages.direction} = 'out')::int`, received: sql<number>`count(*) filter (where ${messages.direction} = 'in')::int`, failed: sql<number>`count(*) filter (where ${messages.status} = 'failed')::int` }).from(messages).innerJoin(sessions, eq(sessions.id, messages.sessionId)).where(scope),
      db.select({ day: sql<string>`to_char(${messages.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`, count: sql<number>`count(*)::int` }).from(messages).innerJoin(sessions, eq(sessions.id, messages.sessionId)).where(and(scope, sql`${messages.createdAt} >= current_date - interval '6 days'`)).groupBy(sql`to_char(${messages.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`),
      db.select({ total: sql<number>`count(*)::int` }).from(apiKeys).where(and(eq(apiKeys.workspaceId, req.auth.workspaceId), isNull(apiKeys.revokedAt))),
    ]);
    return ok({ sessions: sessionStats[0], messages: messageStats[0], daily, activeKeys: keyStats[0]?.total ?? 0 });
  });

  r.get('/api/console/messages', { schema: { querystring: pageSchema } }, async (req) => {
    requirePat(req);
    const { page, search, status } = req.query;
    const filter = and(eq(sessions.workspaceId, req.auth.workspaceId), search ? sql`position(${search} in ${messages.remoteJid}) > 0` : undefined, status === 'all' ? undefined : eq(messages.status, status));
    const [items, [total]] = await Promise.all([
      db.select({ id: messages.id, sessionName: sessions.name, remoteJid: messages.remoteJid, direction: messages.direction, type: messages.type, status: messages.status, createdAt: messages.createdAt, error: messages.error }).from(messages).innerJoin(sessions, eq(sessions.id, messages.sessionId)).where(filter).orderBy(desc(messages.createdAt), desc(messages.id)).limit(25).offset((page - 1) * 25),
      db.select({ count: sql<number>`count(*)::int` }).from(messages).innerJoin(sessions, eq(sessions.id, messages.sessionId)).where(filter),
    ]);
    return ok({ items, total: total?.count ?? 0, page, pageSize: 25 });
  });

  r.get('/api/console/keys', async (req) => {
    requirePat(req);
    return ok(await db.select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, sessionId: apiKeys.sessionId, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt, createdAt: apiKeys.createdAt }).from(apiKeys).where(eq(apiKeys.workspaceId, req.auth.workspaceId)).orderBy(desc(apiKeys.createdAt)).limit(100));
  });

  r.post('/api/console/keys', { schema: { body: z.object({ name: z.string().trim().min(1).max(100), sessionId: z.uuid().nullable() }) } }, async (req, reply) => {
    requirePat(req);
    if (req.body.sessionId) await resolveSession(app, req, req.body.sessionId);
    const generated = generateApiKey(req.body.sessionId ? 'session' : 'pat');
    const result = await db.transaction(async (tx) => {
      const [key] = await tx.insert(apiKeys).values({ workspaceId: req.auth.workspaceId, sessionId: req.body.sessionId, name: req.body.name, keyHash: generated.keyHash, prefix: generated.prefix }).returning({ id: apiKeys.id });
      await tx.insert(auditLogs).values({ workspaceId: req.auth.workspaceId, actor: req.auth.keyId, action: 'api_key.created', entity: key!.id });
      return key;
    });
    reply.code(201);
    return ok({ id: result!.id, key: generated.key });
  });

  r.post('/api/console/keys/:id/revoke', { schema: { params: z.object({ id: z.uuid() }) } }, async (req) => {
    requirePat(req);
    return db.transaction(async (tx) => {
      const [row] = await tx.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.workspaceId, req.auth.workspaceId), isNull(apiKeys.revokedAt))).returning({ id: apiKeys.id });
      if (!row) throw notFound('Key not found');
      await tx.insert(auditLogs).values({ workspaceId: req.auth.workspaceId, actor: req.auth.keyId, action: 'api_key.revoked', entity: row.id });
      return ok({ id: row.id });
    });
  });

  r.patch('/api/console/workspace', { schema: { body: z.object({ name: z.string().trim().min(1).max(100) }) } }, async (req) => {
    requirePat(req);
    await db.update(workspaces).set({ name: req.body.name }).where(eq(workspaces.id, req.auth.workspaceId));
    return ok({ name: req.body.name });
  });

  /* ---- Client billing (manual requests; no gateway yet) ---- */

  r.get('/api/console/billing', async (req) => {
    requirePat(req);
    const workspace = await db.query.workspaces.findFirst({ where: eq(workspaces.id, req.auth.workspaceId) });
    if (!workspace) throw notFound();
    const [requests, methods] = await Promise.all([
      db.select(paymentRow).from(paymentRequests).where(eq(paymentRequests.workspaceId, req.auth.workspaceId)).orderBy(desc(paymentRequests.createdAt)).limit(50),
      db.select({ id: paymentMethods.id, label: paymentMethods.label, details: paymentMethods.details, instructions: paymentMethods.instructions }).from(paymentMethods).where(eq(paymentMethods.enabled, true)).orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.createdAt)),
    ]);
    return ok({
      plan: effectivePlan(workspace),
      planId: workspace.planId,
      planExpiresAt: workspace.planExpiresAt,
      trialEndsAt: workspace.trialEndsAt,
      plans: publicPlans(),
      methods,
      requests,
    });
  });

  r.post(
    '/api/console/billing/request',
    {
      schema: {
        body: z.object({
          planId: z.string().trim().min(1).max(40),
          months: z.number().int().min(1).max(12).default(1),
          methodId: z.uuid(),
          reference: z.string().trim().max(120).optional(),
          note: z.string().trim().max(500).optional(),
        }),
      },
    },
    async (req, reply) => {
      requirePat(req);
      const plan = getPlan(req.body.planId);
      if (!plan || plan.internal || !plan.enabled || plan.id === 'trial') throw notFound('الباقة غير متاحة');
      const method = await db.query.paymentMethods.findFirst({ where: and(eq(paymentMethods.id, req.body.methodId), eq(paymentMethods.enabled, true)) });
      if (!method) throw notFound('طريقة الدفع غير متاحة');
      const pending = await db.query.paymentRequests.findFirst({ where: and(eq(paymentRequests.workspaceId, req.auth.workspaceId), eq(paymentRequests.status, 'pending')) });
      if (pending) throw conflict('لديك طلب دفع قيد المراجعة بالفعل');
      const [row] = await db
        .insert(paymentRequests)
        .values({ workspaceId: req.auth.workspaceId, planId: plan.id, amountEgp: plan.egp * req.body.months, months: req.body.months, methodId: method.id, method: method.label, reference: req.body.reference, note: req.body.note })
        .returning();
      reply.code(201);
      return ok(row);
    },
  );

  /* ---- Platform admin (server-enforced via PLATFORM_ADMIN_EMAILS or Neon role) ---- */

  r.get('/api/admin/overview', async (req) => {
    requireAdmin(req);
    const [clients, infrastructure, sessionList, [counts], [pendingPayments]] = await Promise.all([
      db.select({ id: workspaces.id, name: workspaces.name, email: users.email, planId: workspaces.planId, planExpiresAt: workspaces.planExpiresAt, suspendedAt: workspaces.suspendedAt, createdAt: workspaces.createdAt }).from(workspaces).leftJoin(users, eq(workspaces.ownerId, users.id)).orderBy(desc(workspaces.createdAt)).limit(100),
      db.select().from(workers).orderBy(desc(workers.lastSeenAt)).limit(100),
      db.select({ id: sessions.id, name: sessions.name, workspace: workspaces.name, workspaceId: workspaces.id, status: sessions.status, phone: sessions.phone, lastSeenAt: sessions.lastSeenAt }).from(sessions).innerJoin(workspaces, eq(workspaces.id, sessions.workspaceId)).orderBy(desc(sessions.createdAt)).limit(200),
      db.select({ workspaces: sql<number>`count(*)::int`, sessions: sql<number>`(select count(*) from sessions)::int`, messages: sql<number>`(select count(*) from messages)::int` }).from(workspaces),
      db.select({ count: sql<number>`count(*)::int` }).from(paymentRequests).where(eq(paymentRequests.status, 'pending')),
    ]);
    return ok({ clients, workers: infrastructure, sessions: sessionList, counts: counts ?? { workspaces: 0, sessions: 0, messages: 0 }, pendingPayments: pendingPayments?.count ?? 0 });
  });

  r.post(
    '/api/admin/clients',
    {
      schema: { body: z.object({ email: z.string().trim().toLowerCase().email(), name: z.string().trim().min(1).max(100), planId: z.string().trim().min(1).max(40).default('trial') }) },
    },
    async (req, reply) => {
      requireAdmin(req);
      const { email, name, planId } = req.body;
      if (!getPlan(planId)) throw badRequest('باقة غير موجودة');
      const result = await db.transaction(async (tx) => {
        let [user] = await tx.select().from(users).where(eq(users.email, email));
        if (!user) [user] = await tx.insert(users).values({ email }).returning();
        const months = planId === 'trial' ? 0 : 1;
        const [ws] = await tx
          .insert(workspaces)
          .values({ ownerId: user!.id, name, planId, trialEndsAt: planId === 'trial' ? new Date(Date.now() + 3 * 86400000) : null, planExpiresAt: months ? new Date(Date.now() + months * 30 * 86400000) : null })
          .returning();
        const pat = generateApiKey('pat');
        await tx.insert(apiKeys).values({ workspaceId: ws!.id, name: 'owner', keyHash: pat.keyHash, prefix: pat.prefix });
        await tx.insert(auditLogs).values({ workspaceId: ws!.id, actor: req.auth.email ?? req.auth.keyId, action: 'admin.client_created', entity: ws!.id, meta: { email, planId } });
        return { workspace: ws, key: pat.key, email };
      });
      reply.code(201);
      return ok(result);
    },
  );

  r.patch(
    '/api/admin/clients/:id',
    {
      schema: {
        params: z.object({ id: z.uuid() }),
        body: z.object({ planId: z.string().trim().min(1).max(40).optional(), extendMonths: z.number().int().min(1).max(24).optional(), suspend: z.boolean().optional() }),
      },
    },
    async (req) => {
      requireAdmin(req);
      const ws = await db.query.workspaces.findFirst({ where: eq(workspaces.id, req.params.id) });
      if (!ws) throw notFound('Workspace not found');
      const patch: Partial<typeof workspaces.$inferInsert> = {};
      if (req.body.planId) {
        if (!getPlan(req.body.planId)) throw badRequest('باقة غير موجودة');
        patch.planId = req.body.planId;
        patch.planExpiresAt =
          req.body.planId === 'trial' ? null : req.body.planId === 'unlimited' ? new Date('2099-12-31') : new Date(Date.now() + (req.body.extendMonths ?? 1) * 30 * 86400000);
      } else if (req.body.extendMonths) {
        const base = ws.planExpiresAt && ws.planExpiresAt.getTime() > Date.now() ? ws.planExpiresAt.getTime() : Date.now();
        patch.planExpiresAt = new Date(base + req.body.extendMonths * 30 * 86400000);
      }
      if (req.body.suspend !== undefined) patch.suspendedAt = req.body.suspend ? new Date() : null;
      const [updated] = await db.update(workspaces).set(patch).where(eq(workspaces.id, ws.id)).returning();
      await db.insert(auditLogs).values({ workspaceId: ws.id, actor: req.auth.email ?? req.auth.keyId, action: 'admin.client_updated', entity: ws.id, meta: req.body });
      return ok(updated);
    },
  );

  r.get('/api/admin/payments', { schema: { querystring: z.object({ status: z.enum(['all', 'pending', 'approved', 'rejected']).default('all') }) } }, async (req) => {
    requireAdmin(req);
    const filter = req.query.status === 'all' ? undefined : eq(paymentRequests.status, req.query.status);
    const rows = await db
      .select({ ...paymentRow, workspaceId: paymentRequests.workspaceId, workspaceName: workspaces.name, email: users.email, reviewedBy: paymentRequests.reviewedBy })
      .from(paymentRequests)
      .innerJoin(workspaces, eq(workspaces.id, paymentRequests.workspaceId))
      .leftJoin(users, eq(workspaces.ownerId, users.id))
      .where(filter)
      .orderBy(desc(paymentRequests.createdAt))
      .limit(200);
    return ok(rows);
  });

  const reviewSchema = { params: z.object({ id: z.uuid() }), body: z.object({ note: z.string().trim().max(500).optional() }).optional() };

  r.post('/api/admin/payments/:id/approve', { schema: reviewSchema }, async (req) => {
    requireAdmin(req);
    const request = await db.query.paymentRequests.findFirst({ where: eq(paymentRequests.id, req.params.id) });
    if (!request) throw notFound('Request not found');
    if (request.status !== 'pending') throw conflict('Request already reviewed');
    await db.transaction(async (tx) => {
      await tx.update(paymentRequests).set({ status: 'approved', adminNote: req.body?.note ?? null, reviewedBy: req.auth.email ?? req.auth.keyId, reviewedAt: new Date() }).where(eq(paymentRequests.id, request.id));
      const ws = await tx.query.workspaces.findFirst({ where: eq(workspaces.id, request.workspaceId) });
      const base = ws?.planExpiresAt && ws.planExpiresAt.getTime() > Date.now() ? ws.planExpiresAt.getTime() : Date.now();
      await tx.update(workspaces).set({ planId: request.planId, planExpiresAt: new Date(base + request.months * 30 * 86400000) }).where(eq(workspaces.id, request.workspaceId));
      await tx.insert(auditLogs).values({ workspaceId: request.workspaceId, actor: req.auth.email ?? req.auth.keyId, action: 'admin.payment_approved', entity: request.id, meta: { planId: request.planId, months: request.months } });
    });
    return ok({ id: request.id, status: 'approved' });
  });

  r.post('/api/admin/payments/:id/reject', { schema: reviewSchema }, async (req) => {
    requireAdmin(req);
    const request = await db.query.paymentRequests.findFirst({ where: eq(paymentRequests.id, req.params.id) });
    if (!request) throw notFound('Request not found');
    if (request.status !== 'pending') throw conflict('Request already reviewed');
    await db.update(paymentRequests).set({ status: 'rejected', adminNote: req.body?.note ?? null, reviewedBy: req.auth.email ?? req.auth.keyId, reviewedAt: new Date() }).where(eq(paymentRequests.id, request.id));
    await db.insert(auditLogs).values({ workspaceId: request.workspaceId, actor: req.auth.email ?? req.auth.keyId, action: 'admin.payment_rejected', entity: request.id });
    return ok({ id: request.id, status: 'rejected' });
  });

  /* ---- Admin: subscription plans (names, prices, limits) ---- */

  r.get('/api/admin/plans', async (req) => {
    requireAdmin(req);
    return ok(await db.select().from(plans).orderBy(asc(plans.sortOrder), asc(plans.egp)));
  });

  const planSchema = z.object({
    key: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_-]{1,29}$/, 'المعرف: أحرف إنجليزية صغيرة وأرقام فقط'),
    name: z.string().trim().min(1).max(60),
    egp: z.number().int().min(0).max(1_000_000),
    sessions: z.number().int().min(1).max(10_000),
    dailyMessages: z.number().int().min(1).max(10_000_000).nullable().default(null),
    internal: z.boolean().default(false),
    enabled: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(999).default(0),
  });

  r.post('/api/admin/plans', { schema: { body: planSchema } }, async (req, reply) => {
    requireAdmin(req);
    const { key, ...rest } = req.body;
    const [row] = await db.insert(plans).values({ key, ...rest }).returning();
    await refreshPlans(db);
    reply.code(201);
    return ok(row);
  });

  // No .default()s — omitted fields must stay untouched.
  const planPatchSchema = z.object({
    name: z.string().trim().min(1).max(60).optional(),
    egp: z.number().int().min(0).max(1_000_000).optional(),
    sessions: z.number().int().min(1).max(10_000).optional(),
    dailyMessages: z.number().int().min(1).max(10_000_000).nullable().optional(),
    internal: z.boolean().optional(),
    enabled: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  });

  r.patch('/api/admin/plans/:key', { schema: { params: z.object({ key: z.string().min(1).max(40) }), body: planPatchSchema } }, async (req) => {
    requireAdmin(req);
    const [row] = await db.update(plans).set(req.body).where(eq(plans.key, req.params.key)).returning();
    if (!row) throw notFound('Plan not found');
    await refreshPlans(db);
    return ok(row);
  });

  /* ---- Admin: payment transfer methods (InstaPay number, wallets, bank…) ---- */

  r.get('/api/admin/payment-methods', async (req) => {
    requireAdmin(req);
    return ok(await db.select().from(paymentMethods).orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.createdAt)));
  });

  const methodSchema = z.object({
    label: z.string().trim().min(1).max(60),
    details: z.string().trim().max(300).default(''),
    instructions: z.string().trim().max(1000).default(''),
    enabled: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(999).default(0),
  });

  r.post('/api/admin/payment-methods', { schema: { body: methodSchema } }, async (req, reply) => {
    requireAdmin(req);
    const [row] = await db.insert(paymentMethods).values(req.body).returning();
    reply.code(201);
    return ok(row);
  });

  // Update schema has no .default()s — omitted fields must stay untouched.
  const methodPatchSchema = z.object({
    label: z.string().trim().min(1).max(60).optional(),
    details: z.string().trim().max(300).optional(),
    instructions: z.string().trim().max(1000).optional(),
    enabled: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(999).optional(),
  });
  r.patch('/api/admin/payment-methods/:id', { schema: { params: z.object({ id: z.uuid() }), body: methodPatchSchema } }, async (req) => {
    requireAdmin(req);
    const [row] = await db.update(paymentMethods).set(req.body).where(eq(paymentMethods.id, req.params.id)).returning();
    if (!row) throw notFound('Method not found');
    return ok(row);
  });

  r.delete('/api/admin/payment-methods/:id', { schema: { params: z.object({ id: z.uuid() }) } }, async (req) => {
    requireAdmin(req);
    const [row] = await db.delete(paymentMethods).where(eq(paymentMethods.id, req.params.id)).returning({ id: paymentMethods.id });
    if (!row) throw notFound('Method not found');
    return ok({ id: row.id, deleted: true });
  });
}
