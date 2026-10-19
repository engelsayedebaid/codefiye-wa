import { QueryClient, type QueryKey } from '@tanstack/react-query';
import { ApiRequestError } from './api';

/** Every cached server resource, so pages share data and invalidate it consistently. */
export const qk = {
  me: ['me'] as const,
  overview: (days: number) => ['overview', days] as const,
  sessions: ['sessions'] as const,
  session: (id: string) => ['sessions', id] as const,
  qr: (id: string) => ['sessions', id, 'qr'] as const,
  messages: (id: string) => ['sessions', id, 'messages'] as const,
  templates: ['templates'] as const,
  keys: ['keys'] as const,
  planRequests: ['plan-requests'] as const,
  /** Accepted payment methods and receiving accounts (what the admin set). */
  paymentMethods: ['payment-methods'] as const,
  /** Customer-facing plan prices and discounts (what the admin set). */
  planPricing: ['plan-pricing'] as const,
  /** The website's explainer video and YouTube links (what the admin set). */
  site: ['site'] as const,
  chats: {
    all: ['chats'] as const,
    numbers: ['chats', 'numbers'] as const,
    list: (sessionId: string, filter: string, q: string) => ['chats', sessionId, 'list', filter, q] as const,
    lists: (sessionId: string) => ['chats', sessionId, 'list'] as const,
    messages: (sessionId: string, jid: string) => ['chats', sessionId, 'messages', jid, ''] as const,
    /** The conversation opened at one message (a search result), loading both ways from there. */
    messagesAround: (sessionId: string, jid: string, id: number) => ['chats', sessionId, 'messages', jid, 'around', id] as const,
    /** The messages of one chat that match the words: where the in-chat search can go. */
    find: (sessionId: string, jid: string, q: string) => ['chats', sessionId, 'find', jid, q] as const,
    chat: (sessionId: string, jid: string) => ['chats', sessionId, 'chat', jid] as const,
    gallery: (sessionId: string, jid: string, kind: string) => ['chats', sessionId, 'gallery', jid, kind] as const,
    members: (sessionId: string, jid: string) => ['chats', sessionId, 'members', jid] as const,
    profile: (sessionId: string, jid: string) => ['chats', sessionId, 'profile', jid] as const,
    /** One loaded page of the list: its chats' small pictures. */
    pictures: (sessionId: string, jids: string) => ['chats', sessionId, 'pictures', jids] as const,
    /** Search across every chat (`sessionId` '' = all the numbers). */
    search: (sessionId: string, kind: string, q: string) => ['chats', 'search', sessionId, kind, q] as const,
    /** AI analysis jobs: the latest of the workspace, and one by id (polled while it runs). */
    analysisLatest: ['chats', 'analysis', 'latest'] as const,
    analysis: (id: string) => ['chats', 'analysis', id] as const,
    insights: (sessionId: string, days: number) => ['chats', sessionId, 'insights', days] as const,
    /** The number's latest sync job and its log (kept live by events). */
    syncJob: (sessionId: string) => ['chats', sessionId, 'sync-job'] as const,
  },
  /** The AI auto-reply agent: the providers, each number's settings, its log and its statistics. */
  autoReply: {
    all: ['auto-reply'] as const,
    providers: ['auto-reply', 'providers'] as const,
    providerKeys: (providerId: string) => ['auto-reply', 'providers', providerId, 'keys'] as const,
    numbers: ['auto-reply', 'numbers'] as const,
    log: (params: { sessionId: string; status: string }) => ['auto-reply', 'log', params] as const,
    stats: (days: number) => ['auto-reply', 'stats', days] as const,
  },
  admin: {
    all: ['admin'] as const,
    stats: ['admin', 'stats'] as const,
    requests: ['admin', 'requests'] as const,
    users: (params: { q: string; status: string; page: number }) => ['admin', 'users', params] as const,
    audit: (page: number) => ['admin', 'audit', page] as const,
    otpText: ['admin', 'otp-text'] as const,
    broadcasts: ['admin', 'broadcasts'] as const,
    broadcast: (id: string) => ['admin', 'broadcasts', id] as const,
    /** Each number's campaign load; under `broadcasts` so a launch refreshes it. */
    broadcastNumbers: ['admin', 'broadcasts', 'numbers'] as const,
    /** User activity (who is online, visits, the event log); refreshed while the admin watches. */
    activity: {
      all: ['admin', 'activity'] as const,
      summary: (days: number) => ['admin', 'activity', 'summary', days] as const,
      users: (params: { q: string; sort: string; filter: string; days: number; page: number }) => ['admin', 'activity', 'users', params] as const,
      user: (id: string, days: number) => ['admin', 'activity', 'user', id, days] as const,
      events: (params: { userId?: string; type: string; q: string; page: number }) => ['admin', 'activity', 'events', params] as const,
      visits: (params: { userId?: string; page: number }) => ['admin', 'activity', 'visits', params] as const,
    },
  },
};

const transient = (error: unknown) => !(error instanceof ApiRequestError) || error.transient;

/**
 * Reads retry a few times with backoff when the failure is temporary (offline, 429, 5xx) and never
 * on 4xx; writes never retry by themselves — the user decides. Data refreshes when the tab regains
 * focus or the network comes back, so nothing needs a page reload to catch up.
 */
export function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        retry: (count, error) => count < 3 && transient(error),
        retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 10_000),
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
      mutations: { retry: false },
    },
  });
}

/** Collapses bursts (e.g. many message events at once) into one refetch per key. */
export function debouncedInvalidate(client: QueryClient, wait = 400) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return (queryKey: QueryKey) => {
    const id = JSON.stringify(queryKey);
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        void client.invalidateQueries({ queryKey });
      }, wait),
    );
  };
}
