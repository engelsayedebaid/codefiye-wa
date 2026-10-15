import { useSyncExternalStore, type CSSProperties } from 'react';

/**
 * WhatsApp-style solid wallpapers, each a pair: a deep shade for the dark theme and a pale one of the
 * same hue for the light theme, so a chosen wall reads right in both (and follows a theme switch).
 * The picker's first swatch isn't one of them — it clears the choice and falls back to the theme's `--chat-wall`.
 */
export const CHAT_WALLS = [
  { id: 'night', dark: '#0b141a', light: '#efeae2' },
  { id: 'teal', dark: '#042f2e', light: '#d5ece6' },
  { id: 'emerald', dark: '#0a5a4c', light: '#cdeee0' },
  { id: 'forest', dark: '#134e3e', light: '#dbe8d4' },
  { id: 'sage', dark: '#26302a', light: '#c9d4c2' },
  { id: 'ocean', dark: '#0e4a5e', light: '#d3e9ef' },
  { id: 'cyan', dark: '#0e7490', light: '#cfeef5' },
  { id: 'blue', dark: '#0a3d62', light: '#d6e4f2' },
  { id: 'navy', dark: '#16324f', light: '#dde3ee' },
  { id: 'slate', dark: '#2b3a55', light: '#dfe4ec' },
  { id: 'mist', dark: '#27333a', light: '#d2dade' },
  { id: 'indigo', dark: '#2d2a55', light: '#e1def3' },
  { id: 'violet', dark: '#3f2b63', light: '#e6dcf4' },
  { id: 'plum', dark: '#5b2247', light: '#f0d9ea' },
  { id: 'rose', dark: '#6b2436', light: '#f6d9e1' },
  { id: 'red', dark: '#5c2e2e', light: '#f3dada' },
  { id: 'rust', dark: '#4a2c20', light: '#f1ddd2' },
  { id: 'gold', dark: '#5b4a2e', light: '#f3e7cc' },
  { id: 'olive', dark: '#4a4033', light: '#ebe5d6' },
  { id: 'sand', dark: '#3d3529', light: '#e2d9cc' },
  { id: 'taupe', dark: '#3b342c', light: '#d6ccbf' },
  { id: 'gray', dark: '#3a3a3a', light: '#e7e5e2' },
  { id: 'graphite', dark: '#252b33', light: '#e4e6e9' },
  { id: 'black', dark: '#111213', light: '#f4f4f2' },
] as const;
type Wall = { id: string; dark: string; light: string };
const BY_ID = new Map<string, Wall>(CHAT_WALLS.map((w) => [w.id, w]));
/** The single colors saved before walls came in pairs: each to the pair it belongs to. */
const LEGACY: Record<string, string> = {
  '#0b141a': 'night',
  '#042f2e': 'teal',
  '#0a5a4c': 'emerald',
  '#134e3e': 'forest',
  '#0e4a5e': 'ocean',
  '#0a3d62': 'blue',
  '#16324f': 'navy',
  '#1e2b45': 'navy',
  '#2b3a55': 'slate',
  '#252b33': 'graphite',
  '#3a3a3a': 'gray',
  '#4a4033': 'olive',
  '#5b4a2e': 'gold',
  '#4a2c20': 'rust',
  '#5c2e2e': 'red',
  '#6b2436': 'rose',
  '#5b2247': 'plum',
  '#3f2b63': 'violet',
  '#2d2a55': 'indigo',
  '#0e7490': 'cyan',
  '#d8cec2': 'sand',
  '#c9beb0': 'taupe',
  '#b8c4c9': 'mist',
  '#a8b5a0': 'sage',
};
const normalize = (value: string | null | undefined) => (value ? (BY_ID.has(value) ? value : (LEGACY[value.toLowerCase()] ?? null)) : null);

/**
 * Where a wallpaper applies, most specific first: one chat, every group, every one-to-one chat, or
 * everything. A chat shows the first one set along that order, else the theme's own.
 */
export const WALL_SCOPES = ['chat', 'groups', 'contacts', 'all'] as const;
export type WallScope = (typeof WALL_SCOPES)[number];

type Walls = { all: string | null; groups: string | null; contacts: string | null; chats: Record<string, string> };

/** `all` keeps the key it always had; the scoped ones live together beside it. */
const KEY = 'wa.chats.wall';
const SCOPED_KEY = 'wa.chats.walls';
const listeners = new Set<() => void>();
let current: Walls = { all: null, groups: null, contacts: null, chats: {} };
try {
  const scoped = JSON.parse(localStorage.getItem(SCOPED_KEY) ?? '{}') as Partial<Walls>;
  const chats: Record<string, string> = {};
  for (const [jid, value] of Object.entries(scoped.chats ?? {})) {
    const id = normalize(value);
    if (id) chats[jid] = id;
  }
  current = { all: normalize(localStorage.getItem(KEY)), groups: normalize(scoped.groups), contacts: normalize(scoped.contacts), chats };
} catch {
  // Storage blocked — the walls still work for the session, they just aren't kept.
}

/** Sets (or, with null, clears) the wallpaper (a `CHAT_WALLS` id) of one scope; `jid` names the chat for `chat`. */
export function setChatWall(scope: WallScope, id: string | null, jid?: string) {
  if (scope === 'chat') {
    if (!jid) return;
    const chats = { ...current.chats };
    if (id) chats[jid] = id;
    else delete chats[jid];
    current = { ...current, chats };
  } else current = { ...current, [scope]: id };
  try {
    if (current.all) localStorage.setItem(KEY, current.all);
    else localStorage.removeItem(KEY);
    localStorage.setItem(SCOPED_KEY, JSON.stringify({ groups: current.groups, contacts: current.contacts, chats: current.chats }));
  } catch {
    // ignore
  }
  listeners.forEach((notify) => notify());
}

/** What each scope holds for a chat, and the one in effect (null = the theme's). */
export function wallsFor(walls: Walls, chat: { jid: string; isGroup: boolean }) {
  const own: Record<WallScope, string | null> = { chat: walls.chats[chat.jid] ?? null, groups: walls.groups, contacts: walls.contacts, all: walls.all };
  const scopes = WALL_SCOPES.filter((s) => s !== (chat.isGroup ? 'contacts' : 'groups'));
  const from = scopes.find((s) => own[s] !== null) ?? null;
  return { own, from, wall: from ? own[from] : null };
}

/** The wallpapers, shared live by every chat surface on the page. */
export function useChatWalls() {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => current,
    () => current,
  );
}

/**
 * The pair of a wall for a `.chat-wall` / `.wall-swatch` element (undefined = the theme's own);
 * the stylesheet picks the shade of the current theme.
 */
export function wallStyle(id: string | null): CSSProperties | undefined {
  const wall = id ? BY_ID.get(id) : undefined;
  return wall ? ({ '--wall-dark': wall.dark, '--wall-light': wall.light } as CSSProperties) : undefined;
}
