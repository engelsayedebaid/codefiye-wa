import { useSyncExternalStore, type CSSProperties } from 'react';

/**
 * WhatsApp-style solid wallpapers. The picker's first swatch isn't a color —
 * it clears the override and falls back to the theme's `--chat-wall`.
 */
export const CHAT_WALLS = [
  '#0b141a',
  '#042f2e',
  '#0a5a4c',
  '#134e3e',
  '#0e4a5e',
  '#0a3d62',
  '#16324f',
  '#1e2b45',
  '#2b3a55',
  '#252b33',
  '#3a3a3a',
  '#4a4033',
  '#5b4a2e',
  '#4a2c20',
  '#5c2e2e',
  '#6b2436',
  '#5b2247',
  '#3f2b63',
  '#2d2a55',
  '#0e7490',
  '#d8cec2',
  '#c9beb0',
  '#b8c4c9',
  '#a8b5a0',
];

const KEY = 'wa.chats.wall';
const listeners = new Set<() => void>();
let current: string | null = null;
try {
  current = localStorage.getItem(KEY);
} catch {
  // Storage blocked — the wall still works for the session, it just isn't kept.
}

export function setChatWall(hex: string | null) {
  current = hex;
  try {
    if (hex) localStorage.setItem(KEY, hex);
    else localStorage.removeItem(KEY);
  } catch {
    // ignore
  }
  listeners.forEach((notify) => notify());
}

/** The chosen wallpaper, shared live by every chat surface on the page. */
export function useChatWall() {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => current,
    () => null,
  );
}

/** Scoped `--chat-wall` override for a wall container (undefined = theme default). */
export const wallStyle = (wall: string | null): CSSProperties | undefined => (wall ? ({ '--chat-wall': wall } as CSSProperties) : undefined);
