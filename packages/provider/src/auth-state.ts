import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { and, eq, inArray, sessionAuth, sessionAuthKeys, sql, type Db } from '@wa/db';
import { decrypt, encrypt } from './crypto';

const serialize = (value: unknown) => Buffer.from(JSON.stringify(value, BufferJSON.replacer));
const deserialize = <T>(buf: Buffer): T => JSON.parse(buf.toString('utf8'), BufferJSON.reviver);

/**
 * Baileys auth state persisted in Postgres, encrypted with AES-256-GCM.
 * Replaces `useMultiFileAuthState` for production use.
 */
export async function usePostgresAuthState(db: Db, sessionId: string, key: Buffer) {
  const credsAad = `${sessionId}:creds`;
  const keyAad = (type: string, id: string) => `${sessionId}:${type}:${id}`;

  const row = await db.query.sessionAuth.findFirst({ where: eq(sessionAuth.sessionId, sessionId) });
  const creds: AuthenticationCreds = row ? deserialize(decrypt(key, row.creds, credsAad)) : initAuthCreds();

  const state: AuthenticationState = {
    creds,
    keys: {
      async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
        const out: { [id: string]: SignalDataTypeMap[T] } = {};
        if (!ids.length) return out;
        const rows = await db
          .select({ keyId: sessionAuthKeys.keyId, value: sessionAuthKeys.value })
          .from(sessionAuthKeys)
          .where(and(eq(sessionAuthKeys.sessionId, sessionId), eq(sessionAuthKeys.type, type), inArray(sessionAuthKeys.keyId, ids)));
        for (const r of rows) {
          let value = deserialize<any>(decrypt(key, r.value, keyAad(type, r.keyId)));
          if (type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value);
          out[r.keyId] = value;
        }
        return out;
      },
      async set(data) {
        const upserts: (typeof sessionAuthKeys.$inferInsert)[] = [];
        const deletes: { type: string; ids: string[] }[] = [];
        for (const [type, entries] of Object.entries(data)) {
          const removed: string[] = [];
          for (const [id, value] of Object.entries(entries ?? {})) {
            if (value) upserts.push({ sessionId, type, keyId: id, value: encrypt(key, serialize(value), keyAad(type, id)) });
            else removed.push(id);
          }
          if (removed.length) deletes.push({ type, ids: removed });
        }
        if (!upserts.length && !deletes.length) return;
        await db.transaction(async (tx) => {
          if (upserts.length)
            await tx
              .insert(sessionAuthKeys)
              .values(upserts)
              .onConflictDoUpdate({
                target: [sessionAuthKeys.sessionId, sessionAuthKeys.type, sessionAuthKeys.keyId],
                set: { value: sql`excluded.value`, updatedAt: sql`now()` },
              });
          for (const d of deletes)
            await tx
              .delete(sessionAuthKeys)
              .where(and(eq(sessionAuthKeys.sessionId, sessionId), eq(sessionAuthKeys.type, d.type), inArray(sessionAuthKeys.keyId, d.ids)));
        });
      },
      async clear() {
        await db.delete(sessionAuthKeys).where(eq(sessionAuthKeys.sessionId, sessionId));
      },
    },
  };

  const saveCreds = async () => {
    const value = encrypt(key, serialize(state.creds), credsAad);
    await db
      .insert(sessionAuth)
      .values({ sessionId, creds: value })
      .onConflictDoUpdate({ target: sessionAuth.sessionId, set: { creds: value, updatedAt: new Date() } });
  };

  /** Wipe all credentials for this session (used after logout). */
  const clear = async () => {
    await db.transaction(async (tx) => {
      await tx.delete(sessionAuthKeys).where(eq(sessionAuthKeys.sessionId, sessionId));
      await tx.delete(sessionAuth).where(eq(sessionAuth.sessionId, sessionId));
    });
  };

  return { state, saveCreds, clear };
}

export type PostgresAuthState = Awaited<ReturnType<typeof usePostgresAuthState>>;
