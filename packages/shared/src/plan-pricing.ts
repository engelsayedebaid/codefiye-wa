import { PLANS, type Plan } from './plans';

/** The four packages shown on the landing page and the subscription page. */
export const CUSTOMER_PLAN_IDS = ['basic', 'pro', 'plus', 'business'] as const;
export type CustomerPlanId = (typeof CUSTOMER_PLAN_IDS)[number];

/** What customers pay, and the optional list price that makes a discount visible. */
export type PlanOffer = {
  /** USD per month. */
  priceUsd: number;
  /** Crossed out when it is higher than `priceUsd`. Null hides the discount. */
  compareAtUsd: number | null;
};

/**
 * Operator-edited prices, stored in `settings` under `plan_pricing`.
 * Quotas stay on the catalog in `plans.ts`; only the price and the highlighted card change.
 */
export type PlanPricing = {
  /** The card that wears the “most popular” badge. Null = none. */
  highlight: CustomerPlanId | null;
  plans: Record<CustomerPlanId, PlanOffer>;
};

export type OfferedPlan = Plan & PlanOffer & { popular: boolean };

const MONEY_MAX = 100_000;

/** One-click discounts. Each percent is taken off the list price once, never stacked. */
export const QUICK_DISCOUNT_PERCENTS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

export function isCustomerPlan(id: string): id is CustomerPlanId {
  return (CUSTOMER_PLAN_IDS as readonly string[]).includes(id);
}

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

export const DEFAULT_PLAN_PRICING: PlanPricing = {
  highlight: 'pro',
  plans: {
    basic: { priceUsd: PLANS.basic.priceUsd, compareAtUsd: null },
    pro: { priceUsd: PLANS.pro.priceUsd, compareAtUsd: null },
    plus: { priceUsd: PLANS.plus.priceUsd, compareAtUsd: null },
    business: { priceUsd: PLANS.business.priceUsd, compareAtUsd: null },
  },
};

/** Whole-percent discount, or null when there is nothing to show (under 1%). */
export function discountPercent(priceUsd: number, compareAtUsd: number | null): number | null {
  if (compareAtUsd === null || !(compareAtUsd > priceUsd)) return null;
  const pct = Math.round((1 - priceUsd / compareAtUsd) * 100);
  return pct >= 1 ? pct : null;
}

/** Why an offer cannot be saved. A sale price of 0 is a 100% discount. */
export function offerProblem(offer: PlanOffer): 'price' | 'compare' | null {
  if (!Number.isFinite(offer.priceUsd) || offer.priceUsd < 0 || offer.priceUsd > MONEY_MAX) return 'price';
  if (offer.compareAtUsd === null) return null;
  if (!Number.isFinite(offer.compareAtUsd) || offer.compareAtUsd <= offer.priceUsd || offer.compareAtUsd > MONEY_MAX) return 'compare';
  return null;
}

/** The price a quick discount is taken off: the crossed-out price, otherwise what customers pay now. */
export function discountBaseUsd(offer: PlanOffer, catalogUsd: number): number {
  if (offer.compareAtUsd !== null && offer.compareAtUsd > offer.priceUsd) return offer.compareAtUsd;
  if (offer.priceUsd > 0) return offer.priceUsd;
  return catalogUsd;
}

/** Sets the sale price to `percent` off the list price. A later percent replaces the first; it does not compound. */
export function applyQuickDiscount(offer: PlanOffer, percent: number, catalogUsd: number): PlanOffer {
  const base = discountBaseUsd(offer, catalogUsd);
  if (percent >= 100) return { priceUsd: 0, compareAtUsd: base };
  const priceUsd = roundMoney(base * (1 - percent / 100));
  return { priceUsd: priceUsd > 0 && priceUsd < base ? priceUsd : 0, compareAtUsd: base };
}

/** Drops the discount and restores the list price. */
export function clearQuickDiscount(offer: PlanOffer, catalogUsd: number): PlanOffer {
  return { priceUsd: discountBaseUsd(offer, catalogUsd), compareAtUsd: null };
}

function readMoney(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const rounded = roundMoney(value);
  if (rounded < 0 || rounded > MONEY_MAX) return fallback;
  return rounded;
}

function readCompare(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = roundMoney(value);
  if (rounded <= 0 || rounded > MONEY_MAX) return null;
  return rounded;
}

/** Fills anything missing or corrupt with the catalog, and hides a compare-at that is not a discount. */
export function normalizePlanPricing(raw: unknown): PlanPricing {
  const src = raw && typeof raw === 'object' ? (raw as { highlight?: unknown; plans?: Partial<Record<CustomerPlanId, Partial<PlanOffer>>> }) : {};
  const plans = {} as PlanPricing['plans'];
  for (const id of CUSTOMER_PLAN_IDS) {
    const offer = src.plans?.[id];
    const priceUsd = readMoney(offer?.priceUsd, DEFAULT_PLAN_PRICING.plans[id].priceUsd);
    let compareAtUsd = readCompare(offer?.compareAtUsd);
    if (compareAtUsd !== null && compareAtUsd <= priceUsd) compareAtUsd = null;
    plans[id] = { priceUsd, compareAtUsd };
  }
  const highlightId = typeof src.highlight === 'string' ? src.highlight : null;
  const highlight: PlanPricing['highlight'] = src.highlight === null ? null : highlightId && isCustomerPlan(highlightId) ? highlightId : DEFAULT_PLAN_PRICING.highlight;
  return { highlight, plans };
}

/** Rounds an already-shaped payload (the editor and the write route) without filling defaults. */
export function preparePlanPricing(input: PlanPricing): PlanPricing {
  const plans = {} as PlanPricing['plans'];
  for (const id of CUSTOMER_PLAN_IDS) {
    const offer = input.plans[id];
    plans[id] = {
      priceUsd: roundMoney(offer.priceUsd),
      compareAtUsd: offer.compareAtUsd === null ? null : roundMoney(offer.compareAtUsd),
    };
  }
  return { highlight: input.highlight, plans };
}

/** The sale price customers pay. Catalog price for plans the operator does not edit. */
export function listedPriceUsd(planId: string, pricing: PlanPricing): number | null {
  if (isCustomerPlan(planId)) return pricing.plans[planId].priceUsd;
  return (PLANS as Record<string, Plan>)[planId]?.priceUsd ?? null;
}

/** The four cards, in display order, with the operator’s prices applied. */
export function offeredPlans(pricing: PlanPricing): OfferedPlan[] {
  return CUSTOMER_PLAN_IDS.map((id) => ({
    ...PLANS[id],
    priceUsd: pricing.plans[id].priceUsd,
    compareAtUsd: pricing.plans[id].compareAtUsd,
    popular: pricing.highlight === id,
  }));
}
