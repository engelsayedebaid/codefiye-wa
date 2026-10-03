import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { notify, type Sql } from '@wa/db';
import { type AuthInvalidation, CHANNELS, type WaEvent } from '@wa/shared';
import type { Logger } from 'pino';

const RESYNC = Symbol('resync');
const REVOKE = Symbol('revoke');
const HEARTBEAT = Symbol('heartbeat');

const HEARTBEAT_EVERY_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

export type EventBusOptions = {
  /** A fresh single-connection client on the direct URL (PgBouncer drops LISTEN). */
  createListener: () => Sql;
  /** Any client: publishes the heartbeat. */
  sql: Sql;
  logger: Logger;
  /** Credential revocations from other API instances (`wa_auth`). */
  onAuth?: (target: AuthInvalidation) => void;
};

/**
 * Fans out worker events (Postgres NOTIFY `wa_events`) to in-process subscribers by workspace.
 *
 * Two failure modes are handled: postgres.js re-LISTENs after a dropped connection, but whatever
 * was published in the gap is gone — subscribers get `resync` then, so clients reload instead of
 * showing stale state. And if that re-LISTEN itself fails (database still down), postgres.js gives
 * up silently; a heartbeat through our own channel detects the deaf listener and rebuilds it.
 */
export class EventBus {
  private readonly emitter = new EventEmitter().setMaxListeners(0);
  private listener: Sql | null = null;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;

  constructor(private readonly options: EventBusOptions) {}

  async start() {
    await this.connectListener();
    this.timer = setInterval(() => void this.heartbeat(), HEARTBEAT_EVERY_MS);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    await this.listener?.end({ timeout: 1 }).catch(() => {});
  }

  private async connectListener() {
    const listener = this.options.createListener();
    let subscribed = false;
    await listener.listen(
      CHANNELS.events,
      (payload) => {
        let event: WaEvent | { type: 'heartbeat'; nonce: string };
        try {
          event = JSON.parse(payload);
        } catch {
          return; // ignore malformed payloads
        }
        if (event.type === 'heartbeat') this.emitter.emit(HEARTBEAT, event.nonce);
        else this.emitter.emit(event.workspaceId, event);
      },
      () => {
        if (subscribed) this.emitter.emit(RESYNC);
        subscribed = true;
      },
    );
    await listener.listen(CHANNELS.auth, (payload) => {
      try {
        const target = JSON.parse(payload) as AuthInvalidation;
        this.options.onAuth?.(target);
        this.emitter.emit(REVOKE, target);
      } catch {
        // ignore malformed payloads
      }
    });
    this.listener = listener;
  }

  /** Publishes a nonce on our own channel; if it doesn't come back, the listener is rebuilt. */
  private async heartbeat() {
    if (this.checking) return;
    this.checking = true;
    try {
      const nonce = randomUUID();
      const arrived = new Promise<boolean>((resolve) => {
        const onBeat = (n: string) => {
          if (n !== nonce) return;
          clearTimeout(timer);
          this.emitter.off(HEARTBEAT, onBeat);
          resolve(true);
        };
        const timer = setTimeout(() => {
          this.emitter.off(HEARTBEAT, onBeat);
          resolve(false);
        }, HEARTBEAT_TIMEOUT_MS);
        this.emitter.on(HEARTBEAT, onBeat);
      });
      try {
        await notify(this.options.sql, CHANNELS.events, { type: 'heartbeat', nonce });
      } catch {
        return; // database unreachable: nothing to repair until it's back
      }
      if (await arrived) return;
      this.options.logger.warn('event listener stopped receiving notifications; reconnecting');
      const previous = this.listener;
      try {
        await this.connectListener();
      } catch (err) {
        this.options.logger.error({ err }, 'event listener reconnect failed; will retry');
        return;
      }
      await previous?.end({ timeout: 1 }).catch(() => {});
      this.emitter.emit(RESYNC);
    } finally {
      this.checking = false;
    }
  }

  subscribe(workspaceId: string, handler: (event: WaEvent) => void): () => void {
    this.emitter.on(workspaceId, handler);
    return () => void this.emitter.off(workspaceId, handler);
  }

  /** Called after the event stream reconnected and events may have been missed. */
  onResync(handler: () => void): () => void {
    this.emitter.on(RESYNC, handler);
    return () => void this.emitter.off(RESYNC, handler);
  }

  /** Called when credentials were revoked (logout elsewhere, suspension, deletion) on any instance. */
  onRevoke(handler: (target: AuthInvalidation) => void): () => void {
    this.emitter.on(REVOKE, handler);
    return () => void this.emitter.off(REVOKE, handler);
  }

  /** Resolves with the first matching event, or null after `timeoutMs`. */
  waitFor(workspaceId: string, match: (event: WaEvent) => boolean, timeoutMs: number): Promise<WaEvent | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe();
        resolve(null);
      }, timeoutMs);
      const unsubscribe = this.subscribe(workspaceId, (event) => {
        if (!match(event)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      });
    });
  }
}
