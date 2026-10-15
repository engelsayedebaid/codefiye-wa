import { ok, planPricingSchema, successSchema } from '@wa/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Deps } from '../deps';
import { getPlanPricing } from '../lib/plan-pricing';

/** Public: the landing page shows these prices before anyone is signed in. */
export function planPricingRoutes(deps: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/plan-pricing',
      {
        schema: {
          hide: true,
          summary: 'Customer-facing plan prices and discounts',
          response: { 200: successSchema(planPricingSchema) },
        },
      },
      async () => ok(await getPlanPricing(deps.sql)),
    );
  };
}
