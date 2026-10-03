import type { MessageStatus, MessageType, SessionStatus, WaEvent } from '@wa/shared';

/** Mirrors the API DTOs in apps/api/src/lib/dto.ts. */
export type Session = {
  id: string;
  name: string;
  phoneNumber: string | null;
  status: SessionStatus;
  desiredState: 'running' | 'stopped';
  lastError: string | null;
  settings: { autoRead?: boolean; rejectCalls?: boolean };
  connectedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
};

export type Message = {
  id: number;
  sessionId: string;
  direction: 'in' | 'out';
  jid: string;
  type: MessageType;
  status: MessageStatus;
  content: Record<string, unknown>;
  error: string | null;
  waMessageId: string | null;
  sentAt: string | null;
  createdAt: string;
};

export type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  kind: 'session' | 'pat';
  sessionId: string | null;
  lastUsedAt: string | null;
  createdAt: string;
};

/** SSE payloads: worker events without the workspace id. */
export type LiveEvent = WaEvent extends infer E ? (E extends WaEvent ? Omit<E, 'workspaceId'> : never) : never;

export type TemplateCategory = 'otp' | 'notification' | 'marketing' | 'custom';

export type Template = {
  id: string;
  name: string;
  category: TemplateCategory;
  body: string;
  imageUrl: string | null;
  buttons: string[] | null;
  buttonsTitle: string | null;
  variables: string[];
  createdAt: string;
  updatedAt: string;
};
