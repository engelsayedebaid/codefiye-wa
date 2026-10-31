import { DEFAULT_SITE_SETTINGS, type SiteSettings, youtubeVideoId } from '@wa/shared/site';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { useI18n } from '../i18n';
import { qk } from '../queries';

/** The explainer video, YouTube channel and contact details an admin set in /admin → Website (none until they load). */
export function useSiteSettings() {
  const { lang } = useI18n();
  const query = useQuery({
    queryKey: qk.site,
    queryFn: ({ signal }) => api<SiteSettings>('/api/site', { signal }),
    staleTime: 5 * 60_000,
  });
  const site = query.data ?? DEFAULT_SITE_SETTINGS;
  // The English site falls back to the Arabic address (and the other way round), so one is always shown.
  const address = lang === 'en' ? (site.addressEn ?? site.address) : (site.address ?? site.addressEn);
  return { ...site, videoId: youtubeVideoId(site.demoVideoUrl), localAddress: address };
}
