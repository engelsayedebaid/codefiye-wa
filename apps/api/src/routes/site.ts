import { ok, siteSettingsSchema, successSchema } from '@wa/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../deps';
import { getSiteSettings } from '../lib/site';

/** Public: the landing page shows the explainer video and the YouTube link before anyone is signed in. */
export function siteRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/site',
      {
        schema: {
          hide: true,
          summary: 'Explainer video and YouTube links shown on the website',
          response: { 200: successSchema(siteSettingsSchema) },
        },
      },
      async () => ok(await getSiteSettings(deps.sql)),
    );
  };
}
