import { ok, successSchema } from '@wa/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps';
import { recordPing } from '../lib/activity';

/** A dashboard page path (no query: chat links carry phone numbers). */
const pagePath = z
  .string()
  .max(200)
  .regex(/^\/[A-Za-z0-9/_-]*$/);

/** The dashboard's "still here" ping, which feeds the admin's activity view. Dashboard sessions only. */
export function activityRoutes({ sql }: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.post(
      '/activity',
      {
        schema: {
          tags: ['Account'],
          hide: true,
          summary: 'Dashboard in use',
          description: 'Sent by the dashboard every minute while a tab is visible and in use, and on each page change (`view`).',
          body: z.object({ path: pagePath.optional(), view: z.boolean().default(false) }),
          response: { 200: successSchema(z.object({ recorded: z.boolean() })) },
        },
      },
      async (req) => {
        // API keys and tokens aren't someone sitting at the dashboard.
        if (!req.auth.console || !req.auth.userId) return ok({ recorded: false });
        await recordPing(sql, req, { path: req.body.path ?? null, view: req.body.view });
        return ok({ recorded: true });
      },
    );
  };
}
