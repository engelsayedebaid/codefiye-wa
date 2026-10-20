import { youtubeWatchUrl } from '@wa/shared/site';
import { ArrowUpRight, CheckCheck, Play } from '../icons';
import { useEffect, useState } from 'react';
import { BRAND } from '../brand';
import { useI18n } from '../i18n';
import { buttonClass, cx, flip, LogoMark, Reveal } from '../ui';
import { DEMO_ICONS } from './content';
import { useSiteSettings } from './settings';
import { SectionHeading, YoutubeIcon } from './SiteChrome';

const PLAY_EVENT = 'wa:play-demo';

/** The hero's "Watch the demo": brings the video into view and starts it. */
export function playDemo() {
  document.getElementById('demo')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  window.dispatchEvent(new Event(PLAY_EVENT));
}

/** Cover drawn in HTML. Nothing is fetched from YouTube until the visitor presses play. */
function Poster({ ready, onPlay }: { ready: boolean; onPlay: () => void }) {
  const { t } = useI18n();
  const d = t.landing.demo;
  const cover = (
    <>
      <span aria-hidden className="absolute inset-0 bg-[radial-gradient(60%_70%_at_50%_42%,rgb(52_211_153/0.24),transparent_70%)]" />
      <span
        aria-hidden
        className="absolute inset-0 [background-image:linear-gradient(to_right,rgb(255_255_255/0.05)_1px,transparent_1px),linear-gradient(to_bottom,rgb(255_255_255/0.05)_1px,transparent_1px)] [background-size:44px_44px] [mask-image:radial-gradient(ellipse_75%_70%_at_50%_45%,#000_30%,transparent_80%)]"
      />

      {/* Two bits of product floating at the sides. */}
      <span aria-hidden className="absolute start-[7%] top-[16%] hidden -rotate-3 rounded-xl border border-white/10 bg-white/[0.06] px-3.5 py-2.5 text-start text-xs shadow-xl backdrop-blur-sm transition-transform duration-500 group-hover:-translate-y-1 md:block">
        <span className="block text-white/55">{t.landing.mock.chats[1]!.name}</span>
        <span className="mt-0.5 block font-medium">{t.landing.mock.chats[1]!.text}</span>
      </span>
      <span aria-hidden className="absolute end-[7%] bottom-[24%] hidden rotate-2 items-center gap-2 rounded-xl border border-white/10 bg-white/[0.06] px-3.5 py-2.5 text-xs font-medium shadow-xl backdrop-blur-sm transition-transform duration-500 group-hover:translate-y-1 md:flex">
        <CheckCheck className="size-4 text-[#53bdeb]" />
        {t.landing.mock.eventText}
      </span>

      <span className="relative flex h-full flex-col items-center justify-center gap-4 px-6 text-center sm:gap-6">
        <span className="flex items-center gap-2 text-sm">
          <LogoMark className="size-6" />
          <span className="ltr font-semibold">{BRAND.name}</span>
        </span>
        {ready ? (
          <span className="play-ring relative isolate flex size-16 items-center justify-center rounded-full bg-white text-[#06231d] shadow-2xl transition-transform duration-300 group-hover:scale-105 group-focus-visible:ring-4 group-focus-visible:ring-white/50 sm:size-20">
            <Play className="size-7 translate-x-0.5 fill-current sm:size-8" />
          </span>
        ) : (
          <span className="flex size-16 items-center justify-center rounded-full border border-white/20 bg-white/10 sm:size-20">
            <Play className="size-7 translate-x-0.5 fill-current opacity-60 sm:size-8" />
          </span>
        )}
        <span>
          <span className="block text-xl font-semibold sm:text-3xl">{d.posterTitle}</span>
          <span className="mt-1.5 block text-sm text-white/70 sm:text-base">{ready ? d.posterText : d.soon}</span>
        </span>
      </span>

      {/* A player bar, for the look of a video. */}
      <span aria-hidden className="absolute inset-x-0 bottom-0 hidden items-center gap-3 bg-gradient-to-t from-black/60 to-transparent px-5 pt-12 pb-4 text-[11px] text-white/70 sm:flex" dir="ltr">
        <Play className="size-3.5 fill-current" />
        <span className="font-mono">0:00</span>
        <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/20">
          <span className="block h-full w-[6%] rounded-full bg-[#34d399]" />
        </span>
        <YoutubeIcon className="size-4" />
      </span>
    </>
  );
  const rootClass = 'group absolute inset-0 block size-full text-white';
  return ready ? (
    <button type="button" onClick={onPlay} aria-label={d.play} className={cx(rootClass, 'cursor-pointer focus-visible:outline-none')}>
      {cover}
    </button>
  ) : (
    <div className={rootClass}>{cover}</div>
  );
}

/**
 * The explainer video. The link is set by an admin (/admin → Website); until then the cover says
 * it's coming. The player is youtube-nocookie and loads only on play.
 */
export function DemoVideo() {
  const { t, lang } = useI18n();
  const d = t.landing.demo;
  const site = useSiteSettings();
  const id = site.videoId;
  const [playing, setPlaying] = useState(false);

  // Another video set while the page is open: back to the cover.
  useEffect(() => setPlaying(false), [id]);

  useEffect(() => {
    if (!id) return;
    const onPlay = () => setPlaying(true);
    window.addEventListener(PLAY_EVENT, onPlay);
    return () => window.removeEventListener(PLAY_EVENT, onPlay);
  }, [id]);

  return (
    <section id="demo" className="band scroll-mt-20 py-20 sm:py-28">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <SectionHeading kicker={d.kicker} title={d.title} accent={d.accent} text={d.text} />

        <Reveal delay={100} className="mx-auto mt-12 max-w-5xl">
          <div className="relative aspect-video overflow-hidden rounded-2xl border border-white/10 bg-[#04110d] shadow-[0_50px_120px_-50px_rgb(0_0_0/0.85)] sm:rounded-3xl light:shadow-[0_50px_100px_-50px_rgb(16_24_20/0.5)]">
            {playing && id ? (
              <iframe
                className="absolute inset-0 size-full"
                src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1&playsinline=1&hl=${lang}`}
                title={d.frameTitle}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                referrerPolicy="strict-origin-when-cross-origin"
                allowFullScreen
              />
            ) : (
              <Poster ready={Boolean(id)} onPlay={() => setPlaying(true)} />
            )}
          </div>
        </Reveal>

        <ul className="mx-auto mt-12 grid max-w-5xl gap-8 sm:grid-cols-3">
          {d.points.map((p, i) => {
            const Icon = DEMO_ICONS[i]!;
            return (
              <li key={p.title}>
                <Reveal delay={i * 80} className="flex gap-3.5">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand ring-1 ring-brand/20">
                    <Icon className={cx('size-5', i === 1 && flip)} />
                  </span>
                  <span>
                    <span className="block font-semibold">{p.title}</span>
                    <span className="mt-1 block text-sm leading-relaxed text-muted">{p.text}</span>
                  </span>
                </Reveal>
              </li>
            );
          })}
        </ul>

        {(site.youtubeChannelUrl || id) && (
          <div className="mt-12 flex flex-wrap items-center justify-center gap-x-6 gap-y-3">
            {site.youtubeChannelUrl && (
              <a href={site.youtubeChannelUrl} target="_blank" rel="noreferrer" className={buttonClass('outline', 'lg', 'rounded-lg')}>
                <YoutubeIcon className="size-5 text-[#ff0033]" />
                {d.youtube}
              </a>
            )}
            {id && (
              <a href={youtubeWatchUrl(id)} target="_blank" rel="noreferrer" className="group inline-flex items-center gap-1.5 text-sm font-medium text-muted transition-colors hover:text-ink">
                {d.openOnYoutube}
                <ArrowUpRight className={cx('size-4', flip)} />
              </a>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
