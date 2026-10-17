/**
 * Public-website settings an admin edits in /admin → Website, stored in `settings` under `site`.
 * Zod-free so the dashboard can import it; the request schema is in `site-schema.ts`.
 */
export type SiteSettings = {
  /** The explainer video on the landing page, as a canonical YouTube watch link. Null = not set yet. */
  demoVideoUrl: string | null;
  /** The company's YouTube channel (or a playlist), linked under the video and in the footer. */
  youtubeChannelUrl: string | null;
};

export const DEFAULT_SITE_SETTINGS: SiteSettings = { demoVideoUrl: null, youtubeChannelUrl: null };

const CHANNEL_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const VIDEO_HOSTS = new Set([...CHANNEL_HOSTS, 'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com']);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** People paste links without the scheme ("youtu.be/…"); anything that isn't http(s) is refused. */
function parseLink(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

/** The 11-character id in a YouTube video link (watch, youtu.be, shorts, embed, live), or null. */
export function youtubeVideoId(input: string | null | undefined): string | null {
  if (!input) return null;
  const url = parseLink(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  const [, first, second] = url.pathname.split('/');
  let id: string | null | undefined = null;
  if (host === 'youtu.be' || host === 'www.youtu.be') id = first;
  else if (VIDEO_HOSTS.has(host)) {
    if (first === 'watch') id = url.searchParams.get('v');
    else if (first === 'shorts' || first === 'embed' || first === 'live' || first === 'v') id = second;
  }
  return id && VIDEO_ID.test(id) ? id : null;
}

/** A link to a YouTube channel, handle or playlist, as an https://www.youtube.com URL; a bare "@handle" works too. */
export function youtubeChannelUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (/^@[\w.-]{3,100}$/.test(trimmed)) return `https://www.youtube.com/${trimmed}`;
  const url = parseLink(trimmed);
  if (!url || !CHANNEL_HOSTS.has(url.hostname.toLowerCase())) return null;
  const path = url.pathname.replace(/\/+$/, '');
  if (!path) return null;
  return `https://www.youtube.com${path}${url.search}`;
}

export const youtubeWatchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

/** What the landing page reads: links that aren't YouTube are dropped, video links are made canonical. */
export function normalizeSiteSettings(raw: unknown): SiteSettings {
  const src = raw && typeof raw === 'object' ? (raw as Partial<Record<keyof SiteSettings, unknown>>) : {};
  const videoId = typeof src.demoVideoUrl === 'string' ? youtubeVideoId(src.demoVideoUrl) : null;
  return {
    demoVideoUrl: videoId ? youtubeWatchUrl(videoId) : null,
    youtubeChannelUrl: typeof src.youtubeChannelUrl === 'string' ? youtubeChannelUrl(src.youtubeChannelUrl) : null,
  };
}
