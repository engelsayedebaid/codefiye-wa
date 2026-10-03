import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, LogOut, Plug, PlugZap, RefreshCw, Send, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import { MessageFeed } from '../app/MessageFeed';
import { useLiveEvents } from '../events';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { Link, navigate } from '../router';
import type { Message, Session, Template } from '../types';
import {
  Button,
  Card,
  cx,
  delay,
  ErrorNote,
  Field,
  flip,
  KeyReveal,
  Loading,
  LoadError,
  Phone,
  Select,
  SessionStatusBadge,
  SuccessNote,
  TextArea,
} from '../ui';
import { TemplatePreview } from './Templates';

const RUNNING = new Set(['connecting', 'qr', 'pairing', 'connected']);

type Action = 'connect' | 'disconnect' | 'logout' | 'delete' | 'key';

export function SessionDetailPage({ id }: { id: string }) {
  const { t, fmt } = useI18n();
  const d = t.sessionDetail;
  const queryClient = useQueryClient();
  const [pairing, setPairingCode] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);

  // Status changes arrive live: the app shell writes them into this cache entry.
  const query = useQuery({ queryKey: qk.session(id), queryFn: ({ signal }) => api<Session>(`/api/whatsapp-sessions/${id}`, { signal }) });
  const session = query.data ?? null;
  const showsQr = session?.status === 'qr' || session?.status === 'pairing';
  // A QR rotates about every 20s; each rotation arrives as an event that refreshes this. 409 = no QR (yet).
  const qr = useQuery({
    queryKey: qk.qr(id),
    queryFn: ({ signal }) => api<{ qrImage: string }>(`/api/whatsapp-sessions/${id}/qrcode`, { signal }),
    enabled: showsQr,
    retry: (count, err) => count < 3 && !(err instanceof ApiRequestError && err.status === 409),
  });
  const qrImage = showsQr ? (qr.data?.qrImage ?? null) : null;
  // A pairing code only means something while the session waits for it.
  const pairingCode = session?.status === 'pairing' ? pairing : null;

  useLiveEvents((event) => {
    if (event.sessionId !== id) return;
    switch (event.type) {
      case 'session.status':
        // Connected: reload the whole row (number, connected since).
        if (event.data.status === 'connected') void queryClient.invalidateQueries({ queryKey: qk.session(id) });
        break;
      case 'qrcode.updated':
        void queryClient.invalidateQueries({ queryKey: qk.qr(id) });
        break;
      case 'pairing.updated':
        setPairingCode(event.data.code);
        break;
    }
  });

  const setSession = (next: Session | ((s: Session) => Session)) =>
    queryClient.setQueryData<Session>(qk.session(id), (s) => (typeof next === 'function' ? s && next(s) : next));

  // One action at a time; each writes its result straight into the cache. Never retried by itself.
  const action = useMutation({
    mutationFn: async (kind: Action) => {
      switch (kind) {
        case 'connect': {
          // Waits server-side (up to ~15s) for a QR code or the connection.
          const result = await api<{ status: Session['status'] }>(`/api/whatsapp-sessions/${id}/connect`, { method: 'POST', timeoutMs: 35_000 });
          setSession((s) => ({ ...s, status: result.status, desiredState: 'running' }));
          return;
        }
        case 'disconnect':
          setSession(await api<Session>(`/api/whatsapp-sessions/${id}/disconnect`, { method: 'POST' }));
          return;
        case 'logout':
          setSession(await api<Session>(`/api/whatsapp-sessions/${id}/logout`, { method: 'POST', timeoutMs: 35_000 }));
          return;
        case 'delete':
          await api(`/api/whatsapp-sessions/${id}`, { method: 'DELETE', timeoutMs: 35_000 });
          queryClient.removeQueries({ queryKey: qk.session(id) });
          navigate('/sessions');
          return;
        case 'key':
          setNewKey((await api<{ apiKey: string }>(`/api/whatsapp-sessions/${id}/regenerate-key`, { method: 'POST' })).apiKey);
          return;
      }
    },
    onSettled: (_data, _err, kind) => {
      void queryClient.invalidateQueries({ queryKey: qk.sessions });
      if (kind === 'delete' || kind === 'key') void queryClient.invalidateQueries({ queryKey: qk.keys });
    },
  });
  const busy = action.isPending ? action.variables : null;
  const error = action.isError ? errorMessage(action.error) : null;
  const run = (kind: Action) => action.mutate(kind);

  if (!session) {
    return query.isError ? <LoadError error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} /> : <Loading className="py-24" />;
  }

  const running = session.desiredState === 'running' && RUNNING.has(session.status);
  const linked = Boolean(session.phoneNumber) && session.status !== 'logged_out';

  const connect = () => run('connect');
  const disconnect = () => run('disconnect');
  const logout = () => {
    if (confirm(d.confirmLogout)) run('logout');
  };
  const remove = () => {
    if (confirm(t.sessions.confirmDelete(session.name))) run('delete');
  };
  const regenerate = () => {
    if (confirm(d.confirmRegenerate)) run('key');
  };

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <button onClick={() => navigate('/sessions')} className="group inline-flex items-center gap-1 text-sm text-muted transition-colors hover:text-ink">
          <ArrowLeft className={cx('size-4 transition-transform group-hover:-translate-x-0.5 rtl:group-hover:translate-x-0.5', flip)} /> {d.back}
        </button>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight">{session.name}</h1>
            <SessionStatusBadge status={session.status} />
          </div>
          <div className="flex flex-wrap gap-2">
            {running ? (
              <Button variant="secondary" icon={<Plug className="size-4" />} loading={busy === 'disconnect'} onClick={disconnect}>
                {d.disconnect}
              </Button>
            ) : (
              <Button icon={<PlugZap className="size-4" />} loading={busy === 'connect'} onClick={connect}>
                {linked ? d.reconnect : d.link}
              </Button>
            )}
            {linked && (
              <Button variant="secondary" icon={<LogOut className="size-4" />} loading={busy === 'logout'} onClick={logout}>
                {d.logout}
              </Button>
            )}
            <Button variant="danger" icon={<Trash2 className="size-4" />} loading={busy === 'delete'} onClick={remove}>
              {t.common.delete}
            </Button>
          </div>
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <div className="space-y-6">
          <Card title={d.linking} className="animate-fade-up" style={delay(60)}>
            {session.status === 'connected' ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                <dt className="text-muted">{d.number}</dt>
                <dd>
                  <Phone value={session.phoneNumber} />
                </dd>
                <dt className="text-muted">{d.connectedSince}</dt>
                <dd>{fmt.timeAgo(session.connectedAt)}</dd>
                <dt className="text-muted">{d.lastActivity}</dt>
                <dd>{fmt.timeAgo(session.lastSeenAt)}</dd>
              </dl>
            ) : session.status === 'qr' || session.status === 'pairing' ? (
              <QrPanel sessionId={id} qrImage={qrImage} pairingCode={pairingCode} onPairingCode={setPairingCode} />
            ) : session.status === 'connecting' ? (
              <p className="flex items-center gap-2 text-sm text-muted">
                <RefreshCw className="size-4 animate-spin" /> {d.connecting}
              </p>
            ) : (
              <div className="space-y-2 text-sm text-muted">
                <p>{linked ? d.stoppedLinked : d.stoppedUnlinked}</p>
                {session.lastError && <p className="text-red-400">{session.lastError}</p>}
              </div>
            )}
          </Card>

          <SendTest sessionId={id} disabled={session.status !== 'connected'} onSent={() => void queryClient.invalidateQueries({ queryKey: qk.messages(id) })} />

          <Card title={d.keyTitle} className="animate-fade-up" style={delay(180)}>
            <p className="mb-4 text-sm text-muted">
              {d.keyTextBefore} <code className="ltr font-mono whitespace-nowrap">Authorization: Bearer was_…</code>
              {d.keyTextAfter}
            </p>
            <Button variant="secondary" icon={<KeyRound className="size-4" />} loading={busy === 'key'} onClick={regenerate}>
              {d.regenerate}
            </Button>
          </Card>
        </div>

        <MessagesLog sessionId={id} />
      </div>

      {newKey && <KeyReveal title={d.newKeyTitle} value={newKey} onClose={() => setNewKey(null)} />}
    </div>
  );
}

function QrPanel({
  sessionId,
  qrImage,
  pairingCode,
  onPairingCode,
}: {
  sessionId: string;
  qrImage: string | null;
  pairingCode: string | null;
  onPairingCode: (code: string) => void;
}) {
  const { t } = useI18n();
  const d = t.sessionDetail;
  const [phone, setPhone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const requestCode = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const { pairingCode: code } = await api<{ pairingCode: string }>(`/api/whatsapp-sessions/${sessionId}/pairing-code`, {
        method: 'POST',
        body: { phoneNumber: phone },
      });
      onPairingCode(code);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center gap-3">
        {qrImage ? (
          <img key={qrImage} src={qrImage} alt={d.qrAlt} className="animate-scale-in size-60 rounded-lg bg-white p-2 shadow-[0_0_50px_-12px] shadow-brand/50" />
        ) : (
          <div className="flex size-60 items-center justify-center rounded-lg border border-dashed border-line text-sm text-faint">
            <RefreshCw className="size-5 animate-spin" />
          </div>
        )}
        <ol className="list-inside list-decimal space-y-0.5 text-sm text-muted">
          {d.qrSteps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </div>
      <div className="border-t border-line pt-4">
        {pairingCode ? (
          <div className="animate-scale-in space-y-2 text-center">
            <p className="text-sm text-muted">{d.pairingPrompt}</p>
            <p className="ltr font-mono text-3xl font-semibold tracking-widest">{pairingCode}</p>
          </div>
        ) : (
          <form onSubmit={requestCode} className="space-y-3">
            <Field label={d.pairingLabel} placeholder="+201012345678" value={phone} onChange={(e) => setPhone(e.target.value)} dir="ltr" required hint={d.pairingHint} />
            <ErrorNote>{error}</ErrorNote>
            <Button type="submit" variant="secondary" loading={loading} className="w-full">
              {d.pairingSubmit}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}

function SendTest({ sessionId, disabled, onSent }: { sessionId: string; disabled: boolean; onSent: () => void }) {
  const { t } = useI18n();
  const d = t.sessionDetail;
  const [to, setTo] = useState('');
  const [mode, setMode] = useState<'text' | 'template'>('text');
  const [text, setText] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string | null>(null);

  // Loaded the first time the template tab opens; the same cache as the templates page.
  const templatesQuery = useQuery({
    queryKey: qk.templates,
    queryFn: ({ signal }) => api<Template[]>('/api/templates', { signal }),
    enabled: mode === 'template',
  });
  const templates = templatesQuery.data ?? null;
  const template = templates?.find((x) => x.id === templateId) ?? templates?.[0] ?? null;

  const send = useMutation({
    mutationFn: () => {
      const body =
        mode === 'template' && template
          ? { to, template: template.name, variables: Object.fromEntries(template.variables.map((v) => [v, values[v] ?? ''])) }
          : { to, text };
      return api<{ msgId: number }>('/api/send-message', { method: 'POST', sessionId, body });
    },
    onSuccess: (sent) => {
      setResult(d.queued(sent.msgId));
      if (mode === 'text') setText('');
      onSent();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (send.isPending) return;
    setResult(null);
    send.mutate();
  };
  const loading = send.isPending;
  const error = send.isError ? errorMessage(send.error) : null;

  return (
    <Card title={d.testTitle} className="animate-fade-up" style={delay(120)}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={d.to} placeholder="+201012345678" value={to} onChange={(e) => setTo(e.target.value)} dir="ltr" required disabled={disabled} />
        <div className="flex w-fit rounded-md border border-line p-0.5" role="group">
          {(['text', 'template'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
              className={cx('rounded px-3 py-1 text-sm font-medium transition-colors', mode === m ? 'bg-raised text-ink' : 'text-muted hover:text-ink')}
            >
              {m === 'text' ? d.modeText : d.modeTemplate}
            </button>
          ))}
        </div>
        {mode === 'text' ? (
          <TextArea label={d.text} value={text} onChange={(e) => setText(e.target.value)} required disabled={disabled} rows={3} />
        ) : templates === null ? (
          templatesQuery.isError ? (
            <LoadError error={templatesQuery.error} onRetry={() => void templatesQuery.refetch()} retrying={templatesQuery.isFetching} />
          ) : (
            <Loading className="py-4" />
          )
        ) : templates.length === 0 ? (
          <p className="animate-fade-in text-sm text-muted">
            {d.noTemplates}{' '}
            <Link href="/templates" className="text-ink underline underline-offset-4">
              {d.manageTemplates}
            </Link>
          </p>
        ) : (
          <div key="template" className="animate-fade-in space-y-4">
            <Select
              label={d.template}
              value={template?.id ?? ''}
              onChange={(id) => {
                setTemplateId(id);
                setValues({});
              }}
              options={templates.map((x) => ({ value: x.id, label: <span className="ltr font-mono">{x.name}</span> }))}
            />
            {template?.variables.map((v) => (
              <Field
                key={`${template.id}-${v}`}
                label={v}
                value={values[v] ?? ''}
                onChange={(e) => setValues((prev) => ({ ...prev, [v]: e.target.value }))}
                placeholder={t.templates.samples[v]}
                required
                disabled={disabled}
              />
            ))}
            {template && <TemplatePreview template={template} values={values} />}
          </div>
        )}
        <ErrorNote>{error}</ErrorNote>
        <SuccessNote>{result}</SuccessNote>
        <Button type="submit" icon={<Send className={cx('size-4', flip)} />} loading={loading} disabled={disabled || (mode === 'template' && !template)}>
          {d.send}
        </Button>
        {disabled && <p className="text-xs text-muted">{d.onlyConnected}</p>}
      </form>
    </Card>
  );
}

/** Refreshed by message events (bursts collapse into one reload, see the app shell) and when the tab regains focus. */
function MessagesLog({ sessionId }: { sessionId: string }) {
  const query = useQuery({
    queryKey: qk.messages(sessionId),
    queryFn: ({ signal }) => api<{ messages: Message[] }>('/api/messages?limit=25', { sessionId, signal }).then((r) => r.messages),
  });
  return (
    <MessageFeed
      messages={query.data ?? null}
      error={query.isError ? errorMessage(query.error) : null}
      onRetry={() => void query.refetch()}
      retrying={query.isFetching}
    />
  );
}
