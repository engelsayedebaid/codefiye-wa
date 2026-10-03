import type { ApiKey, Message, Session } from '@wa/db';
import { DESIRED_STATES, MESSAGE_DIRECTIONS, MESSAGE_STATUSES, MESSAGE_TYPES, SESSION_STATUSES } from '@wa/shared';
import { z } from 'zod';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const sessionSettingsSchema = z.object({
  autoRead: z.boolean().optional().describe('Mark incoming messages as read'),
  rejectCalls: z.boolean().optional().describe('Reject incoming calls (coming soon)'),
});

export const sessionDto = z.object({
  id: z.uuid(),
  name: z.string(),
  phoneNumber: z.string().nullable(),
  status: z.enum(SESSION_STATUSES),
  desiredState: z.enum(DESIRED_STATES),
  lastError: z.string().nullable(),
  settings: sessionSettingsSchema,
  connectedAt: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
});

export function toSessionDto(s: Session): z.infer<typeof sessionDto> {
  return {
    id: s.id,
    name: s.name,
    phoneNumber: s.phone,
    status: s.status,
    desiredState: s.desiredState,
    lastError: s.lastError,
    settings: s.settings,
    connectedAt: iso(s.connectedAt),
    lastSeenAt: iso(s.lastSeenAt),
    createdAt: s.createdAt.toISOString(),
  };
}

export const messageDto = z.object({
  id: z.number(),
  sessionId: z.uuid(),
  direction: z.enum(MESSAGE_DIRECTIONS),
  jid: z.string(),
  type: z.enum(MESSAGE_TYPES),
  status: z.enum(MESSAGE_STATUSES),
  content: z.record(z.string(), z.unknown()),
  error: z.string().nullable(),
  waMessageId: z.string().nullable(),
  sentAt: z.string().nullable(),
  createdAt: z.string(),
});

/** Message rows as listed: everything but `raw` (the original WAMessage, large and never shown). */
export type MessageRow = Omit<Message, 'raw'>;

export function toMessageDto(m: MessageRow): z.infer<typeof messageDto> {
  return {
    id: m.id,
    sessionId: m.sessionId,
    direction: m.direction,
    jid: m.remoteJid,
    type: m.type,
    status: m.status,
    content: m.content as Record<string, unknown>,
    error: m.error,
    waMessageId: m.waMessageId,
    sentAt: iso(m.sentAt),
    createdAt: m.createdAt.toISOString(),
  };
}

export const apiKeyDto = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  kind: z.enum(['session', 'pat']),
  sessionId: z.uuid().nullable(),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
});

export function toApiKeyDto(k: ApiKey): z.infer<typeof apiKeyDto> {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    kind: k.sessionId ? 'session' : 'pat',
    sessionId: k.sessionId,
    lastUsedAt: iso(k.lastUsedAt),
    createdAt: k.createdAt.toISOString(),
  };
}
