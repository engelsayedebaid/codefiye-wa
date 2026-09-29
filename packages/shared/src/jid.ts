const USER_SUFFIX = '@s.whatsapp.net';
const JID_RE = /^[\w.:-]+@(s\.whatsapp\.net|g\.us|lid|newsletter|broadcast)$/;

export const isJid = (value: string) => JID_RE.test(value);

/** Accepts E.164 (`+201012345678`), bare digits, or a full JID. */
export function toJid(input: string): string {
  const value = input.trim();
  if (isJid(value)) return value;
  const digits = value.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) throw new Error(`Invalid phone number: ${input}`);
  return digits + USER_SUFFIX;
}

export function jidToPhone(jid: string): string | null {
  const [user, server] = jid.split('@');
  if (server !== 's.whatsapp.net' || !user) return null;
  return '+' + user.split(':')[0];
}

/** Masks all but the last 4 digits, for logs. */
export const maskPhone = (value: string) => value.replace(/\d(?=\d{4})/g, '*');
