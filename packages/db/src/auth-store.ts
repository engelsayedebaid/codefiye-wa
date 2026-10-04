import type { Sql, TxSql } from './client';

/** Raised when a worker writes auth state for a session it no longer owns (matched by name in @wa/provider). */
export class AuthFenceError extends Error {
  override name = 'AuthFenceError';
}

/**
 * Row-level store behind `useEncryptedAuthState` (structurally matches @wa/provider's AuthStore).
 *
 * With `workerId`, every write is fenced on ownership like every other session write of a worker:
 * it runs only while `sessions.worker_id` is that worker, holding a share lock on the session row so
 * a takeover can't slip in mid-write. A worker that stalled and lost the session can therefore never
 * overwrite the new owner's keys with stale ones. Without `workerId` (API logout, tests) writes are
 * unfenced.
 */
export function pgAuthStore(sql: Sql, sessionId: string, { workerId }: { workerId?: string } = {}) {
  const fence = async (tx: TxSql) => {
    if (!workerId) return;
    const [owned] = await tx`select 1 from sessions where id = ${sessionId} and worker_id = ${workerId} for share`;
    if (!owned) throw new AuthFenceError(`Session ${sessionId} is no longer owned by worker ${workerId}`);
  };

  return {
    async get(type: string, ids: string[]): Promise<Map<string, Buffer>> {
      if (ids.length === 0) return new Map();
      const rows = await sql<{ key_id: string; value: Buffer }[]>`
        select key_id, value from session_auth
        where session_id = ${sessionId} and type = ${type} and key_id = any(${ids})`;
      return new Map(rows.map((r) => [r.key_id, r.value]));
    },

    async scan(type: string, suffix: string): Promise<Map<string, Buffer>> {
      const rows = await sql<{ key_id: string; value: Buffer }[]>`
        select key_id, value from session_auth
        where session_id = ${sessionId} and type = ${type} and right(key_id, ${suffix.length}) = ${suffix}`;
      return new Map(rows.map((r) => [r.key_id, r.value]));
    },

    /** All-or-nothing: the upserts and deletes of one call commit together or not at all. */
    async set(entries: { type: string; id: string; value: Buffer | null }[]): Promise<void> {
      const upserts = entries
        .filter((e) => e.value !== null)
        .map((e) => ({ session_id: sessionId, type: e.type, key_id: e.id, value: e.value! }));
      const deletes = entries.filter((e) => e.value === null);
      await sql.begin(async (tx) => {
        await fence(tx);
        if (upserts.length > 0) {
          await tx`
            insert into session_auth ${tx(upserts, 'session_id', 'type', 'key_id', 'value')}
            on conflict (session_id, type, key_id) do update set value = excluded.value, updated_at = now()`;
        }
        if (deletes.length > 0) {
          await tx`
            delete from session_auth s using unnest(${deletes.map((d) => d.type)}::text[], ${deletes.map((d) => d.id)}::text[]) as d(type, key_id)
            where s.session_id = ${sessionId} and s.type = d.type and s.key_id = d.key_id`;
        }
      });
    },

    /** Deletes every credential of the session: only for a confirmed logout or an explicit unlink. */
    async clear(): Promise<void> {
      await sql.begin(async (tx) => {
        await fence(tx);
        await tx`delete from session_auth where session_id = ${sessionId}`;
      });
    },
  };
}
