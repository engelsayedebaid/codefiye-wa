export type SessionStatus =
  | 'created'
  | 'qr'
  | 'pairing'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'needs_attention'
  | 'logged_out';

export type Session = {
  id: string;
  name: string;
  phone: string | null;
  status: SessionStatus;
  lastSeenAt: string | null;
  createdAt: string;
};

export type Creds = { baseUrl: string; token: string; mode?: 'pat' | 'neon'; getToken?: () => Promise<string> };
/** API base: dev defaults to localhost:4000; production falls back to same-origin (Vercel rewrite → api service). */
export const API_BASE = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:4000' : '');
/** Absolute API origin for display (docs links, copyable base URL). */
export const API_PUBLIC = API_BASE || (typeof window !== 'undefined' ? window.location.origin : '');
export type PlanInfo = { id: string; name: string; egp: number; sessions: number; dailyMessages: number | null; internal?: boolean; enabled?: boolean; sortOrder?: number };
export type AdminPlan = { key: string; name: string; egp: number; sessions: number; dailyMessages: number | null; internal: boolean; enabled: boolean; sortOrder: number };
export type Profile = {
  workspace: { id: string; name: string; planId: string; trialEndsAt: string | null; planExpiresAt: string | null; suspendedAt: string | null; createdAt: string };
  plan: PlanInfo;
  isAdmin: boolean;
  authType: string;
  email: string | null;
  billingEnabled: boolean;
  webhooksEnabled: boolean;
};
export type Overview = { sessions: { total: number; connected: number }; messages: { total: number; sent: number; received: number; failed: number }; daily: { day: string; count: number }[]; activeKeys: number };
export type MessageRow = { id: string; sessionName: string; remoteJid: string; direction: string; type: string; status: string; error: string | null; createdAt: string };
export type MessagePage = { items: MessageRow[]; total: number; page: number; pageSize: number };
export type KeyRow = { id: string; name: string; prefix: string; sessionId: string | null; lastUsedAt: string | null; revokedAt: string | null; createdAt: string };
export type PaymentRequest = { id: string; planId: string; amountEgp: number; months: number; method: string; reference: string | null; note: string | null; status: 'pending' | 'approved' | 'rejected'; adminNote: string | null; createdAt: string; reviewedAt: string | null };
export type PayMethod = { id: string; label: string; details: string; instructions: string; enabled?: boolean; sortOrder?: number };
export type Billing = { plan: PlanInfo; planId: string; planExpiresAt: string | null; trialEndsAt: string | null; plans: PlanInfo[]; methods: PayMethod[]; requests: PaymentRequest[] };
export type AdminPayment = PaymentRequest & { workspaceId: string; workspaceName: string; email: string | null; reviewedBy: string | null };
export type AdminClient = { id: string; name: string; email: string | null; planId: string; planExpiresAt: string | null; suspendedAt: string | null; createdAt: string };
export type AdminWorker = { id: string; sessions: number; maxSessions: number; lastSeenAt: string };
export type AdminSession = { id: string; name: string; workspace: string; workspaceId: string; status: SessionStatus; phone: string | null; lastSeenAt: string | null };
export type AdminOverview = { counts: { workspaces: number; sessions: number; messages: number }; clients: AdminClient[]; workers: AdminWorker[]; sessions: AdminSession[]; pendingPayments: number };

const STORAGE_KEY = 'wa.creds';
export const loadCreds = (): Creds | null => {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null');
    return value && typeof value.token === 'string' && typeof value.baseUrl === 'string' ? value : null;
  } catch { return null; }
};
export const saveCreds = (c: Creds | null) =>
  c ? sessionStorage.setItem(STORAGE_KEY, JSON.stringify(c)) : sessionStorage.removeItem(STORAGE_KEY);

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly errors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

export function createClient({ baseUrl, token, getToken }: Creds) {
  const accessToken = () => getToken ? getToken() : Promise.resolve(token);
  async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(baseUrl.replace(/\/$/, '') + path, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, 'تعذّر الاتصال بالخادم — تأكد أن الـ API يعمل');
    }
    const json = await res.json().catch(() => ({ success: false, message: res.statusText }));
    if (!res.ok || !json.success) throw new ApiError(res.status, json.message ?? 'Request failed', json.errors);
    return json.data as T;
  }

  return {
    profile: () => call<Profile>('GET', '/api/console/me'),
    overview: () => call<Overview>('GET', '/api/console/overview'),
    messages: (page = 1, search = '', status = 'all') => call<MessagePage>('GET', `/api/console/messages?${new URLSearchParams({ page: String(page), search, status })}`),
    keys: () => call<KeyRow[]>('GET', '/api/console/keys'),
    createKey: (name: string, sessionId: string | null) => call<{ id: string; key: string }>('POST', '/api/console/keys', { name, sessionId }),
    revokeKey: (id: string) => call('POST', `/api/console/keys/${id}/revoke`),
    renameWorkspace: (name: string) => call('PATCH', '/api/console/workspace', { name }),
    billing: () => call<Billing>('GET', '/api/console/billing'),
    requestPayment: (body: { planId: string; months: number; methodId: string; reference?: string; note?: string }) =>
      call<PaymentRequest>('POST', '/api/console/billing/request', body),
    adminOverview: () => call<AdminOverview>('GET', '/api/admin/overview'),
    adminPayments: (status = 'all') => call<AdminPayment[]>('GET', `/api/admin/payments?status=${status}`),
    adminApprovePayment: (id: string, note?: string) => call('POST', `/api/admin/payments/${id}/approve`, note ? { note } : {}),
    adminRejectPayment: (id: string, note?: string) => call('POST', `/api/admin/payments/${id}/reject`, note ? { note } : {}),
    adminCreateClient: (body: { email: string; name: string; planId?: string }) => call<{ workspace: AdminClient; key: string; email: string }>('POST', '/api/admin/clients', body),
    adminUpdateClient: (id: string, body: { planId?: string; extendMonths?: number; suspend?: boolean }) => call<AdminClient>('PATCH', `/api/admin/clients/${id}`, body),
    adminPlans: () => call<AdminPlan[]>('GET', '/api/admin/plans'),
    adminCreatePlan: (body: { key: string; name: string; egp: number; sessions: number; dailyMessages: number | null; internal?: boolean; enabled?: boolean; sortOrder?: number }) => call<AdminPlan>('POST', '/api/admin/plans', body),
    adminUpdatePlan: (key: string, body: Partial<Omit<AdminPlan, 'key'>>) => call<AdminPlan>('PATCH', `/api/admin/plans/${key}`, body),
    adminMethods: () => call<PayMethod[]>('GET', '/api/admin/payment-methods'),
    adminCreateMethod: (body: { label: string; details: string; instructions: string; enabled?: boolean; sortOrder?: number }) => call<PayMethod>('POST', '/api/admin/payment-methods', body),
    adminUpdateMethod: (id: string, body: Partial<{ label: string; details: string; instructions: string; enabled: boolean; sortOrder: number }>) => call<PayMethod>('PATCH', `/api/admin/payment-methods/${id}`, body),
    adminDeleteMethod: (id: string) => call('DELETE', `/api/admin/payment-methods/${id}`),
    listSessions: () => call<Session[]>('GET', '/api/whatsapp-sessions'),
    createSession: (name: string) => call<Session & { apiKey: string }>('POST', '/api/whatsapp-sessions', { name }),
    connect: (id: string) => call<{ status: SessionStatus }>('POST', `/api/whatsapp-sessions/${id}/connect`),
    disconnect: (id: string) => call('POST', `/api/whatsapp-sessions/${id}/disconnect`),
    logout: (id: string) => call('POST', `/api/whatsapp-sessions/${id}/logout`),
    remove: (id: string) => call('DELETE', `/api/whatsapp-sessions/${id}`),
    pairingCode: (id: string, phone: string) => call<{ code: string }>('POST', `/api/whatsapp-sessions/${id}/pairing-code`, { phone }),
    sendText: (id: string, to: string, text: string) =>
      call<{ id: string; status: string }>('POST', '/api/send-message', { to, text }, { 'X-Session-Id': id }),

    /** SSE over fetch (EventSource can't send Authorization headers). */
    events(id: string, onEvent: (event: string, data: any) => void, signal: AbortSignal) {
      void (async () => {
        while (!signal.aborted) {
          try {
            const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/whatsapp-sessions/${id}/events`, {
              headers: { Authorization: `Bearer ${await accessToken()}`, Accept: 'text/event-stream' },
              signal,
            });
            if (res.status === 401 || res.status === 403) { onEvent('stream.error', { message: 'انتهت الجلسة أو لا توجد صلاحية. أعد تسجيل الدخول.' }); return; }
            if (!res.ok || !res.body) throw new Error('no stream');
            const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
            let buf = '';
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += value;
              let idx;
              while ((idx = buf.indexOf('\n\n')) >= 0) {
                const chunk = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                const event = /^event: (.+)$/m.exec(chunk)?.[1];
                const data = /^data: (.+)$/m.exec(chunk)?.[1];
                if (event && data) onEvent(event, JSON.parse(data));
              }
            }
          } catch {
            if (signal.aborted) return;
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      })();
    },
  };
}

export type Client = ReturnType<typeof createClient>;
