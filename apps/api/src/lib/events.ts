import { EventEmitter } from 'node:events';
import type { EventBus } from '@wa/db';
import type { PlatformEvent } from '@wa/shared';

/** Single Postgres LISTEN fanned out in-process, so N SSE clients cost one connection. */
export class EventHub {
  private emitter = new EventEmitter().setMaxListeners(0);
  private unlisten?: () => Promise<void>;

  constructor(private readonly bus: EventBus) {}

  async start() {
    this.unlisten = await this.bus.subscribe((e) => this.emitter.emit(e.sessionId, e));
  }

  subscribe(sessionId: string, listener: (e: PlatformEvent) => void) {
    this.emitter.on(sessionId, listener);
    return () => void this.emitter.off(sessionId, listener);
  }

  async close() {
    await this.unlisten?.();
  }
}
