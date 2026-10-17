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
 *
 * A temporary failure (no network, a timeout, the server busy) is retried on its own a few times,
 * and a dropped connection waits for the network to come back; only what still fails asks the user.
 * Text messages survive a reload (localStorage) and carry on from where they were.
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
  /** Between automatic retries: waiting for the network to return, or for the next try. */
  waiting?: 'network' | 'retry';
  /** Share of the attachment uploaded so far (0–1), while it uploads. */
  progress?: number;
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

/** `save`: also rewrite the saved copy (not for progress ticks, which only the screen needs). */
function update(key: string, fn: (list: Pending[]) => Pending[], save = true) {
  const next = fn(store.get(key) ?? EMPTY);
  if (next.length) store.set(key, next);
  else store.delete(key);
  emit();
  if (save) persist();
}
const patch = (key: string, ref: string, changes: Partial<Pending>) =>
  update(
    key,
    (list) => list.map((p) => (p.ref === ref ? { ...p, ...changes } : p)),
    Object.keys(changes).some((k) => k !== 'progress' && k !== 'waiting'),
  );
const find = (key: string, ref: string) => store.get(key)?.find((p) => p.ref === ref);

function release(p: Pending) {
  if (p.localSrc) URL.revokeObjectURL(p.localSrc);
}

// --- surviving a reload --------------------------------------------------------------------------

const SAVE_KEY = 'wa.outbox';
/** Older unsent messages are dropped on load rather than sent late out of the blue. */
const SAVE_MAX_AGE_MS = 24 * 3_600_000;
type Saved = { sessionId: string; jid: string; ref: string; text: string; quote: ChatMessage | null; createdAt: string; state: Pending['state']; error?: string };

/** Text messages not yet stored on the server (files can't be kept across a reload). */
function persist() {
  const saved: Saved[] = [];
  for (const [key, list] of store) {
    const [sessionId, jid] = key.split('\n') as [string, string];
    for (const p of list) {
      if (p.realId !== undefined || p.draft.file || !p.draft.text?.trim()) continue;
      saved.push({ sessionId, jid, ref: p.ref, text: p.draft.text, quote: p.draft.quote ?? null, createdAt: p.createdAt, state: p.state, error: p.error });
    }
  }
  try {
    if (saved.length) localStorage.setItem(SAVE_KEY, JSON.stringify(saved));
    else localStorage.removeItem(SAVE_KEY);
  } catch {
    // storage unavailable or full: they live as long as the tab
  }
}

let restored = false;
/** Once per page load: brings back what a reload interrupted, and sends on the ones that were on their way. */
export function restoreOutbox(queryClient: QueryClient) {
  if (restored) return;
  restored = true;
  let saved: Saved[] = [];
  try {
    saved = JSON.parse(localStorage.getItem(SAVE_KEY) ?? '[]') as Saved[];
  } catch {
    return;
  }
  const fresh = saved.filter((s) => s && typeof s.text === 'string' && Date.now() - new Date(s.createdAt).getTime() < SAVE_MAX_AGE_MS);
  for (const s of fresh) {
    const key = keyOf(s.sessionId, s.jid);
    if (find(key, s.ref)) continue;
    const p: Pending = { ref: s.ref, draft: { text: s.text, quote: s.quote }, createdAt: s.createdAt, state: s.state, error: s.error };
    update(key, (list) => [...list, p]);
    // Same key as before the reload: if it had reached the server, this returns that message.
    if (s.state === 'sending') schedule(queryClient, s.sessionId, s.jid, s.ref);
  }
  persist();
}

// --- the queue -----------------------------------------------------------------------------------

/** This chat's messages that are still on their way (oldest first), right now. */
export const pendingFor = (sessionId: string, jid: string): Pending[] => store.get(keyOf(sessionId, jid)) ?? EMPTY;

/** The same, re-rendering as they change. */
export function usePending(sessionId: string, jid: string): Pending[] {
  return useSyncExternalStore(subscribe, () => pendingFor(sessionId, jid));
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
  patch(key, ref, { state: 'sending', error: undefined, waiting: undefined });
  schedule(queryClient, sessionId, jid, ref);
}

export function discard(sessionId: string, jid: string, ref: string) {
  const key = keyOf(sessionId, jid);
  const p = find(key, ref);
  // Failed, or waiting between automatic tries: the user may give up on it.
  if (!p || (p.state !== 'failed' && !p.waiting)) return;
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

const UPLOAD_TIMEOUT_MS = 180_000;

type UploadReply = { success?: boolean; data?: { id: string }; message?: string; code?: string; details?: Record<string, unknown> };
const parseUploadReply = (body: string): UploadReply | null => {
  try {
    return JSON.parse(body) as UploadReply;
  } catch {
    return null; // not JSON (a proxy's error page)
  }
};

/** Uploads an attachment, reporting progress (fetch can't, hence XHR). Errors come back as ApiRequestError. */
function upload(file: File, onProgress: (share: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/chats/uploads');
    xhr.withCredentials = true;
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.setRequestHeader('x-mime-type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    const dict = getDict();
    xhr.onerror = () => reject(new ApiRequestError(0, dict.common.networkError, 'network'));
    xhr.ontimeout = () => reject(new ApiRequestError(0, dict.errors.timeout, 'timeout'));
    xhr.onload = () => {
      const json = parseUploadReply(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300 && json?.success && json.data) return resolve(json.data.id);
      reject(new ApiRequestError(xhr.status, json?.message ?? dict.chats.errors.upload, json?.code, undefined, json?.details, xhr.getResponseHeader('x-request-id') ?? undefined));
    };
    xhr.send(file);
  });
}

/** Waits between automatic tries; the last one is followed by "failed" and a Retry button. */
const RETRY_DELAYS_MS = [1_500, 4_000, 10_000, 20_000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Only a browser that says it's offline counts (no `navigator.onLine` = assume online). */
const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;
const online = () => (offline() ? new Promise<void>((resolve) => window.addEventListener('online', () => resolve(), { once: true })) : Promise.resolve());

/**
 * Worth trying again by itself: no answer, a timeout, rate limited, or the server/worker briefly
 * unavailable. A retry is safe: the same Idempotency-Key returns the message already made.
 */
const temporary = (err: unknown) => err instanceof ApiRequestError && err.transient && err.code !== 'worker_outdated';

async function deliver(queryClient: QueryClient, sessionId: string, jid: string, ref: string) {
  const key = keyOf(sessionId, jid);
  for (let attempt = 0; ; attempt++) {
    const p = find(key, ref);
    if (!p || p.realId !== undefined || p.state !== 'sending') return;
    try {
      await sendOnce(queryClient, sessionId, jid, ref, p);
      return;
    } catch (err) {
      if (!find(key, ref)) return;
      // The upload expired: the next try uploads the file again.
      const expired = err instanceof ApiRequestError && err.status === 422 && Boolean(err.errors?.uploadId);
      if (expired) patch(key, ref, { uploadId: undefined });
      if (temporary(err)) {
        // Offline: no point counting tries; send as soon as the network is back.
        if (offline()) {
          patch(key, ref, { waiting: 'network', progress: undefined });
          await online();
          patch(key, ref, { waiting: undefined });
          attempt = -1;
          continue;
        }
        if (attempt < RETRY_DELAYS_MS.length) {
          const asked = err instanceof ApiRequestError ? Number(err.details?.retryAfter ?? 0) * 1000 : 0;
          patch(key, ref, { waiting: 'retry', progress: undefined });
          await sleep(Math.max(asked, RETRY_DELAYS_MS[attempt]!));
          patch(key, ref, { waiting: undefined });
          continue;
        }
      }
      // The number dropped while this was on its way: show its real state at once.
      if (err instanceof ApiRequestError && err.code === 'session_not_connected') void queryClient.invalidateQueries({ queryKey: qk.chats.numbers });
      patch(key, ref, { state: 'failed', error: errorMessage(err), waiting: undefined, progress: undefined });
      return;
    }
  }
}

async function sendOnce(queryClient: QueryClient, sessionId: string, jid: string, ref: string, p: Pending) {
  const key = keyOf(sessionId, jid);
  const { text, file, ptt, seconds, quote } = p.draft;
  let uploadId = p.uploadId;
  if (file && !uploadId) {
    patch(key, ref, { progress: 0 });
    uploadId = await upload(file, (share) => patch(key, ref, { progress: share }));
    patch(key, ref, { uploadId, progress: undefined });
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
}
