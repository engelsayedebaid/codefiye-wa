import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { api, ApiRequestError, errorMessage } from '../../api';
import { getDict } from '../../i18n';
import { qk } from '../../queries';
import type { ChatMessage, MessagesPage } from './model';

/**
 * Messages written on the chats page, from Send until the server has them. They show at once as
 * "sending" bubbles; the requests go out one at a time per number, so WhatsApp gets them in the order
 * they were written. Each carries its own Idempotency-Key: a retry after a lost response (or a
 * double click) can never queue it twice. Kept outside React so switching chats keeps them.
 */

export type Draft = {
  text?: string;
  file?: File;
  /** Send an audio file as a voice note. */
  ptt?: boolean;
  /** Length of a recorded voice note. */
  seconds?: number;
  quote?: ChatMessage | null;
};

export type Pending = {
  ref: string;
  draft: Draft;
  createdAt: string;
  state: 'sending' | 'failed';
  error?: string;
  /** The stored message, once the server answered (it may reach the list a moment later). */
  realId?: number;
  /** Object URL of the attached file, for a preview while it uploads. */
  localSrc?: string;
  /** The file is already uploaded: a retry only resends the message. */
  uploadId?: string;
};

type Pages = InfiniteData<MessagesPage, number | undefined>;

const EMPTY: Pending[] = [];
const store = new Map<string, Pending[]>();
const listeners = new Set<() => void>();
/** The request chain of each number. */
const chains = new Map<string, Promise<void>>();

const keyOf = (sessionId: string, jid: string) => `${sessionId}\n${jid}`;
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

function update(key: string, fn: (list: Pending[]) => Pending[]) {
  const next = fn(store.get(key) ?? EMPTY);
  if (next.length) store.set(key, next);
  else store.delete(key);
  emit();
}
const patch = (key: string, ref: string, changes: Partial<Pending>) => update(key, (list) => list.map((p) => (p.ref === ref ? { ...p, ...changes } : p)));
const find = (key: string, ref: string) => store.get(key)?.find((p) => p.ref === ref);

function release(p: Pending) {
  if (p.localSrc) URL.revokeObjectURL(p.localSrc);
}

/** This chat's messages that are still on their way (oldest first). */
export function usePending(sessionId: string, jid: string): Pending[] {
  const key = keyOf(sessionId, jid);
  return useSyncExternalStore(subscribe, () => store.get(key) ?? EMPTY);
}

const PREVIEWABLE = /^(image|audio|video)\//;

export function enqueue(queryClient: QueryClient, sessionId: string, jid: string, draft: Draft) {
  const key = keyOf(sessionId, jid);
  const pending: Pending = {
    ref: crypto.randomUUID(),
    draft,
    createdAt: new Date().toISOString(),
    state: 'sending',
    localSrc: draft.file && PREVIEWABLE.test(draft.file.type) ? URL.createObjectURL(draft.file) : undefined,
  };
  update(key, (list) => [...list, pending]);
  schedule(queryClient, sessionId, jid, pending.ref);
}

export function retry(queryClient: QueryClient, sessionId: string, jid: string, ref: string) {
  const key = keyOf(sessionId, jid);
  if (!find(key, ref)) return;
  patch(key, ref, { state: 'sending', error: undefined });
  schedule(queryClient, sessionId, jid, ref);
}

export function discard(sessionId: string, jid: string, ref: string) {
  const key = keyOf(sessionId, jid);
  const p = find(key, ref);
  if (!p || p.state !== 'failed') return;
  release(p);
  update(key, (list) => list.filter((x) => x.ref !== ref));
}

/** The server announced a message sent with this key (its event can beat the response). */
export function resolveRef(sessionId: string, jid: string, ref: string, id: number) {
  const key = keyOf(sessionId, jid);
  if (find(key, ref)?.realId === undefined) patch(key, ref, { realId: id });
}

/** Drops pending messages the conversation now shows for real. */
export function settle(sessionId: string, jid: string, shown: (id: number) => boolean) {
  const key = keyOf(sessionId, jid);
  const list = store.get(key);
  if (!list?.some((p) => p.realId !== undefined && shown(p.realId))) return;
  update(key, (all) =>
    all.filter((p) => {
      const done = p.realId !== undefined && shown(p.realId);
      if (done) release(p);
      return !done;
    }),
  );
}

function schedule(queryClient: QueryClient, sessionId: string, jid: string, ref: string) {
  const next = (chains.get(sessionId) ?? Promise.resolve()).then(() => deliver(queryClient, sessionId, jid, ref));
  chains.set(sessionId, next);
  void next.finally(() => chains.get(sessionId) === next && chains.delete(sessionId));
}

async function upload(file: File): Promise<string> {
  let res: Response;
  try {
    res = await fetch('/api/chats/uploads', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/octet-stream', 'x-mime-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
      body: file,
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new ApiRequestError(0, getDict().common.networkError, 'network');
  }
  const json = (await res.json().catch(() => null)) as { success: boolean; data?: { id: string }; message?: string } | null;
  if (!res.ok || !json?.success || !json.data) throw new ApiRequestError(res.status, json?.message ?? getDict().chats.errors.upload);
  return json.data.id;
}

async function deliver(queryClient: QueryClient, sessionId: string, jid: string, ref: string) {
  const key = keyOf(sessionId, jid);
  const p = find(key, ref);
  if (!p || p.realId !== undefined) return;
  const { text, file, ptt, seconds, quote } = p.draft;
  try {
    let uploadId = p.uploadId;
    if (file && !uploadId) {
      uploadId = await upload(file);
      patch(key, ref, { uploadId });
    }
    const m = await api<ChatMessage>(`/api/chats/${sessionId}/send`, {
      method: 'POST',
      headers: { 'idempotency-key': ref },
      body: {
        jid,
        ...(text?.trim() ? { text: text.trim() } : {}),
        ...(uploadId ? { uploadId, ...(ptt ? { ptt: true, ...(seconds ? { seconds } : {}) } : {}) } : {}),
        ...(quote?.waMessageId ? { quoteId: quote.waMessageId } : {}),
      },
      timeoutMs: 60_000,
    });
    // Into the conversation, newest first, in id order (an event may have brought newer ones).
    let shown = false;
    queryClient.setQueryData<Pages>(qk.chats.messages(sessionId, jid), (data) => {
      const first = data?.pages[0];
      if (!data || !first) return data;
      shown = true;
      if (data.pages.some((page) => page.messages.some((x) => x.id === m.id))) return data;
      const at = first.messages.findIndex((x) => x.id < m.id);
      const messages = at === -1 ? [...first.messages, m] : [...first.messages.slice(0, at), m, ...first.messages.slice(at)];
      return { ...data, pages: [{ ...first, messages }, ...data.pages.slice(1)] };
    });
    patch(key, ref, { realId: m.id });
    if (shown) settle(sessionId, jid, (id) => id === m.id);
  } catch (err) {
    // The upload expired: the next retry uploads the file again.
    const expired = err instanceof ApiRequestError && err.status === 422 && Boolean(err.errors?.uploadId);
    patch(key, ref, { state: 'failed', error: errorMessage(err), ...(expired ? { uploadId: undefined } : {}) });
  }
}
