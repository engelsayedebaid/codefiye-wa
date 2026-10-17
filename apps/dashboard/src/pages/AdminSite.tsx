import { DEFAULT_SITE_SETTINGS, type SiteSettings, youtubeChannelUrl, youtubeVideoId } from '@wa/shared/site';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CirclePlay, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { api, ApiRequestError, errorMessage } from '../api';
import { useI18n } from '../i18n';
import { qk } from '../queries';
import { Button, buttonClass, Card, cx, ErrorNote, Field, SuccessNote } from '../ui';

type Draft = { video: string; channel: string };

/** The landing page's explainer video and YouTube channel (stored in `settings.site`). */
export function SiteSettingsCard() {
  const { t } = useI18n();
  const s = t.admin.site;
  const queryClient = useQueryClient();
  const site = useQuery({ queryKey: qk.site, queryFn: ({ signal }) => api<SiteSettings>('/api/site', { signal }) });
  const saved = site.data ?? DEFAULT_SITE_SETTINGS;
  const [draft, setDraft] = useState<Draft | null>(null);
  const current: Draft = draft ?? { video: saved.demoVideoUrl ?? '', channel: saved.youtubeChannelUrl ?? '' };

  const videoId = youtubeVideoId(current.video);
  const videoBad = current.video.trim() !== '' && !videoId;
  const channelBad = current.channel.trim() !== '' && !youtubeChannelUrl(current.channel);
  const dirty = draft !== null && (draft.video.trim() !== (saved.demoVideoUrl ?? '') || draft.channel.trim() !== (saved.youtubeChannelUrl ?? ''));

  const save = useMutation({
    mutationFn: () =>
      api<SiteSettings>('/api/admin/site', {
        method: 'PUT',
        body: { demoVideoUrl: current.video.trim() || null, youtubeChannelUrl: current.channel.trim() || null },
      }),
    onSuccess: (data) => {
      queryClient.setQueryData(qk.site, data);
      setDraft(null);
    },
  });
  const fieldErrors = save.error instanceof ApiRequestError ? save.error.errors : undefined;

  return (
    <Card title={s.title} description={s.text} className="animate-fade-up">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,20rem)]">
        <form
          className="space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && !videoBad && !channelBad) save.mutate();
          }}
        >
          <Field
            label={s.videoLabel}
            hint={s.videoHint}
            value={current.video}
            onChange={(e) => setDraft({ ...current, video: e.target.value })}
            placeholder="https://www.youtube.com/watch?v=…"
            dir="ltr"
            inputMode="url"
            autoComplete="off"
            maxLength={500}
            error={videoBad ? [s.invalidVideo] : fieldErrors?.demoVideoUrl}
          />
          <Field
            label={s.channelLabel}
            hint={s.channelHint}
            value={current.channel}
            onChange={(e) => setDraft({ ...current, channel: e.target.value })}
            placeholder="https://www.youtube.com/@…"
            dir="ltr"
            inputMode="url"
            autoComplete="off"
            maxLength={500}
            error={channelBad ? [s.invalidChannel] : fieldErrors?.youtubeChannelUrl}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="brand" loading={save.isPending} disabled={!dirty || videoBad || channelBad}>
              {s.save}
            </Button>
            <a href="/#demo" target="_blank" rel="noreferrer" className={buttonClass('ghost', 'md')}>
              {s.view}
              <ExternalLink className="size-3.5" />
            </a>
          </div>
          {save.isSuccess && !dirty && <SuccessNote>{s.saved}</SuccessNote>}
          <ErrorNote>{save.isError && !fieldErrors ? errorMessage(save.error) : null}</ErrorNote>
        </form>

        <div>
          <p className="text-xs font-medium text-muted">{s.preview}</p>
          <div className={cx('mt-2 aspect-video overflow-hidden rounded-xl border border-line', videoId ? 'bg-black' : 'bg-raised/50')}>
            {videoId ? (
              <a href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noreferrer" className="group relative block size-full">
                <img src={`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`} alt="" className="size-full object-cover transition-opacity group-hover:opacity-80" />
                <CirclePlay className="absolute inset-0 m-auto size-12 text-white drop-shadow-lg" />
              </a>
            ) : (
              <p className="flex size-full items-center justify-center p-6 text-center text-sm text-muted">{s.noVideo}</p>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
