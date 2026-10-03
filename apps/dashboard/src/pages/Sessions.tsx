import { SESSION_STATUSES, type SessionStatus } from '@wa/shared/constants';
import { suggestNames } from '@wa/shared/name-suggestions';
import { Plus, RefreshCw, Settings2, Smartphone, Trash2 } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import { isUnlimitedPlan, useAccount } from '../app/account';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { Link, navigate, useQuery as useSearchParams } from '../router';
import type { Session } from '../types';
import {
  Button,
  buttonClass,
  cx,
  delay,
  EmptyState,
  ErrorNote,
  Field,
  KeyReveal,
  LoadError,
  Modal,
  PageHeader,
  Phone,
  Progress,
  Select,
  SESSION_STATUS,
  SessionStatusBadge,
  TONES,
} from '../ui';

export function SessionsPage() {
  const { t, fmt } = useI18n();
  const s = t.sessions;
  const search = useSearchParams();
  const { account } = useAccount();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<SessionStatus | 'all'>('all');
  const [creating, setCreating] = useState(search.get('new') === '1');
  const [created, setCreated] = useState<{ id: string; apiKey: string } | null>(null);
  // Live status changes are written into this cache by the app shell.
  const list = useQuery({ queryKey: qk.sessions, queryFn: ({ signal }) => api<Session[]>('/api/whatsapp-sessions', { signal }) });
  const sessions = list.data ?? null;

  // Removed from the list at once; put back if the server refuses.
  const removal = useMutation({
    mutationFn: (session: Session) => api(`/api/whatsapp-sessions/${session.id}`, { method: 'DELETE' }),
    onMutate: async (session) => {
      await queryClient.cancelQueries({ queryKey: qk.sessions });
      const previous = queryClient.getQueryData<Session[]>(qk.sessions);
      queryClient.setQueryData<Session[]>(qk.sessions, (all) => all?.filter((x) => x.id !== session.id));
      return { previous };
    },
    onError: (_err, _session, context) => queryClient.setQueryData(qk.sessions, context?.previous),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: qk.sessions });
      void queryClient.invalidateQueries({ queryKey: qk.keys });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
  });
  const remove = (session: Session) => {
    if (confirm(s.confirmDelete(session.name))) removal.mutate(session);
  };

  const unlimited = account ? isUnlimitedPlan(account.plan) : false;
  const limit = account && !unlimited ? account.plan.sessions : null;
  const used = sessions?.length ?? 0;
  const atLimit = limit !== null && used >= limit;
  const visible = sessions?.filter((x) => filter === 'all' || x.status === filter) ?? null;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        title={s.title}
        description={s.description}
        actions={
          <>
            <Button variant="outline" icon={<RefreshCw className={cx('size-4', list.isFetching && 'animate-spin')} />} onClick={() => void list.refetch()}>
              {t.common.refresh}
            </Button>
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)} disabled={atLimit} title={atLimit ? s.limitReached : undefined}>
              {s.new}
            </Button>
          </>
        }
      />

      {account && (
        <div className="animate-fade-up rounded-lg bg-raised/40 p-4" style={delay(80)}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-medium">{s.usage}</p>
              <p className="text-sm text-muted">{limit === null ? s.usageUnlimited(used) : s.usageText(used, limit)}</p>
            </div>
            {atLimit && (
              <Link href="/subscription" className={buttonClass('outline', 'sm')}>
                {s.upgrade}
              </Link>
            )}
          </div>
          {limit !== null && <Progress className="mt-2 h-2 bg-raised" value={limit ? (used / limit) * 100 : 0} />}
        </div>
      )}

      <ErrorNote>{removal.isError ? errorMessage(removal.error) : null}</ErrorNote>
      {list.isError && <LoadError error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}

      {sessions && sessions.length > 0 && (
        <Select<SessionStatus | 'all'>
          value={filter}
          onChange={setFilter}
          className="w-56"
          aria-label={s.filter}
          options={[
            { value: 'all', label: s.allStatuses },
            ...SESSION_STATUSES.map((status) => ({
              value: status,
              label: (
                <span className="flex items-center gap-2">
                  <span className={cx('size-2 shrink-0 rounded-full', TONES[SESSION_STATUS[status].tone].dot)} />
                  {t.status.session[status].label}
                </span>
              ),
            })),
          ]}
        />
      )}

      {visible === null ? (
        !list.isError && (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-48 animate-pulse rounded-xl border border-line bg-raised/30" />
          ))}
        </div>
        )
      ) : sessions!.length === 0 ? (
        <div className="animate-fade-up rounded-xl border border-line">
          <EmptyState
            icon={Smartphone}
            title={s.emptyTitle}
            text={s.emptyText}
            action={
              <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
                {s.emptyCta}
              </Button>
            }
          />
        </div>
      ) : visible.length === 0 ? (
        <p className="animate-fade-in py-12 text-center text-muted">{s.noMatch}</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {visible.map((session, i) => {
            const needsLink = session.status !== 'connected' && session.status !== 'connecting';
            return (
              <article
                key={session.id}
                className="lift animate-fade-up flex flex-col overflow-hidden rounded-xl border border-line bg-card shadow-sm"
                style={delay(120 + i * 70)}
              >
                <Link href={`/sessions/${session.id}`} className="block space-y-1.5 px-6 pt-6 pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="truncate text-lg font-semibold">{session.name}</h3>
                    <SessionStatusBadge status={session.status} />
                  </div>
                  <p className="text-sm text-muted">
                    <Phone value={session.phoneNumber} />
                  </p>
                </Link>
                <dl className="grid flex-1 grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-6 py-4 text-sm">
                  <dt className="text-muted">{s.lastActivity}</dt>
                  <dd>{fmt.timeAgo(session.lastSeenAt ?? session.connectedAt)}</dd>
                  <dt className="text-muted">{s.created}</dt>
                  <dd>{fmt.timeAgo(session.createdAt)}</dd>
                  {session.lastError && (
                    <dd className="col-span-2 truncate text-xs text-red-400" title={session.lastError}>
                      {session.lastError}
                    </dd>
                  )}
                </dl>
                <footer className="flex items-center justify-between gap-2 border-t border-line px-6 py-4">
                  <Link href={`/sessions/${session.id}`} className={buttonClass(needsLink ? 'white' : 'outline', 'sm')}>
                    {needsLink ? <Smartphone className="size-4" /> : <Settings2 className="size-4" />}
                    {needsLink ? s.link : s.manage}
                  </Link>
                  <Button variant="ghost" size="sm" icon={<Trash2 className="size-4" />} onClick={() => remove(session)} className="text-red-400 hover:text-red-300">
                    {t.common.delete}
                  </Button>
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {creating && (
        <CreateSession
          taken={(sessions ?? []).map((x) => x.name)}
          onClose={() => setCreating(false)}
          onCreated={(session) => {
            setCreating(false);
            setCreated(session);
            void queryClient.invalidateQueries({ queryKey: qk.sessions });
            void queryClient.invalidateQueries({ queryKey: ['overview'] });
          }}
        />
      )}
      {created && (
        <KeyReveal
          title={s.keyTitle}
          value={created.apiKey}
          onClose={() => {
            navigate(`/sessions/${created.id}`);
            setCreated(null);
          }}
        />
      )}
    </div>
  );
}

function CreateSession({ taken, onClose, onCreated }: { taken: string[]; onClose: () => void; onCreated: (s: { id: string; apiKey: string }) => void }) {
  const { t } = useI18n();
  const s = t.sessions;
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const refuse = (names: string[]) => {
    setError(s.nameTaken);
    setSuggestions(names);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    // The API enforces the same case-insensitive uniqueness; checking here first gives instant feedback.
    if (taken.some((x) => x.toLowerCase() === trimmed.toLowerCase())) return refuse(suggestNames(trimmed, taken));
    setLoading(true);
    setError(null);
    try {
      onCreated(await api<Session & { apiKey: string }>('/api/whatsapp-sessions', { method: 'POST', body: { name: trimmed } }));
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'name_taken') {
        refuse((err.details?.suggestions as string[] | undefined) ?? suggestNames(trimmed, taken));
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title={s.newTitle} description={s.newText} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={s.nameLabel} value={name} onChange={(e) => setName(e.target.value)} placeholder={s.namePlaceholder} autoFocus required maxLength={100} />
        <ErrorNote>{error}</ErrorNote>
        {suggestions.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted">{s.nameSuggestions}</span>
            {suggestions.map((option) => (
              <button key={option} type="button" onClick={() => (setName(option), setError(null), setSuggestions([]))} className={buttonClass('outline', 'sm')}>
                {option}
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" loading={loading}>
            {s.createSubmit}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
