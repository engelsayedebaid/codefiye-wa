import {
  type AuthenticationCreds,
  type AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  type SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { decrypt, encrypt } from './crypto';

/** Persistence for encrypted auth blobs. Implemented over Postgres by @wa/db `pgAuthStore`. */
export interface AuthStore {
  get(type: string, ids: string[]): Promise<Map<string, Buffer>>;
  /** `value: null` deletes the entry. */
  set(entries: { type: string; id: string; value: Buffer | null }[]): Promise<void>;
  clear(): Promise<void>;
}

export type EncryptedAuthState = {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  /** Wipes creds and keys, e.g. after the device was logged out. */
  clear: () => Promise<void>;
};

const CREDS = { type: 'creds', id: 'creds' } as const;

/**
 * Replacement for Baileys' `useMultiFileAuthState` (README §4.1): creds and signal keys live in
 * `session_auth`, each value JSON-encoded with BufferJSON then AES-256-GCM encrypted with
 * AAD = `sessionId:type:id`.
 */
export async function useEncryptedAuthState(
  store: AuthStore,
  sessionId: string,
  key: Buffer,
): Promise<EncryptedAuthState> {
  const aad = (type: string, id: string) => `${sessionId}:${type}:${id}`;
  const seal = (type: string, id: string, value: unknown) =>
    encrypt(key, Buffer.from(JSON.stringify(value, BufferJSON.replacer)), aad(type, id));
  const open = (type: string, id: string, blob: Buffer) =>
    JSON.parse(decrypt(key, blob, aad(type, id)).toString(), BufferJSON.reviver);

  const stored = (await store.get(CREDS.type, [CREDS.id])).get(CREDS.id);
  const creds: AuthenticationCreds = stored ? open(CREDS.type, CREDS.id, stored) : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
          const rows = await store.get(type, ids);
          const result: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const [id, blob] of rows) {
            let value = open(type, id, blob);
            if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
            result[id] = value;
          }
          return result;
        },
        async set(data) {
          const entries: { type: string; id: string; value: Buffer | null }[] = [];
          for (const [type, values] of Object.entries(data)) {
            for (const [id, value] of Object.entries(values ?? {})) {
              entries.push({ type, id, value: value ? seal(type, id, value) : null });
            }
          }
          if (entries.length > 0) await store.set(entries);
        },
      },
    },
    saveCreds: () => store.set([{ ...CREDS, value: seal(CREDS.type, CREDS.id, creds) }]),
    clear: () => store.clear(),
  };
}

/** In-memory AuthStore for tests and the POC. */
export function memoryAuthStore(): AuthStore & { rows: Map<string, Buffer> } {
  const rows = new Map<string, Buffer>();
  const k = (type: string, id: string) => `${type}\u0000${id}`;
  return {
    rows,
    async get(type, ids) {
      const out = new Map<string, Buffer>();
      for (const id of ids) {
        const v = rows.get(k(type, id));
        if (v) out.set(id, v);
      }
      return out;
    },
    async set(entries) {
      for (const e of entries) {
        if (e.value) rows.set(k(e.type, e.id), e.value);
        else rows.delete(k(e.type, e.id));
      }
    },
    async clear() {
      rows.clear();
    },
  };
}
