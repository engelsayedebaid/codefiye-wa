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
  /**
   * Persists the current creds. Saves run one at a time and coalesce (a save asked for while one is
   * running writes the latest creds once it's done), so an older snapshot can never land after a
   * newer one; transient failures are retried.
   */
  saveCreds: () => Promise<void>;
  /** Resolves once every save asked for so far has been written (or has finally failed). */
  flush: () => Promise<void>;
  /** Wipes creds and keys, e.g. after the device was logged out. */
  clear: () => Promise<void>;
};

/**
 * A store refused a write because this process no longer owns the session (another worker took it
 * over): raised by @wa/db as an error named `AuthFenceError`. Never retried — the stale writer must stop, not win.
 */
export const isFenceError = (err: unknown) => (err as Error | undefined)?.name === 'AuthFenceError';

const CREDS = { type: 'creds', id: 'creds' } as const;
/** Retry delays for a failed creds write (transient database trouble). */
const SAVE_RETRY_MS = [500, 1_000, 2_000, 4_000, 8_000];

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

  // A failed read (database down, wrong key, corrupt row) throws: the caller retries later. It is
  // never mistaken for "no session", which would mint new creds and lose the link.
  const stored = (await store.get(CREDS.type, [CREDS.id])).get(CREDS.id);
  const creds: AuthenticationCreds = stored ? open(CREDS.type, CREDS.id, stored) : initAuthCreds();

  // One writer for creds: `pending` is the running save, `again` asks for one more after it.
  let pending: Promise<void> | null = null;
  let again = false;
  const writeCreds = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        // Sealed at write time: always the latest creds, never a stale snapshot.
        return await store.set([{ ...CREDS, value: seal(CREDS.type, CREDS.id, creds) }]);
      } catch (err) {
        const delay = SAVE_RETRY_MS[attempt];
        if (isFenceError(err) || delay === undefined) throw err;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  };
  const saveCreds = (): Promise<void> => {
    if (pending) {
      again = true;
      return pending;
    }
    pending = (async () => {
      try {
        do {
          again = false;
          await writeCreds();
        } while (again);
      } finally {
        pending = null;
      }
    })();
    return pending;
  };

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
    saveCreds,
    flush: async () => {
      while (pending) await pending.catch(() => {});
    },
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
