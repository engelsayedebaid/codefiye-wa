/** Dashboard/API features a plan can include (gated separately from quotas). */
export type PlanFeature = 'ads';

export type Plan = {
  id: string;
  name: string;
  /** USD per month; null = custom pricing. */
  priceUsd: number | null;
  sessions: number;
  /** API requests per minute, per session. */
  rpm: number;
  /** Outbound messages per day per workspace; null = unlimited. */
  dailyMessages: number | null;
  retentionDays: number;
  /** Extra features bundled with the plan (e.g. bulk ad campaigns). */
  features: readonly PlanFeature[];
};

/** README §9. Pricing is per session, not per message. */
export const PLANS = {
  trial: { id: 'trial', name: 'Trial', priceUsd: 0, sessions: 1, rpm: 10, dailyMessages: 50, retentionDays: 7, features: [] },
  basic: { id: 'basic', name: 'Basic', priceUsd: 6, sessions: 1, rpm: 60, dailyMessages: null, retentionDays: 30, features: [] },
  pro: { id: 'pro', name: 'Pro', priceUsd: 15, sessions: 3, rpm: 120, dailyMessages: null, retentionDays: 60, features: [] },
  plus: { id: 'plus', name: 'Plus', priceUsd: 30, sessions: 6, rpm: 120, dailyMessages: null, retentionDays: 60, features: ['ads'] },
  business: { id: 'business', name: 'Business', priceUsd: 45, sessions: 10, rpm: 120, dailyMessages: null, retentionDays: 90, features: ['ads'] },
  enterprise: { id: 'enterprise', name: 'Enterprise', priceUsd: null, sessions: 25, rpm: 300, dailyMessages: null, retentionDays: 90, features: ['ads'] },
  /** Internal: admin and house accounts. Never offered on the pricing page. */
  unlimited: { id: 'unlimited', name: 'Unlimited', priceUsd: null, sessions: 10_000, rpm: 2_000, dailyMessages: null, retentionDays: 365, features: ['ads'] },
} as const satisfies Record<string, Plan>;

export type PlanId = keyof typeof PLANS;

export const planHasFeature = (planId: string, feature: PlanFeature) => getPlan(planId).features.includes(feature);

export const TRIAL_DAYS = 3;

/** Plans a customer can request from the dashboard (the rest are assigned by an admin). */
export const REQUESTABLE_PLANS = ['basic', 'pro', 'plus', 'business', 'enterprise'] as const;

export const isUnlimited = (plan: Plan) => plan.id === 'unlimited';

export function getPlan(id: string): Plan {
  return (PLANS as Record<string, Plan>)[id] ?? PLANS.trial;
}
