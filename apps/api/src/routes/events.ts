import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../deps';
import { tooMany } from '../lib/errors';

/** Concurrent streams per workspace: plenty for many open dashboard tabs, a ceiling for runaway clients. */
const MAX_STREAMS_PER_WORKSPACE = 20;

/**
 * Server-Sent Events for the dashboard (README §3: SSE for QR and session status). Session keys
 * only see their own session. The dashboard authenticates with its session cookie (EventSource);
 * API clients can use fetch() streaming with an Authorization header.
 */
export function eventRoutes({ events }: Deps): FastifyPluginAsyncZod {
  const open = new Map<string, number>();

  return async (app) => {
    app.get(
      '/events',
      {
        config: { rateLimit: false },
        schema: {
          tags: ['Events'],
          summary: 'Live event stream (SSE)',
          description:
            'Events: session.status, qrcode.updated, pairing.updated, messages.received, messages.update, messages.created, poll.vote, ' +
            'presence.update, chat.read, chats.synced. ' +
            '`resync` means events may have been missed (e.g. after a reconnect): reload your state.',
        },
      },
      async (req, reply) => {
        const { workspaceId, keySessionId, keyId } = req.auth;
        if ((open.get(workspaceId) ?? 0) >= MAX_STREAMS_PER_WORKSPACE) {
          throw tooMany('Too many open event streams for this workspace. Close some tabs or connections.', 30);
        }
        open.set(workspaceId, (open.get(workspaceId) ?? 0) + 1);

        reply.hijack();
        reply.raw.writeHead(200, {
          ...(reply.getHeaders() as Record<string, string>),
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        });
        reply.raw.write('retry: 3000\n\n');

        const send = (type: string, data: unknown) => {
          // A client that stopped reading would otherwise make us buffer without bound.
          if (reply.raw.writableLength > 1024 * 1024) return close();
          reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const unsubscribe = events.subscribe(workspaceId, (event) => {
          if (keySessionId && event.sessionId !== keySessionId) return;
          const { workspaceId: _, ...payload } = event;
          send(event.type, payload);
        });
        const offResync = events.onResync(() => send('resync', { type: 'resync' }));
        // Logged out elsewhere, suspended or deleted: end the stream now rather than at the next request.
        const offRevoke = events.onRevoke((target) => {
          if (target.workspaceIds?.includes(workspaceId) || target.keyIds?.includes(keyId)) close();
        });
        const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);

        let closed = false;
        function close() {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          offResync();
          offRevoke();
          const left = (open.get(workspaceId) ?? 1) - 1;
          if (left > 0) open.set(workspaceId, left);
          else open.delete(workspaceId);
          reply.raw.end();
        }
        req.raw.on('close', close);
      },
    );
  };
}
