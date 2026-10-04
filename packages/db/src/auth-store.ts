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

    /**
     * All-or-nothing: the upserts and deletes of one call commit together or not at all. One
     * statement (an implicit transaction) holding the fence's share lock: Baileys awaits this on every
     * encrypted send, so it costs one round trip instead of BEGIN, fence, write and COMMIT.
     */
    async set(entries: { type: string; id: string; value: Buffer | null }[]): Promise<void> {
      if (entries.length === 0) return;
      const upserts = entries.filter((e) => e.value !== null);
      const deletes = entries.filter((e) => e.value === null);
      const owned = workerId ? sql`select 1 from sessions where id = ${sessionId} and worker_id = ${workerId} for share` : sql`select 1`;
      const [row] = await sql<{ owned: boolean }[]>`
        with owned as (${owned}),
        up as (
          insert into session_auth (session_id, type, key_id, value)
          select ${sessionId}, u.type, u.key_id, decode(u.hex, 'hex')
          -- postgres.js can't bind a bytea[]: the values travel as hex text.
          from unnest(${upserts.map((e) => e.type)}::text[], ${upserts.map((e) => e.id)}::text[], ${upserts.map((e) => e.value!.toString('hex'))}::text[]) as u(type, key_id, hex)
          where exists (select 1 from owned)
          on conflict (session_id, type, key_id) do update set value = excluded.value, updated_at = now()
          returning 1
        ),
        del as (
          delete from session_auth s
          using unnest(${deletes.map((d) => d.type)}::text[], ${deletes.map((d) => d.id)}::text[]) as d(type, key_id)
          where exists (select 1 from owned) and s.session_id = ${sessionId} and s.type = d.type and s.key_id = d.key_id
          returning 1
        )
        select exists (select 1 from owned) as owned, (select count(*) from up) + (select count(*) from del) as changed`;
      if (!row?.owned) throw new AuthFenceError(`Session ${sessionId} is no longer owned by worker ${workerId}`);
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
