import { ok, successSchema } from '@wa/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps';
import { requireAdmin } from '../lib/auth';
import { ApiError } from '../lib/errors';

/**
 * The ad library of /ads (admins): ads running on the platforms, shown in the page, for ideas.
 *
 * Sources, each switched on by its key in the environment:
 * - Facebook & Instagram: Apify's Facebook Ads Scraper (APIFY_TOKEN) — any country, with images and
 *   videos; else Meta's own Ad Library API (META_ADLIB_TOKEN) — EU/UK ads only.
 * - Google & YouTube: SerpApi's Google Ads Transparency Center API (SERPAPI_KEY) — any country.
 * Both providers bill per search, so every search is kept a day in `ad_library_cache` and each Apify
 * run has a spending cap. Ordinary ads carry no spend, so each gets a strength score from what is
 * known (how long it has run, how many versions, how widely).
 */

const schemaBase = { tags: ['Admin'], hide: true };
const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION?.trim() || 'v26.0'}`;
const APIFY = 'https://api.apify.com/v2';
const APIFY_ACTOR = 'apify~facebook-ads-scraper';
/**
 * Ads per search, by size: a normal search, and "show more" (a new, bigger run — the actor has no paging).
 * Apify bills per ad (≈ $0.006 each on the free plan), so each run is capped just above its size.
 */
const SIZES = { normal: { apify: 50, serp: 40 }, more: { apify: 150, serp: 100 } } as const;
type Size = keyof typeof SIZES;
const USD_PER_AD = 0.0065;
const CACHE_HOURS = 24;
/** A failed search is not retried for a few minutes; a run that never finishes is given up. */
const RETRY_FAILED_MS = 5 * 60_000;
const RUN_GIVE_UP_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

export const LIBRARY_PLATFORMS = ['all', 'facebook', 'instagram', 'google', 'youtube', 'tiktok', 'snapchat', 'linkedin', 'x'] as const;
type Platform = Exclude<(typeof LIBRARY_PLATFORMS)[number], 'all'>;
export const LIBRARY_CATEGORIES = ['all', 'food', 'fashion', 'beauty', 'realestate', 'education', 'apps', 'electronics'] as const;
type Category = Exclude<(typeof LIBRARY_CATEGORIES)[number], 'all'>;

/** Meta's own API returns every ad only for these (EU, EEA, UK); elsewhere political ads only. */
const EU_COUNTRIES = ['DE', 'FR', 'NL', 'BE', 'IT', 'ES', 'SE', 'AT', 'IE', 'DK', 'PL', 'GB'] as const;
const ARAB_COUNTRIES = ['EG', 'SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'JO', 'IQ', 'LB', 'MA', 'DZ', 'TN', 'LY'] as const;
export const LIBRARY_COUNTRIES = [...ARAB_COUNTRIES, 'TR', 'US', ...EU_COUNTRIES] as const;
type Country = (typeof LIBRARY_COUNTRIES)[number];
/** SerpApi takes Google's location ids: 2000 + the ISO 3166 numeric code. */
const ISO_NUMERIC: Record<Country, number> = {
  EG: 818, SA: 682, AE: 784, KW: 414, QA: 634, BH: 48, OM: 512, JO: 400, IQ: 368, LB: 422, MA: 504, DZ: 12, TN: 788, LY: 434,
  TR: 792, US: 840, DE: 276, FR: 250, NL: 528, BE: 56, IT: 380, ES: 724, SE: 752, AT: 40, IE: 372, DK: 208, PL: 616, GB: 826,
};

/** What a category searches for when no words are typed (Arabic in Arab countries); its ads are filed under it. */
const CATEGORY_WORDS: Record<Category, { ar: string; en: string }> = {
  food: { ar: 'مطعم', en: 'restaurant' },
  fashion: { ar: 'ملابس', en: 'fashion' },
  beauty: { ar: 'عيادة', en: 'skin care' },
  realestate: { ar: 'شقق', en: 'apartments' },
  education: { ar: 'كورس', en: 'course' },
  apps: { ar: 'تطبيق', en: 'app' },
  electronics: { ar: 'موبايل', en: 'headphones' },
};

/**
 * A link the page puts in an href or src: web addresses only. A saved ad comes back from the browser, so
 * a `javascript:` or `data:` value must never be stored (it would run when the ad is opened).
 */
const webUrl = z
  .string()
  .max(2000)
  .refine((u) => /^https?:\/\/[^\s]+$/i.test(u), { message: 'Must be an http(s) link' });
const shortText = (max: number) => z.string().max(max);

const adDto = z.object({
  id: shortText(200),
  platform: z.enum(LIBRARY_PLATFORMS.filter((p) => p !== 'all') as [Platform, ...Platform[]]),
  placements: z.array(shortText(40)).max(10),
  externalId: shortText(200),
  advertiser: shortText(300),
  advertiserId: shortText(200).nullable(),
  text: shortText(5000).nullable(),
  title: shortText(1000).nullable(),
  description: shortText(2000).nullable(),
  domain: shortText(300).nullable(),
  startedAt: shortText(40).nullable(),
  stoppedAt: shortText(40).nullable(),
  active: z.boolean(),
  days: z.number().int().min(0).max(100_000),
  variants: z.number().int().min(0).max(100_000),
  countries: z.array(shortText(80)).max(300),
  languages: z.array(shortText(20)).max(50),
  reach: z.number().nullable(),
  category: shortText(40).nullable(),
  score: z.number().min(0).max(100),
  url: webUrl,
  /** The creative, when the source gives it: a picture (or a video's still) and the video itself. */
  image: webUrl.optional(),
  video: webUrl.optional(),
  format: shortText(40).optional(),
  /** The advertiser's picture. */
  avatar: webUrl.optional(),
  /** Added by hand to the ideas board (a link pasted from a platform's own library), with a note. */
  manual: z.boolean().optional(),
  note: shortText(2000).optional(),
  handle: shortText(100).optional(),
  cta: shortText(60).optional(),
});
export type LibraryAd = z.infer<typeof adDto>;

type SearchParams = { q: string; platform: Platform | 'all'; category: Category | null; country: Country; active: boolean; size: Size };
type SourceResult = { ads: LibraryAd[]; pending?: boolean; error?: string };

/** 0–100 from what is known: run length (most), versions in testing, and spread. */
function strength(days: number, variants: number, spread: number) {
  const run = (Math.min(days, 180) / 180) * 60;
  const tests = (Math.min(Math.max(variants - 1, 0), 9) / 9) * 25;
  const wide = (Math.min(Math.max(spread - 1, 0), 3) / 3) * 15;
  return Math.round(run + tests + wide);
}
const first = (list?: (string | null | undefined)[]) => list?.find((s) => s?.trim())?.trim() ?? null;
const hostOf = (url: string | null | undefined) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : null;
  } catch {
    return null;
  }
};
const daysBetween = (start: number, end: number) => Math.max(1, Math.round((end - start) / DAY_MS));
/** The words a search sends: what was typed, else the category's word in the country's language. */
const wordsFor = (p: SearchParams) =>
  p.q || (p.category ? CATEGORY_WORDS[p.category][(ARAB_COUNTRIES as readonly string[]).includes(p.country) ? 'ar' : 'en'] : (ARAB_COUNTRIES as readonly string[]).includes(p.country) ? 'عرض' : 'offer');

// --- Apify: Meta's Ad Library, any country ------------------------------------------------------

type ApifyAd = {
  adArchiveID?: string | number;
  pageID?: string | number;
  pageName?: string;
  isActive?: boolean;
  startDate?: number;
  endDate?: number;
  publisherPlatform?: string[];
  collationCount?: number;
  reachEstimate?: number | null;
  snapshot?: {
    body?: { text?: string } | null;
    title?: string | null;
    caption?: string | null;
    linkDescription?: string | null;
    ctaText?: string | null;
    linkUrl?: string | null;
    displayFormat?: string | null;
    pageName?: string | null;
    pageProfilePictureUrl?: string | null;
    images?: { originalImageUrl?: string; resizedImageUrl?: string }[];
    videos?: { videoHdUrl?: string; videoSdUrl?: string; videoPreviewImageUrl?: string }[];
    cards?: { body?: string; title?: string; originalImageUrl?: string; resizedImageUrl?: string; videoPreviewImageUrl?: string; videoSdUrl?: string }[];
  };
};

/** The ad text without dynamic-catalog placeholders (`{{product.name}}`), which mean nothing on their own. */
const realText = (text?: string | null) => (text && !/\{\{[^}]+\}\}/.test(text) ? text.trim() : null);

function fromApify(items: ApifyAd[], p: SearchParams): LibraryAd[] {
  const now = Date.now();
  return items.flatMap((item) => {
    if (!item.adArchiveID) return [];
    const s = item.snapshot ?? {};
    const card = s.cards?.[0];
    const placements = (item.publisherPlatform ?? []).map((x) => x.toLowerCase());
    const platform: Platform = p.platform === 'instagram' || (!placements.includes('facebook') && placements.includes('instagram')) ? 'instagram' : 'facebook';
    const start = item.startDate ? item.startDate * 1000 : NaN;
    const end = item.endDate ? item.endDate * 1000 : NaN;
    const active = item.isActive ?? (Number.isNaN(end) || end > now);
    const days = Number.isNaN(start) ? 0 : daysBetween(start, active || Number.isNaN(end) ? now : end);
    const text = realText(s.body?.text) ?? realText(card?.body);
    const title = realText(s.title) ?? realText(card?.title);
    const video = s.videos?.[0];
    const image = video?.videoPreviewImageUrl ?? s.images?.[0]?.originalImageUrl ?? s.images?.[0]?.resizedImageUrl ?? card?.originalImageUrl ?? card?.resizedImageUrl ?? card?.videoPreviewImageUrl;
    const variants = Math.max(1, item.collationCount ?? 1);
    const id = String(item.adArchiveID);
    return [
      {
        id: `meta:${id}`,
        platform,
        placements,
        externalId: id,
        advertiser: item.pageName ?? s.pageName ?? '—',
        advertiserId: item.pageID ? String(item.pageID) : null,
        text,
        title,
        description: realText(s.linkDescription),
        domain: hostOf(s.linkUrl) ?? s.caption ?? null,
        startedAt: Number.isNaN(start) ? null : new Date(start).toISOString(),
        stoppedAt: active || Number.isNaN(end) ? null : new Date(end).toISOString(),
        active,
        days,
        variants,
        countries: [p.country],
        languages: [],
        reach: typeof item.reachEstimate === 'number' ? item.reachEstimate : null,
        category: p.category,
        score: strength(days, variants, Math.max(placements.length, 1)),
        url: `https://www.facebook.com/ads/library/?id=${encodeURIComponent(id)}`,
        ...(image ? { image } : {}),
        ...(video?.videoSdUrl || video?.videoHdUrl || card?.videoSdUrl ? { video: video?.videoSdUrl ?? video?.videoHdUrl ?? card?.videoSdUrl } : {}),
        ...(s.displayFormat ? { format: s.displayFormat.toLowerCase() } : {}),
        ...(s.pageProfilePictureUrl ? { avatar: s.pageProfilePictureUrl } : {}),
        ...(s.ctaText ? { cta: s.ctaText.slice(0, 60) } : {}),
      },
    ];
  });
}

// --- SerpApi: Google Ads Transparency Center ----------------------------------------------------

type SerpCreative = {
  advertiser_id?: string;
  advertiser?: string;
  ad_creative_id?: string;
  format?: string;
  link?: string;
  image?: string;
  total_days_shown?: number;
  first_shown?: number;
  last_shown?: number;
  details_link?: string;
};

function fromSerp(items: SerpCreative[], p: SearchParams, platform: 'google' | 'youtube'): LibraryAd[] {
  const now = Date.now();
  return items.flatMap((c) => {
    if (!c.ad_creative_id) return [];
    const firstShown = c.first_shown ? c.first_shown * 1000 : NaN;
    const lastShown = c.last_shown ? c.last_shown * 1000 : NaN;
    const active = Number.isNaN(lastShown) || now - lastShown < 2 * DAY_MS;
    const days = c.total_days_shown ?? (Number.isNaN(firstShown) ? 0 : daysBetween(firstShown, Number.isNaN(lastShown) ? now : lastShown));
    const picture = c.image ?? (c.link && /\.(png|jpe?g|gif|webp)(\?|$)|simgad|googleusercontent|ytimg/i.test(c.link) ? c.link : undefined);
    return [
      {
        id: `google:${c.ad_creative_id}`,
        platform: c.format === 'video' && platform === 'google' ? ('youtube' as const) : platform,
        placements: [platform],
        externalId: c.ad_creative_id,
        advertiser: c.advertiser ?? '—',
        advertiserId: c.advertiser_id ?? null,
        text: null,
        title: null,
        description: null,
        domain: null,
        startedAt: Number.isNaN(firstShown) ? null : new Date(firstShown).toISOString(),
        stoppedAt: active || Number.isNaN(lastShown) ? null : new Date(lastShown).toISOString(),
        active,
        days,
        variants: 1,
        countries: [p.country],
        languages: [],
        reach: null,
        category: p.category,
        score: strength(days, 1, 1),
        url: c.details_link ?? `https://adstransparency.google.com/advertiser/${c.advertiser_id ?? ''}/creative/${c.ad_creative_id}`,
        ...(picture ? { image: picture } : {}),
        ...(c.format ? { format: c.format } : {}),
      },
    ];
  });
}

// --- Meta's own Ad Library API (EU/UK ads, once the account is approved) ---------------------------

type MetaAd = {
  id: string;
  page_id?: string;
  page_name?: string;
  ad_creative_bodies?: string[];
  ad_creative_link_titles?: string[];
  ad_creative_link_descriptions?: string[];
  ad_creative_link_captions?: string[];
  ad_delivery_start_time?: string;
  ad_delivery_stop_time?: string;
  publisher_platforms?: string[];
  languages?: string[];
  eu_total_reach?: number;
  target_locations?: { name?: string; excluded?: boolean }[];
};

function fromMeta(rows: MetaAd[], p: SearchParams): LibraryAd[] {
  const groups = new Map<string, { ad: MetaAd; count: number }>();
  for (const row of rows) {
    const body = first(row.ad_creative_bodies) ?? first(row.ad_creative_link_titles) ?? row.id;
    const key = `${row.page_id ?? row.page_name}\n${body.slice(0, 160).toLowerCase()}`;
    const known = groups.get(key);
    if (known) known.count += 1;
    else groups.set(key, { ad: row, count: 1 });
  }
  const now = Date.now();
  return [...groups.values()].map(({ ad, count }) => {
    const placements = (ad.publisher_platforms ?? []).map((x) => x.toLowerCase());
    const platform: Platform = p.platform === 'instagram' || (!placements.includes('facebook') && placements.includes('instagram')) ? 'instagram' : 'facebook';
    const start = ad.ad_delivery_start_time ? Date.parse(ad.ad_delivery_start_time) : NaN;
    const stop = ad.ad_delivery_stop_time ? Date.parse(ad.ad_delivery_stop_time) : NaN;
    const active = Number.isNaN(stop) || stop > now;
    const days = Number.isNaN(start) ? 0 : daysBetween(start, active ? now : stop);
    const countries = (ad.target_locations ?? []).filter((l) => !l.excluded && l.name).map((l) => l.name!);
    const text = first(ad.ad_creative_bodies);
    const title = first(ad.ad_creative_link_titles);
    return {
      id: `meta:${ad.id}`,
      platform,
      placements,
      externalId: ad.id,
      advertiser: ad.page_name ?? '—',
      advertiserId: ad.page_id ?? null,
      text,
      title,
      description: first(ad.ad_creative_link_descriptions),
      domain: first(ad.ad_creative_link_captions),
      startedAt: Number.isNaN(start) ? null : new Date(start).toISOString(),
      stoppedAt: active || Number.isNaN(stop) ? null : new Date(stop).toISOString(),
      active,
      days,
      variants: count,
      countries: countries.length ? countries : [p.country],
      languages: ad.languages ?? [],
      reach: typeof ad.eu_total_reach === 'number' ? ad.eu_total_reach : null,
      category: p.category,
      score: strength(days, count, Math.max(placements.length, countries.length)),
      url: `https://www.facebook.com/ads/library/?id=${encodeURIComponent(ad.id)}`,
    };
  });
}

// --- the routes ----------------------------------------------------------------------------------

type CacheRow = { status: 'running' | 'ready' | 'failed'; run_id: string | null; ads: LibraryAd[]; error: string | null; fetched_at: Date };

export function adLibraryRoutes(deps: Deps): FastifyPluginAsyncZod {
  const { sql } = deps;
  const env = (name: string) => process.env[name]?.trim() || null;
  const keys = () => ({ apify: env('APIFY_TOKEN'), serp: env('SERPAPI_KEY'), meta: env('META_ADLIB_TOKEN') });

  const cached = async (key: string) => {
    const [row] = await sql<CacheRow[]>`select status, run_id, ads, error, fetched_at from ad_library_cache where key = ${key}`;
    return row ?? null;
  };
  const store = (key: string, provider: string, status: CacheRow['status'], ads: LibraryAd[], error: string | null, runId: string | null = null) =>
    sql`
      insert into ad_library_cache (key, provider, status, run_id, ads, error, fetched_at)
      values (${key}, ${provider}, ${status}, ${runId}, ${sql.json(ads as never)}, ${error}, now())
      on conflict (key) do update set status = excluded.status, run_id = excluded.run_id, ads = excluded.ads, error = excluded.error, fetched_at = excluded.fetched_at`;
  const fresh = (row: CacheRow) => Date.now() - row.fetched_at.getTime() < CACHE_HOURS * 3_600_000;

  /** Facebook/Instagram through Apify: a run starts on the first search, and its results land on a later poll. */
  async function apifySearch(token: string, p: SearchParams, log: FastifyBaseLogger): Promise<SourceResult> {
    const words = wordsFor(p);
    const key = `apify:${JSON.stringify([words, p.country, p.platform === 'instagram', p.active, ...(p.size === 'more' ? ['more'] : [])])}`;
    const row = await cached(key);
    if (row?.status === 'ready' && fresh(row)) return { ads: row.ads };
    if (row?.status === 'failed' && Date.now() - row.fetched_at.getTime() < RETRY_FAILED_MS) return { ads: [], error: row.error ?? 'failed' };
    if (row?.status === 'running' && row.run_id && Date.now() - row.fetched_at.getTime() < RUN_GIVE_UP_MS) {
      const res = await fetch(`${APIFY}/actor-runs/${row.run_id}?token=${token}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null);
      const run = (await res?.json().catch(() => null)) as { data?: { status?: string; defaultDatasetId?: string } } | null;
      const status = run?.data?.status;
      if (status === 'SUCCEEDED' && run?.data?.defaultDatasetId) {
        const items = await fetch(`${APIFY}/datasets/${run.data.defaultDatasetId}/items?clean=true&format=json&token=${token}`, { signal: AbortSignal.timeout(20_000) })
          .then((r) => r.json() as Promise<ApifyAd[]>)
          .catch(() => null);
        if (!items) return { ads: [], pending: true };
        const ads = fromApify(items, p);
        await store(key, 'apify', 'ready', ads, null, row.run_id);
        return { ads };
      }
      if (status && ['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) {
        await store(key, 'apify', 'failed', [], `Apify run ${status.toLowerCase()}`);
        return { ads: [], error: `Apify run ${status.toLowerCase()}` };
      }
      return { ads: [], pending: true };
    }
    // Claim the search before paying for it, so two tabs asking at once start one run.
    const [claimed] = await sql<{ key: string }[]>`
      insert into ad_library_cache (key, provider, status, fetched_at) values (${key}, 'apify', 'running', now())
      on conflict (key) do update set status = 'running', run_id = null, error = null, fetched_at = now()
        where ad_library_cache.fetched_at < now() - interval '30 seconds' or ad_library_cache.status <> 'running'
      returning key`;
    if (!claimed) return { ads: [], pending: true };
    const libraryUrl = new URL('https://www.facebook.com/ads/library/');
    for (const [k, v] of Object.entries({ active_status: p.active ? 'active' : 'all', ad_type: 'all', country: p.country, media_type: 'all', search_type: 'keyword_unordered', q: words }))
      libraryUrl.searchParams.set(k, v);
    if (p.platform === 'instagram') libraryUrl.searchParams.set('publisher_platforms[0]', 'instagram');
    try {
      const limit = SIZES[p.size].apify;
      const res = await fetch(`${APIFY}/acts/${APIFY_ACTOR}/runs?token=${token}&maxTotalChargeUsd=${(limit * USD_PER_AD).toFixed(2)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startUrls: [{ url: libraryUrl.toString() }], resultsLimit: limit }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await res.json().catch(() => null)) as { data?: { id?: string }; error?: { message?: string; type?: string } } | null;
      if (!res.ok || !body?.data?.id) {
        const message = body?.error?.message ?? `Apify error (${res.status})`;
        await store(key, 'apify', 'failed', [], message);
        return { ads: [], error: message };
      }
      await sql`update ad_library_cache set run_id = ${body.data.id} where key = ${key}`;
      return { ads: [], pending: true };
    } catch (err) {
      log.warn({ err }, 'apify run could not start');
      await store(key, 'apify', 'failed', [], 'Apify did not answer');
      return { ads: [], error: 'Apify did not answer' };
    }
  }

  /** Google/YouTube through SerpApi: one quick call, kept a day. */
  async function serpSearch(apiKey: string, p: SearchParams, platform: 'google' | 'youtube'): Promise<SourceResult> {
    const words = wordsFor(p);
    const key = `serp:${JSON.stringify([words, p.country, platform, ...(p.size === 'more' ? ['more'] : [])])}`;
    const row = await cached(key);
    if (row?.status === 'ready' && fresh(row)) return { ads: row.ads };
    if (row?.status === 'failed' && Date.now() - row.fetched_at.getTime() < RETRY_FAILED_MS) return { ads: [], error: row.error ?? 'failed' };
    const query = new URLSearchParams({ engine: 'google_ads_transparency_center', text: words, region: String(2000 + ISO_NUMERIC[p.country]), num: String(SIZES[p.size].serp), api_key: apiKey });
    if (platform === 'youtube') query.set('platform', 'YOUTUBE');
    try {
      const res = await fetch(`https://serpapi.com/search.json?${query}`, { signal: AbortSignal.timeout(30_000) });
      const body = (await res.json().catch(() => null)) as { ad_creatives?: SerpCreative[]; error?: string } | null;
      // "no results" is an answer, not a failure.
      if (body?.error && !/hasn't returned any results|no results/i.test(body.error)) {
        await store(key, 'serpapi', 'failed', [], body.error);
        return { ads: [], error: body.error };
      }
      const ads = fromSerp(body?.ad_creatives ?? [], p, platform);
      await store(key, 'serpapi', 'ready', ads, null);
      return { ads };
    } catch {
      return { ads: [], error: 'SerpApi did not answer' };
    }
  }

  /** Meta's own API: EU/UK ads only, and only once the account is approved. */
  async function metaSearch(token: string, p: SearchParams): Promise<SourceResult> {
    const query = new URLSearchParams({
      access_token: token,
      search_terms: wordsFor(p),
      search_type: 'KEYWORD_UNORDERED',
      ad_type: 'ALL',
      ad_active_status: p.active ? 'ACTIVE' : 'ALL',
      ad_reached_countries: JSON.stringify([p.country]),
      fields:
        'id,page_id,page_name,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_descriptions,ad_creative_link_captions,ad_delivery_start_time,ad_delivery_stop_time,publisher_platforms,languages,eu_total_reach,target_locations',
      limit: '60',
    });
    if (p.platform === 'facebook' || p.platform === 'instagram') query.set('publisher_platforms', JSON.stringify([p.platform.toUpperCase()]));
    const res = await fetch(`${GRAPH}/ads_archive?${query}`, { signal: AbortSignal.timeout(25_000) }).catch(() => null);
    const body = (await res?.json().catch(() => null)) as { data?: MetaAd[]; error?: { message?: string; code?: number } } | null;
    if (!res?.ok || !body?.data) {
      const code = body?.error?.code;
      return { ads: [], error: code === 190 ? 'library_token_expired' : code === 10 || code === 200 ? 'library_not_allowed' : (body?.error?.message ?? 'Meta Ad Library error') };
    }
    return { ads: fromMeta(body.data, p) };
  }

  return async (app) => {
    app.addHook('onRequest', async (req) => requireAdmin(req));

    app.get(
      '/library/status',
      {
        schema: {
          ...schemaBase,
          summary: 'Which ad-library sources are connected',
          response: { 200: successSchema(z.object({ sources: z.record(z.string(), z.boolean()), countries: z.array(z.string()), providers: z.record(z.string(), z.boolean()) })) },
        },
      },
      async () => {
        const k = keys();
        const meta = Boolean(k.apify || k.meta);
        return ok({
          sources: { facebook: meta, instagram: meta, google: Boolean(k.serp), youtube: Boolean(k.serp), tiktok: false, snapchat: false, linkedin: false, x: false },
          countries: k.apify || k.serp ? [...LIBRARY_COUNTRIES] : [...EU_COUNTRIES],
          providers: { apify: Boolean(k.apify), serpapi: Boolean(k.serp), meta: Boolean(k.meta) },
        });
      },
    );

    app.get(
      '/library',
      {
        schema: {
          ...schemaBase,
          summary: 'Search the ad library',
          querystring: z.object({
            q: z.string().trim().max(100).default(''),
            platform: z.enum(LIBRARY_PLATFORMS).default('all'),
            category: z.enum(LIBRARY_CATEGORIES).default('all'),
            country: z.enum(LIBRARY_COUNTRIES).default('EG'),
            active: z.enum(['true', 'false']).default('true'),
            /** `more`: a bigger search for the same words (costs more at the provider). */
            size: z.enum(['normal', 'more']).default('normal'),
          }),
          response: {
            200: successSchema(
              z.object({
                ads: z.array(adDto),
                /** Sources still fetching (ask again in a few seconds). */
                pending: z.array(z.string()),
                unavailable: z.array(z.string()),
                errors: z.record(z.string(), z.string()),
              }),
            ),
          },
        },
      },
      async (req) => {
        const { q, platform, category, country, active, size } = req.query;
        const p: SearchParams = { q, platform, category: category === 'all' ? null : category, country, active: active === 'true', size };
        const k = keys();
        const wants = (x: Platform) => platform === 'all' || platform === x;
        const jobs: Promise<[string, SourceResult]>[] = [];
        const unavailable: string[] = [];

        if (wants('facebook') || wants('instagram')) {
          if (k.apify) jobs.push(apifySearch(k.apify, p, req.log).then((r) => ['facebook', r]));
          else if (k.meta && (EU_COUNTRIES as readonly string[]).includes(country)) jobs.push(metaSearch(k.meta, p).then((r) => ['facebook', r]));
          else unavailable.push(...(platform === 'all' ? ['facebook', 'instagram'] : [platform]));
        }
        if (wants('google') || wants('youtube')) {
          if (k.serp) {
            if (platform === 'youtube') jobs.push(serpSearch(k.serp, p, 'youtube').then((r) => ['youtube', r]));
            else jobs.push(serpSearch(k.serp, p, 'google').then((r) => ['google', r]));
          } else unavailable.push(...(platform === 'all' ? ['google', 'youtube'] : [platform]));
        }
        for (const x of ['tiktok', 'snapchat', 'linkedin', 'x'] as const) if (wants(x)) unavailable.push(x);

        const results = await Promise.all(jobs);
        const ads = results.flatMap(([, r]) => r.ads).filter((a) => platform === 'all' || a.platform === platform || (platform === 'google' && a.platform === 'youtube'));
        const pending = results.filter(([, r]) => r.pending).map(([name]) => name);
        const errors = Object.fromEntries(results.filter(([, r]) => r.error).map(([name, r]) => [name, r.error!]));
        // Nothing to show and every source failed: say so as an error the page can explain.
        if (ads.length === 0 && pending.length === 0 && results.length > 0 && Object.keys(errors).length === results.length) {
          const reason = Object.values(errors)[0]!;
          if (reason === 'library_token_expired' || reason === 'library_not_allowed') throw new ApiError(502, reason, undefined, { code: reason });
        }
        return ok({ ads, pending, unavailable, errors });
      },
    );

    app.get(
      '/library/saved',
      { schema: { ...schemaBase, summary: 'Ads saved to the ideas board', response: { 200: successSchema(z.array(adDto.extend({ savedAt: z.string() }))) } } },
      async (req) => {
        const rows = await sql<{ ad: LibraryAd; created_at: Date }[]>`
          select ad, created_at from ad_library_saves where workspace_id = ${req.auth.workspaceId} order by created_at desc limit 500`;
        return ok(rows.map((r) => ({ ...r.ad, savedAt: r.created_at.toISOString() })));
      },
    );

    app.post(
      '/library/saved',
      { schema: { ...schemaBase, summary: 'Save an ad to the ideas board', body: z.object({ ad: adDto }), response: { 200: successSchema(z.object({ saved: z.literal(true) })) } } },
      async (req) => {
        const { ad } = req.body;
        await sql`
          insert into ad_library_saves (workspace_id, platform, external_id, ad)
          values (${req.auth.workspaceId}, ${ad.platform}, ${ad.externalId}, ${sql.json(ad as never)})
          on conflict (workspace_id, platform, external_id) do update set ad = excluded.ad`;
        return ok({ saved: true as const });
      },
    );

    app.delete(
      '/library/saved/:id',
      { schema: { ...schemaBase, summary: 'Remove an ad from the ideas board', params: z.object({ id: z.string().min(1).max(200) }), response: { 200: successSchema(z.object({ removed: z.boolean() })) } } },
      async (req) => {
        const rows = await sql`delete from ad_library_saves where workspace_id = ${req.auth.workspaceId} and ad->>'id' = ${req.params.id} returning 1`;
        return ok({ removed: rows.length > 0 });
      },
    );
  };
}

