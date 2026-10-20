import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from '../../icons';
import { useEffect, useState } from 'react';
import { useLiveStatus } from '../../events';
import { useI18n } from '../../i18n';
import { qk } from '../../queries';

/**
 * Says so when live updates stop (the event stream is reconnecting, e.g. during a deploy): the page
 * still works, but new messages won't appear on their own until it's back. Waits a few seconds first,
 * so a quick reconnect shows nothing; when the browser is offline, the app-wide banner says it already.
 */
export function LiveBanner() {
  const { t } = useI18n();
  const l = t.chats.live;
  const queryClient = useQueryClient();
  const status = useLiveStatus();
  const [show, setShow] = useState(false);

  useEffect(() => {
    if (status !== 'reconnecting' && status !== 'connecting') return setShow(false);
    const timer = setTimeout(() => setShow(true), status === 'connecting' ? 10_000 : 4_000);
    return () => clearTimeout(timer);
  }, [status]);

  if (!show || !navigator.onLine) return null;
  return (
    <div role="status" className="animate-fade-in pointer-events-none absolute inset-x-0 top-2 z-[45] flex justify-center px-4">
      <span className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full border border-warning/30 bg-card/95 py-1.5 ps-3 pe-1.5 text-xs text-warning shadow-lg backdrop-blur">
        <RefreshCw className="size-3.5 shrink-0 animate-spin [animation-duration:2s]" />
        <span className="min-w-0 truncate">{l.paused}</span>
        <button
          type="button"
          onClick={() => void queryClient.invalidateQueries({ queryKey: qk.chats.all })}
          className="shrink-0 rounded-full bg-warning/15 px-2.5 py-0.5 font-semibold transition-colors hover:bg-warning/25"
        >
          {l.refresh}
        </button>
      </span>
    </div>
  );
}
