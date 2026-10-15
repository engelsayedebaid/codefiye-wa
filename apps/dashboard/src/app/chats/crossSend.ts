import { useSyncExternalStore } from 'react';

// "Send between numbers" (admins): answer a contact from another of the workspace's numbers, and forward
// a conversation through any number. Off by default; one global, persisted switch in the chats menu.
const KEY = 'wa.chats.crossSend';
const listeners = new Set<() => void>();
let current = false;
try {
  current = localStorage.getItem(KEY) === '1';
} catch {
  /* no storage — stay off */
}

export function setCrossSend(on: boolean) {
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

export function useCrossSend() {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => current,
    () => false,
  );
}
