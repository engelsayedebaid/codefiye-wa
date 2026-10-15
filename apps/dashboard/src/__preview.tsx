// Temporary preview harness for the profile page (not part of the app).
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { type Account, AccountContext } from './app/account';
import { I18nProvider } from './i18n';
import { ProfilePage } from './pages/Profile';
import { createQueryClient } from './queries';
import { ThemeProvider } from './theme';
import './index.css';

const q = new URLSearchParams(location.search);
const v = q.get('v') ?? 'admin';

const account: Account = {
  user:
    v === 'token'
      ? null
      : {
          id: 'u1',
          name: 'Eng elsayed ebaid',
          email: 'engelsayedebaid@gmail.com',
          role: v === 'admin' ? 'admin' : 'user',
          isAdmin: v === 'admin',
          status: 'active',
          phone: v === 'nophone' ? null : '+201001234567',
          phoneVerified: v === 'admin' || v === 'expired',
          twoFactorEnabled: v !== 'no2fa',
        },
  workspace: {
    id: 'w1',
    name: 'Eng elsayed ebaid',
    planId: v === 'admin' ? 'unlimited' : 'pro',
    trialEndsAt: null,
    planExpiresAt: v === 'admin' ? null : v === 'expired' ? '2026-09-01T00:00:00Z' : '2026-12-01T00:00:00Z',
  },
  plan: v === 'admin' ? { id: 'unlimited', name: 'Unlimited', priceUsd: null, sessions: 999, rpm: 999, dailyMessages: null, retentionDays: 365, features: [] } : { id: 'pro', name: 'Pro', priceUsd: 15, sessions: 3, rpm: 60, dailyMessages: null, retentionDays: 30, features: [] },
  pendingRequest: null,
  features: { ads: false },
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={createQueryClient()}>
      <ThemeProvider>
        <I18nProvider>
          <AccountContext.Provider value={{ account, reload: () => {} }}>
            <div className="flex min-h-svh bg-surface">
              <aside className="hidden w-[272px] shrink-0 md:block" />
              <div className="relative flex min-w-0 flex-1 flex-col bg-bg md:m-2 md:ms-0 md:min-h-[calc(100svh-1rem)] md:rounded-2xl md:border md:border-line md:shadow-sm">
                <header className="flex h-16 shrink-0 items-center border-b border-line/50 px-6" />
                <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
                  <main className="animate-fade-up min-w-0 flex-1">
                    <ProfilePage />
                  </main>
                </div>
              </div>
            </div>
          </AccountContext.Provider>
        </I18nProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
