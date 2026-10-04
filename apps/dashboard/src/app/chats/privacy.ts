import { useSyncExternalStore } from 'react';

// Private mode ("الوضع الخاص"): blur personal content across the chats page. One global choice,
// persisted — the class `.privacy-on` goes on the page root and `.pii` marks what blurs.
const KEY = 'wa.chats.privacy';
const listeners = new Set<() => void>();
let current = false;
try {
  current = localStorage.getItem(KEY) === '1';
} catch {
  /* no storage — stay off */
}

export function setPrivacyMode(on: boolean) {
  if (current === on) return;
  current = on;
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  listeners.forEach((notify) => notify());
}

export function usePrivacyMode() {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => current,
    () => false,
  );
}
