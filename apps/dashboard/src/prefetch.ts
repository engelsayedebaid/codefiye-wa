/** Each app page's code, by path — shared by the lazy components in `App.tsx` and by `prefetchPage`. */
export const pageChunks = {
  '/dashboard': () => import('./pages/Dashboard'),
  '/sessions': () => import('./pages/Sessions'),
  '/templates': () => import('./pages/Templates'),
  '/keys': () => import('./pages/Keys'),
  '/subscription': () => import('./pages/Subscription'),
  '/admin': () => import('./pages/Admin'),
  '/ads': () => import('./pages/Ads'),
  '/chats': () => import('./pages/Chats'),
  '/auto-reply': () => import('./pages/AutoReply'),
  '/profile': () => import('./pages/Profile'),
};

/**
 * Fetches a page's code ahead of a click (hovering its link, or idle time after the shell shows),
 * so navigating is instant. Failures are ignored: the real navigation retries with `loadChunk`.
 */
export function prefetchPage(path: string) {
  const load = pageChunks[path as keyof typeof pageChunks];
  if (load) load().catch(() => {});
}

/** After the shell is up and the browser is idle, the other pages' code comes down in the background. */
export function prefetchAllPages(except: string) {
  const run = () => {
    for (const path of Object.keys(pageChunks)) if (path !== except) prefetchPage(path);
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(run, { timeout: 5_000 });
  else setTimeout(run, 2_000);
}
