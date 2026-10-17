import { useEffect } from 'react';

/** How often an open, in-use dashboard says it's still here (the API credits at most this per ping). */
const PING_EVERY_MS = 60_000;
/** No mouse, keyboard, touch or scroll for this long = away, even with the tab in front. */
const IDLE_AFTER_MS = 5 * 60_000;
const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const;

/** Fire and forget: losing a ping only loses a minute in the admin's activity view. */
function ping(body: { path: string; view?: boolean }) {
  void fetch('/api/activity', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'same-origin',
    keepalive: true,
  }).catch(() => {});
}

/**
 * Feeds the admin's activity view (when users come in, how long they stay, which pages they open):
 * a ping on every page, then once a minute while the tab is visible and in use, and one as the tab
 * is hidden so the time they left is exact. Query strings are never sent (chat links carry numbers).
 */
export function useActivityPing(path: string) {
  useEffect(() => ping({ path, view: true }), [path]);

  useEffect(() => {
    let lastInput = Date.now();
    const onInput = () => {
      lastInput = Date.now();
    };
    const inUse = () => Date.now() - lastInput < IDLE_AFTER_MS;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && inUse()) ping({ path: location.pathname });
    }, PING_EVERY_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') lastInput = Date.now();
      else if (!inUse()) return;
      ping({ path: location.pathname });
    };
    for (const name of INPUT_EVENTS) window.addEventListener(name, onInput, { passive: true, capture: true });
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearInterval(timer);
      for (const name of INPUT_EVENTS) window.removeEventListener(name, onInput, { capture: true });
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
}
