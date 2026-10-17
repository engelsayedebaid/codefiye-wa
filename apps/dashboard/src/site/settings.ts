import { DEFAULT_SITE_SETTINGS, type SiteSettings, youtubeVideoId } from '@wa/shared/site';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { qk } from '../queries';

/** The explainer video and YouTube channel an admin set in /admin → Website (none until they load). */
export function useSiteSettings() {
  const query = useQuery({
    queryKey: qk.site,
    queryFn: ({ signal }) => api<SiteSettings>('/api/site', { signal }),
    staleTime: 5 * 60_000,
  });
  const site = query.data ?? DEFAULT_SITE_SETTINGS;
  return { ...site, videoId: youtubeVideoId(site.demoVideoUrl) };
}
