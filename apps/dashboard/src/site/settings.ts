import { DEFAULT_SITE_SETTINGS, type SiteSettings, youtubeVideoId } from '@wa/shared/site';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { BRAND } from '../brand';
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
  const loaded = query.data ?? DEFAULT_SITE_SETTINGS;
  // Phone and address are never missing from the site: BRAND's details stand in for unset ones.
  const site = { ...loaded, phone: loaded.phone ?? BRAND.phone };
  // The English site falls back to the Arabic address (and the other way round), so one is always shown.
  const address = lang === 'en' ? (site.addressEn ?? site.address ?? BRAND.address.en) : (site.address ?? site.addressEn ?? BRAND.address.ar);
  return { ...site, videoId: youtubeVideoId(site.demoVideoUrl), localAddress: address };
}
