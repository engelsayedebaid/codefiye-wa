import { z } from 'zod';
import type { SiteSettings } from './site';

/** The admin's links as typed; the route turns them into canonical YouTube links or rejects them. */
export const siteSettingsSchema: z.ZodType<SiteSettings> = z.object({
  demoVideoUrl: z.string().trim().max(500).nullable(),
  youtubeChannelUrl: z.string().trim().max(500).nullable(),
});
