/**
 * Conversation sync (dashboard `/chats`): a persistent job per number that asks the phone for the
 * older history of each conversation, page by page. Zod-free so the dashboard can import it.
 */

/**
 * `queued`: waiting for the number to connect or for a free sync slot on its worker.
 * `paused`: by the user, or because the phone stopped answering (`pauseReason`). Terminal:
 * `completed` (some conversations may have failed: see `chatsFailed`), `cancelled`, `failed`.
 */
export const SYNC_STATUSES = ['queued', 'running', 'paused', 'completed', 'cancelled', 'failed'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** A job in one of these blocks starting another for the same number. */
export const ACTIVE_SYNC_STATUSES: readonly SyncStatus[] = ['queued', 'running', 'paused'];

export const SYNC_CHAT_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type SyncChatStatus = (typeof SYNC_CHAT_STATUSES)[number];

export const SYNC_LOG_LEVELS = ['info', 'progress', 'success', 'warning', 'error'] as const;
export type SyncLogLevel = (typeof SYNC_LOG_LEVELS)[number];

export const SYNC_PAUSE_REASONS = ['user', 'phone_unresponsive'] as const;
export type SyncPauseReason = (typeof SYNC_PAUSE_REASONS)[number];

/**
 * What a log line says; the dashboard words it (both languages) from `code` + `params`:
 * name (conversation), added, page, attempt, total, error.
 */
export const SYNC_LOG_CODES = [
  'started',
  'resumed',
  'waiting_connection',
  'waiting_slot',
  'found_chats',
  'contacts_requested',
  'contacts_failed',
  'chat_start',
  'chat_page',
  'chat_done',
  'chat_end',
  'chat_retry',
  'chat_failed',
  'group_named',
  'senders_repaired',
  'paused',
  'phone_unresponsive',
  'cancelled',
  'retrying_failed',
  'completed',
  'failed',
] as const;
export type SyncLogCode = (typeof SYNC_LOG_CODES)[number];

export type SyncLogParams = { name?: string; added?: number; page?: number; attempt?: number; total?: number; error?: string };

export type SyncLogEntry = { id: number; at: string; level: SyncLogLevel; code: SyncLogCode; params: SyncLogParams };

export type SyncProgress = {
  jobId: string;
  status: SyncStatus;
  pauseReason: SyncPauseReason | null;
  chatsTotal: number;
  chatsDone: number;
  chatsFailed: number;
  messagesAdded: number;
  /** The conversation being synced now. */
  current: { jid: string; name: string | null } | null;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
};

export const isActiveSync = (status: SyncStatus) => ACTIVE_SYNC_STATUSES.includes(status);
