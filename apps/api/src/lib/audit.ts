import { auditLogs, type Db, type Sql, sqlExpr, type TxSql } from '@wa/db';
import type { FastifyRequest } from 'fastify';

export type AuditEntry = {
  action: string;
  targetType: 'user' | 'workspace' | 'plan_request' | 'broadcast';
  targetId?: string | null;
  /** What the target was called at the time (e.g. an email), since it may be deleted later. */
  targetLabel?: string | null;
  details?: Record<string, unknown>;
};

type DrizzleTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** Appends an operator action to `audit_logs` inside a raw-SQL transaction, so it commits with the change. */
export async function audit(sql: Sql | TxSql, req: FastifyRequest, entry: AuditEntry) {
  const actor = req.auth.userId;
  await sql`
    insert into audit_logs (actor_id, actor_email, action, target_type, target_id, target_label, details, ip)
    values (${actor}, (select email from users where id = ${actor}), ${entry.action}, ${entry.targetType},
            ${entry.targetId ?? null}, ${entry.targetLabel ?? null}, ${sql.json((entry.details ?? {}) as never)}, ${req.ip})`;
}

/** Same, inside a drizzle transaction. */
export async function auditIn(tx: DrizzleTx, req: FastifyRequest, entry: AuditEntry) {
  const actor = req.auth.userId;
  await tx.insert(auditLogs).values({
    actorId: actor,
    actorEmail: actor ? sqlExpr`(select email from users where id = ${actor})` : null,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId ?? null,
    targetLabel: entry.targetLabel ?? null,
    details: entry.details ?? {},
    ip: req.ip,
  });
}
