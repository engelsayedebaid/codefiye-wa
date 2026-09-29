import postgres from 'postgres';
import { EVENTS_CHANNEL, type PlatformEvent } from '@wa/shared';

const MAX_PAYLOAD = 7900;

/**
 * Cross-process event bus over Postgres LISTEN/NOTIFY.
 * Needs a direct (non-pooled) connection: PgBouncer transaction mode can't hold LISTEN.
 */
export function createEventBus(url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const sql = postgres(url, { max: 2, prepare: false, onnotice: () => {} });

  return {
    async publish(event: PlatformEvent) {
      let payload = JSON.stringify(event);
      if (Buffer.byteLength(payload) > MAX_PAYLOAD && event.event === 'messages.received') {
        payload = JSON.stringify({ ...event, data: { ...event.data, text: event.data.text?.slice(0, 2000) ?? null, truncated: true } });
      }
      if (Buffer.byteLength(payload) > MAX_PAYLOAD) return;
      await sql.notify(EVENTS_CHANNEL, payload);
    },
    async subscribe(listener: (e: PlatformEvent) => void) {
      const { unlisten } = await sql.listen(EVENTS_CHANNEL, (raw) => {
        try {
          listener(JSON.parse(raw) as PlatformEvent);
        } catch {}
      });
      return unlisten;
    },
    close: () => sql.end({ timeout: 5 }),
  };
}

export type EventBus = ReturnType<typeof createEventBus>;
