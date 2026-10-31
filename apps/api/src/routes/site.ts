import { ok, siteSettingsSchema, successSchema } from '@wa/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps';
import { getCurrencyRates } from '../lib/currency';
import { getSiteSettings } from '../lib/site';

const currencyRatesSchema = z.object({ rates: z.record(z.string(), z.number()), updatedAt: z.string().nullable() });

/** Public: the website shows the explainer video, the contact details and the prices before anyone is signed in. */
export function siteRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/site',
      {
        schema: {
          hide: true,
          summary: 'Explainer video, YouTube links and contact details shown on the website',
          response: { 200: successSchema(siteSettingsSchema) },
        },
      },
      async () => ok(await getSiteSettings(deps.sql)),
    );

    app.get(
      '/currency-rates',
      {
        schema: {
          hide: true,
          summary: 'Units of each currency per 1 USD, for showing plan prices in the visitor’s currency',
          response: { 200: successSchema(currencyRatesSchema) },
        },
      },
      async (req) => ok(await getCurrencyRates(deps.sql, (err) => req.log.warn({ err }, 'exchange rates refresh failed'))),
    );
  };
}
