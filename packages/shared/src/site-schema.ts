import { z } from 'zod';
import { SITE_ADDRESS_MAX, type SiteSettings } from './site';

/** The admin's links and contact details as typed; the route makes the links canonical or rejects them. */
export const siteSettingsSchema: z.ZodType<SiteSettings> = z.object({
  demoVideoUrl: z.string().trim().max(500).nullable(),
  youtubeChannelUrl: z.string().trim().max(500).nullable(),
  address: z.string().trim().max(SITE_ADDRESS_MAX).nullable(),
  addressEn: z.string().trim().max(SITE_ADDRESS_MAX).nullable(),
  phone: z.string().trim().max(40).nullable(),
});
