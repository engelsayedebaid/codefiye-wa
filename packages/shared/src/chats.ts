import type { MessageType } from './constants';

/**
 * The admin chats inbox (`/chats`). Zod-free so the dashboard can import it.
 *
 * Inbound messages (and the ones sent from the phone itself) keep, next to `text`, what a chat view
 * needs to draw them without the raw WAMessage: media details with a tiny preview, locations,
 * contact cards, the message they reply to, and the target of a reaction.
 */

export type ChatMedia = {
  mimetype?: string;
  /** Bytes. */
  size?: number;
  /** Audio/video length. */
  seconds?: number;
  width?: number;
  height?: number;
  fileName?: string;
  /** A voice note (push-to-talk), as opposed to an audio file. */
  ptt?: boolean;
  /** A looping video sent as a GIF. */
  gif?: boolean;
  /** Base64 JPEG preview WhatsApp embeds in images, videos and documents (a few KB, blurry). */
  thumb?: string;
};

export type ChatLocation = { latitude: number; longitude: number; name?: string; address?: string; live?: boolean };

export type ChatContactCard = { name: string; phone: string | null };

/** The message a message replies to, as WhatsApp quotes it. */
export type ChatQuote = { id: string; type: MessageType; text: string | null; participant: string | null };

/** The extra fields of `messages.content` for inbound and phone-sent messages (see `@wa/provider` toInbound). */
export type MessageExtras = {
  media?: ChatMedia;
  location?: ChatLocation;
  contacts?: ChatContactCard[];
  quoted?: ChatQuote;
  /** Reactions: the WhatsApp id of the message reacted to (`text` holds the emoji; empty = removed). */
  reactTo?: string;
  /** Polls someone else created. */
  poll?: { name: string; options: string[] };
  /** View-once media: WhatsApp doesn't let linked devices open it. */
  viewOnce?: boolean;
  forwarded?: boolean;
};

/** What the contact is doing right now, from WhatsApp presence updates. */
export const PRESENCES = ['available', 'unavailable', 'composing', 'recording', 'paused'] as const;
export type Presence = (typeof PRESENCES)[number];

/** Chat list filters. `replied`: the contact wrote back at least once; `noReply`: only we wrote (e.g. campaign recipients). */
export const CHAT_FILTERS = ['all', 'unread', 'contacts', 'groups', 'replied', 'noReply', 'pinned', 'archived'] as const;
export type ChatFilter = (typeof CHAT_FILTERS)[number];

/** Attachments sent from the chat page are uploaded first; outbound content then points at them with this scheme. */
export const UPLOAD_SCHEME = 'upload:';
export const UPLOAD_MAX_BYTES = 16 * 1024 * 1024;

/**
 * A contact name worth keeping: not blank, not a masked number (`+20∙∙∙∙16`, which some history syncs
 * give for LID chats), not just a phone number. Mirrors `usable_contact_name` (migration 0015).
 */
export function usableContactName(name: string | null | undefined): name is string {
  if (!name) return false;
  const trimmed = name.trim();
  return trimmed !== '' && !/[∙•]/.test(trimmed) && !/^[+0-9 ().-]+$/.test(trimmed);
}
