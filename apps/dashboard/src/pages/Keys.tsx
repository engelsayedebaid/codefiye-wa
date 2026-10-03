import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { api, errorMessage } from '../api';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import type { ApiKey, Session } from '../types';
import { Badge, Button, Card, delay, EmptyState, ErrorNote, Field, KeyReveal, Loading, LoadError, Modal, PageHeader } from '../ui';

export function KeysPage() {
  const { t, fmt } = useI18n();
  const k = t.keys;
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  const keys = useQuery({ queryKey: qk.keys, queryFn: ({ signal }) => api<ApiKey[]>('/api/api-keys', { signal }) });
  // Shared with the sessions page: names for session keys.
  const sessions = useQuery({ queryKey: qk.sessions, queryFn: ({ signal }) => api<Session[]>('/api/whatsapp-sessions', { signal }) });
  const sessionNames = useMemo(() => new Map(sessions.data?.map((x) => [x.id, x.name])), [sessions.data]);

  // Gone from the list at once; back if the server refuses.
  const revoke = useMutation({
    mutationFn: (key: ApiKey) => api(`/api/api-keys/${key.id}`, { method: 'DELETE' }),
    onMutate: async (key) => {
      await queryClient.cancelQueries({ queryKey: qk.keys });
      const previous = queryClient.getQueryData<ApiKey[]>(qk.keys);
      queryClient.setQueryData<ApiKey[]>(qk.keys, (list) => list?.filter((x) => x.id !== key.id));
      return { previous };
    },
    onError: (_err, _key, context) => queryClient.setQueryData(qk.keys, context?.previous),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: qk.keys }),
  });

  const th = 'h-10 px-2 text-start font-medium whitespace-nowrap text-muted';
  const td = 'p-2 whitespace-nowrap';
  const list = keys.data;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6">
      <PageHeader
        title={k.title}
        description={
          <>
            {k.descWorkspace} (<code className="ltr font-mono">wap_</code>) {k.descWorkspaceText} {k.descSession} (<code className="ltr font-mono">was_</code>){' '}
            {k.descSessionText}
          </>
        }
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
            {k.new}
          </Button>
        }
      />

      <ErrorNote>{revoke.isError ? errorMessage(revoke.error) : null}</ErrorNote>

      <Card bodyClassName="px-4" className="animate-fade-up" style={delay(80)}>
        {keys.isError && <LoadError error={keys.error} onRetry={() => void keys.refetch()} retrying={keys.isFetching} className={list ? 'mb-4' : undefined} />}
        {!list ? (
          !keys.isError && <Loading />
        ) : list.length === 0 ? (
          <EmptyState icon={KeyRound} title={k.empty} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className={th}>{k.cols.name}</th>
                  <th className={th}>{k.cols.key}</th>
                  <th className={th}>{k.cols.type}</th>
                  <th className={th}>{k.cols.lastUsed}</th>
                  <th className={th}>{k.cols.created}</th>
                  <th />
                </tr>
              </thead>
              <tbody className="[&_tr]:border-b [&_tr]:border-line [&_tr:last-child]:border-0">
                {list.map((key, i) => (
                  <tr key={key.id} className="animate-fade-up transition-colors hover:bg-raised/30" style={delay(120 + i * 40)}>
                    <td className={`${td} font-medium`}>{key.name}</td>
                    <td className={td}>
                      <code className="ltr font-mono text-muted">{key.prefix}…</code>
                    </td>
                    <td className={td}>
                      {key.kind === 'pat' ? <Badge tone="info">{k.workspace}</Badge> : <Badge tone="neutral">{k.session(sessionNames.get(key.sessionId!) ?? '—')}</Badge>}
                    </td>
                    <td className={td}>{fmt.timeAgo(key.lastUsedAt)}</td>
                    <td className={td}>{fmt.timeAgo(key.createdAt)}</td>
                    <td className={`${td} text-end`}>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Trash2 className="size-4" />}
                        onClick={() => confirm(k.confirmRevoke(key.name, key.prefix)) && revoke.mutate(key)}
                        className="text-red-400 hover:text-red-300"
                      >
                        {k.revoke}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {creating && (
        <CreateToken
          onClose={() => setCreating(false)}
          onCreated={(key) => {
            setCreating(false);
            setRevealed(key);
            void queryClient.invalidateQueries({ queryKey: qk.keys });
          }}
        />
      )}
      {revealed && <KeyReveal title={k.revealTitle} value={revealed} onClose={() => setRevealed(null)} />}
    </div>
  );
}

function CreateToken({ onClose, onCreated }: { onClose: () => void; onCreated: (key: string) => void }) {
  const { t } = useI18n();
  const k = t.keys;
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api<{ key: string }>('/api/api-keys', { method: 'POST', body: { name } }),
    onSuccess: ({ key }) => onCreated(key),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!create.isPending) create.mutate();
  };

  return (
    <Modal title={k.newTitle} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={k.nameLabel} value={name} onChange={(e) => setName(e.target.value)} placeholder={k.namePlaceholder} autoFocus required maxLength={100} />
        <ErrorNote>{create.isError ? errorMessage(create.error) : null}</ErrorNote>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button type="submit" loading={create.isPending}>
            {k.create}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
