import { z } from 'zod';
import { CUSTOMER_PLAN_IDS, type PlanOffer, type PlanPricing } from './plan-pricing';

/** Plain object (no refine) so Fastify can encode it on the way out. The route checks the discount separately. */
const offerSchema: z.ZodType<PlanOffer> = z.object({
  priceUsd: z.number().min(0).max(100_000),
  compareAtUsd: z.number().positive().max(100_000).nullable(),
});

export const planPricingSchema: z.ZodType<PlanPricing> = z.object({
  highlight: z.enum(CUSTOMER_PLAN_IDS).nullable(),
  plans: z.object({
    basic: offerSchema,
    pro: offerSchema,
    plus: offerSchema,
    business: offerSchema,
  }),
});
