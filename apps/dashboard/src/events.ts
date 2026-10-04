import { useEffect, useEffectEvent } from 'react';
import type { LiveEvent } from './types';

const EVENT_TYPES = ['session.status', 'qrcode.updated', 'pairing.updated', 'messages.received', 'messages.update', 'messages.created', 'poll.vote', 'presence.update', 'chat.read', 'chats.synced'] as const;

type Handler = { current: (event: LiveEvent) => void };

/**
 * One event stream per tab, shared by every component that listens. Hidden tabs let go of it (except
 * the one tab listening for notifications, see `useBackgroundLiveEvents`):
 * browsers allow only ~6 connections per host over HTTP/1.1, and a stream per page per tab used to
 * starve every other request. Whenever the stream comes back after a gap, the app re-fetches
 * (events sent meanwhile are gone).
 */
const handlers = new Set<Handler>();
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let retryDelay = 2_000;
/** Events may have been missed since the last open stream. */
let missed = false;
let hooks = { onResync: () => {}, onRefused: () => {} };

/** `onResync`: reload server state. `onRefused`: the server ended the stream (e.g. signed out) — re-check the session. */
export function configureLiveEvents(next: { onResync: () => void; onRefused: () => void }) {
  hooks = next;
}

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/**
 * Background listening (message notifications): one tab — whichever holds the Web Lock — keeps its
 * stream while hidden; every other hidden tab still lets go, so the connection limit stays safe.
 */
const BACKGROUND_LOCK = 'wa-live-events-background';
let backgroundWanted = 0;
let leader = false;
let claiming = false;
let releaseLock: (() => void) | null = null;

const wanted = () => visible() || (backgroundWanted > 0 && leader);

function claimBackground() {
  if (claiming) return;
  claiming = true;
  if (!('locks' in navigator)) {
    leader = true;
    return;
  }
  void navigator.locks.request(
    BACKGROUND_LOCK,
    () =>
      new Promise<void>((resolve) => {
        // Granted after the need passed (or twice): hand it straight to the next tab.
        if (backgroundWanted === 0 || releaseLock) return resolve();
        leader = true;
        releaseLock = resolve;
        connect();
      }),
  );
}

function releaseBackground() {
  claiming = false;
  leader = false;
  releaseLock?.();
  releaseLock = null;
  if (!visible() && source) {
    disconnect();
    missed = true;
  }
}

function connect() {
  if (source || handlers.size === 0 || !wanted()) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  // Same origin: the session cookie goes along, no token handling needed.
  const stream = new EventSource('/api/events');
  source = stream;
  stream.onopen = () => {
    retryDelay = 2_000;
    if (missed) hooks.onResync();
    missed = false;
  };
  for (const type of EVENT_TYPES) {
    stream.addEventListener(type, (e) => {
      let event: LiveEvent;
      try {
        event = JSON.parse((e as MessageEvent<string>).data) as LiveEvent;
      } catch {
        return; // ignore malformed event
      }
      for (const handler of handlers) handler.current(event);
    });
  }
  // The server lost events on its side (e.g. its database link dropped and came back).
  stream.addEventListener('resync', () => hooks.onResync());
  stream.onerror = () => {
    missed = true;
    if (stream.readyState !== EventSource.CLOSED) return; // the browser reconnects by itself
    // Refused (signed out, too many streams…): back off and let the app re-check the session.
    disconnect();
    hooks.onRefused();
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 60_000);
  };
}

function disconnect() {
  source?.close();
  source = null;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (wanted()) connect();
    else if (source) {
      disconnect();
      missed = true;
    }
  });
}

/** Ends the stream for good (logout, session ended). */
export function stopLiveEvents() {
  handlers.clear();
  disconnect();
  missed = false;
}

/** Subscribes to the shared stream for as long as the component is mounted. */
export function useLiveEvents(onEvent: (event: LiveEvent) => void) {
  // Always calls the latest onEvent without resubscribing on every render.
  const handle = useEffectEvent(onEvent);

  useEffect(() => {
    const handler: Handler = { current: (event) => handle(event) };
    handlers.add(handler);
    if (closeTimer) clearTimeout(closeTimer);
    connect();
    return () => {
      handlers.delete(handler);
      // Navigating between pages swaps listeners; don't drop and reopen the stream in between.
      if (handlers.size === 0) {
        closeTimer = setTimeout(() => {
          if (handlers.size === 0) disconnect();
        }, 2_000);
      }
    };
  }, []);
}

/** While `enabled`, keeps this tab listening when hidden (if no other tab already does) — for notifications. */
export function useBackgroundLiveEvents(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    backgroundWanted += 1;
    claimBackground();
    return () => {
      backgroundWanted -= 1;
      if (backgroundWanted === 0) releaseBackground();
    };
  }, [enabled]);
}

// Dev hot reload re-runs this module: close the old stream, or each edit leaks one open connection
// until the browser's per-host limit is hit and no stream connects at all.
import.meta.hot?.dispose(() => {
  releaseBackground();
  stopLiveEvents();
});
