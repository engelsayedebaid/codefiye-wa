import type { Sql } from './client';

/** Row-level store behind `useEncryptedAuthState` (structurally matches @wa/provider's AuthStore). */
export function pgAuthStore(sql: Sql, sessionId: string) {
  return {
    async get(type: string, ids: string[]): Promise<Map<string, Buffer>> {
      if (ids.length === 0) return new Map();
      const rows = await sql<{ key_id: string; value: Buffer }[]>`
        select key_id, value from session_auth
        where session_id = ${sessionId} and type = ${type} and key_id = any(${ids})`;
      return new Map(rows.map((r) => [r.key_id, r.value]));
    },

    async set(entries: { type: string; id: string; value: Buffer | null }[]): Promise<void> {
      const upserts = entries
        .filter((e) => e.value !== null)
        .map((e) => ({ session_id: sessionId, type: e.type, key_id: e.id, value: e.value! }));
      const deletes = entries.filter((e) => e.value === null);
      await sql.begin(async (tx) => {
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

    async clear(): Promise<void> {
      await sql`delete from session_auth where session_id = ${sessionId}`;
    },
  };
}
