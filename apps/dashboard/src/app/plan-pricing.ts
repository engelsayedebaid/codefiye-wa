import type { PlanPricing } from '@wa/shared/plan-pricing';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { qk } from '../queries';

/** The operator’s prices. The landing page and the subscription page both read this. */
export function usePlanPricing() {
  return useQuery({
    queryKey: qk.planPricing,
    queryFn: ({ signal }) => api<PlanPricing>('/api/plan-pricing', { signal }),
    staleTime: 5 * 60_000,
  });
}
