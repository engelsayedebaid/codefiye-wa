import { createContext, useContext } from 'react';

export type Plan = {
  id: string;
  name: string;
  priceUsd: number | null;
  sessions: number;
  rpm: number;
  dailyMessages: number | null;
  retentionDays: number;
};

export type PlanRequest = {
  id: string;
  planId: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  note: string | null;
  adminNote: string | null;
  createdAt: string;
  decidedAt: string | null;
};

export type Account = {
  user: {
    id: string;
    name: string | null;
    email: string;
    role: 'user' | 'admin';
    isAdmin: boolean;
    status: 'active' | 'suspended';
    phone: string | null;
    /** Confirmed by a code; needed to request a plan (admins are exempt). */
    phoneVerified: boolean;
  } | null;
  workspace: { id: string; name: string; planId: string; trialEndsAt: string | null; planExpiresAt: string | null };
  plan: Plan;
  pendingRequest: PlanRequest | null;
};

/** The signed-in account (loaded by the app gate before any page renders) and a way to refresh it. */
export const AccountContext = createContext<{ account: Account | null; reload: () => void }>({ account: null, reload: () => {} });

export const useAccount = () => useContext(AccountContext);

/** Days before a paid plan's end date when the dashboard starts warning. */
const EXPIRING_DAYS = 5;

export type PlanState =
  | { kind: 'trial' | 'trial-expired' | 'active' | 'expiring' | 'expired'; endsAt: Date }
  | { kind: 'no-expiry' | 'unlimited'; endsAt: null };

/** Where the workspace stands: drives the dashboard banner, the subscription page and the meters. */
export function planState(account: Account): PlanState {
  const { workspace, plan } = account;
  if (plan.id === 'unlimited') return { kind: 'unlimited', endsAt: null };
  const now = Date.now();
  if (workspace.planId === 'trial') {
    const endsAt = new Date(workspace.trialEndsAt ?? now);
    return { kind: endsAt.getTime() > now ? 'trial' : 'trial-expired', endsAt };
  }
  if (!workspace.planExpiresAt) return { kind: 'no-expiry', endsAt: null };
  const endsAt = new Date(workspace.planExpiresAt);
  const left = endsAt.getTime() - now;
  return { kind: left <= 0 ? 'expired' : left < EXPIRING_DAYS * 86_400_000 ? 'expiring' : 'active', endsAt };
}

export const isUnlimitedPlan = (plan: Plan) => plan.id === 'unlimited';
