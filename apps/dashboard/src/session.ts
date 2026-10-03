import type { QueryClient } from '@tanstack/react-query';
import { api, sessionHint } from './api';
import { stopLiveEvents } from './events';
import { navigate } from './router';

/** Ends the session on the server (revokes it, clears the cookie) and forgets this tab's data. */
export async function signOut(queryClient: QueryClient) {
  await api('/api/auth/logout', { method: 'POST', timeoutMs: 8_000 }).catch(() => {});
  sessionHint.set(false);
  stopLiveEvents();
  queryClient.clear();
  navigate('/login', { replace: true });
}
