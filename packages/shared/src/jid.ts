export const USER_SERVER = 's.whatsapp.net';
export const GROUP_SERVER = 'g.us';

const JID_RE = /^[\w.:-]+@(s\.whatsapp\.net|g\.us|lid|newsletter|broadcast)$/;

/**
 * Normalises a recipient — E.164 (`+201012345678`), bare digits, `00`-prefixed international,
 * or a full JID — to a JID. Returns null when the input can't be a WhatsApp address.
 */
export function toJid(to: string): string | null {
  const value = to.trim();
  if (value.includes('@')) return JID_RE.test(value) ? value : null;
  let digits = value.replace(/[\s().+-]/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (!/^[1-9]\d{6,14}$/.test(digits)) return null;
  return `${digits}@${USER_SERVER}`;
}

/** `201012345678:3@s.whatsapp.net` → `+201012345678`; null for groups, LIDs and other servers. */
export function jidToPhone(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const [user, server] = jid.split('@');
  if (server !== USER_SERVER || !user) return null;
  const digits = user.split(':')[0];
  return digits ? `+${digits}` : null;
}

export function isUserJid(jid: string): boolean {
  return jid.endsWith(`@${USER_SERVER}`);
}

export function isGroupJid(jid: string): boolean {
  return jid.endsWith(`@${GROUP_SERVER}`);
}

/** Masks the middle of a phone/JID for logs: `+2010****5678`. */
export function maskPhone(value: string | null | undefined): string {
  if (!value) return '';
  const [user = '', server] = value.split('@');
  const masked = user.length > 8 ? `${user.slice(0, 4)}****${user.slice(-4)}` : '****';
  return server ? `${masked}@${server}` : masked;
}
