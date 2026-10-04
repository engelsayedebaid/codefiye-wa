import type { ChatContactCard, ChatFilter, ChatLocation, ChatMedia, ChatQuote, Presence } from '@wa/shared/chats';
import type { MessageStatus, MessageType, SessionStatus } from '@wa/shared/constants';

/** Mirrors apps/api/src/routes/chats.ts. */
export type ChatNumber = { id: string; name: string; phone: string | null; status: SessionStatus; chats: number; unreadChats: number; unread: number };

export type ChatSummary = {
  jid: string;
  altJid: string | null;
  name: string | null;
  phone: string | null;
  isGroup: boolean;
  unread: number;
  pinned: boolean;
  archived: boolean;
  inbound: number;
  outbound: number;
  lastMessageAt: string;
  lastInboundAt: string | null;
  last: { id: number; direction: 'in' | 'out'; type: MessageType; status: MessageStatus; text: string | null; sender: string | null; createdAt: string; revoked?: boolean } | null;
};

export type ChatPage = { chats: ChatSummary[]; next: string | null; counts: Record<ChatFilter, number> | null };

export type ChatMessage = {
  id: number;
  direction: 'in' | 'out';
  type: MessageType;
  status: MessageStatus;
  content: MessageContent;
  error: string | null;
  waMessageId: string | null;
  hasMedia: boolean;
  broadcastId: string | null;
  sentAt: string | null;
  createdAt: string;
};

/** Inbound content (worker) and outbound content (API) share one bag of optional fields. */
export type MessageContent = {
  text?: string | null;
  /** The sender edited it (`text` is the edited text; `editedAt` epoch seconds). */
  edited?: boolean;
  editedAt?: number;
  /** The sender deleted it for everyone. */
  revoked?: boolean;
  caption?: string;
  /** Polls we sent. */
  name?: string;
  options?: string[];
  votes?: Record<string, string[]>;
  url?: string;
  fileName?: string;
  mimetype?: string;
  ptt?: boolean;
  from?: string;
  fromPhone?: string | null;
  pushName?: string | null;
  isGroup?: boolean;
  timestamp?: number;
  /** `phone`: sent from the phone itself; `chats`: typed on the chats page. */
  sentFrom?: 'phone' | 'chats';
  /** Outbound voice notes: their length. */
  seconds?: number;
  media?: ChatMedia;
  location?: ChatLocation;
  contacts?: ChatContactCard[];
  quoted?: ChatQuote;
  quote?: { id: string; fromMe: boolean; text?: string | null };
  reactTo?: string;
  poll?: { name: string; options: string[] };
  viewOnce?: boolean;
  forwarded?: boolean;
  /** Outbound location / contact. */
  latitude?: number;
  longitude?: number;
  address?: string;
  phone?: string;
};

/** Someone in a group: a name to show (null = none known) and their number (null for a hidden LID). */
export type Person = { name: string | null; phone: string | null };

/** `senders`: groups only, who sent the page's incoming messages, by `content.from`. */
export type MessagesPage = { messages: ChatMessage[]; nextBefore: number | null; senders?: Record<string, Person> };

export type GroupMember = Person & { jid: string; role: 'superadmin' | 'admin' | 'member'; isMe: boolean };

/** A group message's sender on its bubble (`key` picks the name's color; `phone` shows beside a name; `unknown`: not stored). */
export type Sender = { key: string; name: string; phone: string | null; unknown?: boolean };

/** `+20100…` for a phone-number JID; null for a LID or a group. */
export const jidPhone = (jid: string) => (jid.endsWith('@s.whatsapp.net') ? `+${jid.split('@')[0]!.split(':')[0]}` : null);

export type ChatInfo = {
  chat: ChatSummary | null;
  stats: { firstAt: string | null; total: number; campaign: number; media: number; delivered: number; read: number; failed: number; outbound: number; byType: Record<string, number> };
  optedOut: boolean;
};

export type Profile = { pictureUrl: string | null; about: string | null; name: string | null };

export type Insights = {
  totals: {
    inbound: number;
    outbound: number;
    delivered: number;
    read: number;
    failed: number;
    activeChats: number;
    newChats: number;
    contacted: number;
    replied: number;
    unread: number;
    medianResponseSec: number | null;
    responses: number;
  };
  daily: { day: string; inbound: number; outbound: number }[];
  hours: { dow: number; hour: number; n: number }[];
  types: { type: string; n: number }[];
  top: { jid: string; name: string | null; phone: string | null; inbound: number; outbound: number }[];
};

export type PresenceState = { presence: Presence; jid: string; lastSeen: number | null; at: number };

export const mediaUrl = (id: number, download = false) => `/api/chats/media/${id}${download ? '?download=1' : ''}`;

/** The text a message shows: body, caption, poll question. */
export const textOf = (m: Pick<ChatMessage, 'content'>) => m.content.text ?? m.content.caption ?? m.content.name ?? m.content.poll?.name ?? null;

/** A chat's display name: contact or group name, else the phone number. */
export const chatTitle = (c: Pick<ChatSummary, 'name' | 'phone' | 'jid'>) => c.name || c.phone || c.jid.split('@')[0]!;

/** True when an event about `jid` concerns this chat (it may arrive under either address). */
export const isChat = (c: Pick<ChatSummary, 'jid' | 'altJid'> | null | undefined, jid: string) => Boolean(c && (c.jid === jid || c.altJid === jid));

export function initials(name: string) {
  const letters = name
    .replace(/[^\p{L}\s]/gu, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // A bare number has no initials: the avatar shows a person instead.
  if (letters.length === 0) return '';
  return ((letters[0]?.[0] ?? '') + (letters[1]?.[0] ?? '')).toUpperCase();
}

/** Stable gradient per contact, from a small set that reads well on the dark theme. */
const GRADIENTS = [
  'from-emerald-500 to-teal-600',
  'from-sky-500 to-indigo-600',
  'from-violet-500 to-fuchsia-600',
  'from-amber-500 to-orange-600',
  'from-rose-500 to-pink-600',
  'from-cyan-500 to-blue-600',
  'from-lime-500 to-green-600',
  'from-fuchsia-500 to-purple-600',
];
export function hashOf(value: string) {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(h);
}
export const gradientFor = (key: string) => GRADIENTS[hashOf(key) % GRADIENTS.length]!;

/** Text colors for group senders (as WhatsApp tints each member). */
const SENDER_COLORS = ['text-emerald-400', 'text-sky-400', 'text-violet-400', 'text-amber-400', 'text-rose-400', 'text-cyan-400', 'text-lime-400', 'text-fuchsia-400'];
export const senderColor = (key: string) => SENDER_COLORS[hashOf(key) % SENDER_COLORS.length]!;

export function formatBytes(n: number | undefined) {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

export function formatDuration(seconds: number | undefined) {
  if (seconds === undefined || !Number.isFinite(seconds)) return '0:00';
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Presence that still means something: typing without an update for 25s, or online for 3 min, has lapsed. */
export function livePresence(p: PresenceState | undefined): PresenceState | undefined {
  if (!p) return undefined;
  const age = Date.now() - p.at;
  if ((p.presence === 'composing' || p.presence === 'recording') && age > 25_000) return { ...p, presence: 'available' };
  return p;
}
