/** The ad library of /ads (see apps/api/src/routes/ad-library.ts). */

export const LIBRARY_PLATFORMS = ['facebook', 'instagram', 'tiktok', 'google', 'youtube', 'snapchat', 'linkedin', 'x'] as const;
export type LibraryPlatform = (typeof LIBRARY_PLATFORMS)[number];
export const LIBRARY_CATEGORIES = ['all', 'food', 'fashion', 'beauty', 'realestate', 'education', 'apps', 'electronics'] as const;
export type LibraryCategory = (typeof LIBRARY_CATEGORIES)[number];

export type LibraryAd = {
  id: string;
  platform: LibraryPlatform;
  placements: string[];
  externalId: string;
  advertiser: string;
  advertiserId: string | null;
  text: string | null;
  title: string | null;
  description: string | null;
  domain: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  active: boolean;
  days: number;
  variants: number;
  countries: string[];
  languages: string[];
  reach: number | null;
  category: string | null;
  score: number;
  url: string;
  /** Sample ads only: a handle shown the way the platform shows it, and a call to action. */
  handle?: string;
  cta?: string;
  /** The creative, when the source gives it: a picture (or a video's still) and the video. */
  image?: string;
  video?: string;
  format?: string;
  /** The advertiser's picture. */
  avatar?: string;
  /** Added by hand to the ideas board, with the user's note. */
  manual?: boolean;
  note?: string;
};

/** Same formula as the server: run length (most), versions in testing, spread. */
export function strength(days: number, variants = 1, spread = 1) {
  const run = (Math.min(days, 180) / 180) * 60;
  const tests = (Math.min(Math.max(variants - 1, 0), 9) / 9) * 25;
  const wide = (Math.min(Math.max(spread - 1, 0), 3) / 3) * 15;
  return Math.round(run + tests + wide);
}

/** The platform a pasted ad link belongs to. */
export function platformOf(url: string): LibraryPlatform | null {
  let host: string;
  try {
    host = new URL(url.trim()).hostname.replace(/^www\.|^m\./, '');
  } catch {
    return null;
  }
  if (/(^|\.)instagram\.com$/.test(host)) return 'instagram';
  if (/(^|\.)(facebook\.com|fb\.com|fb\.watch)$/.test(host)) return 'facebook';
  if (/(^|\.)tiktok\.com$/.test(host)) return 'tiktok';
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return 'youtube';
  if (/(^|\.)google\.[a-z.]+$/.test(host)) return 'google';
  if (/(^|\.)(linkedin\.com|lnkd\.in)$/.test(host)) return 'linkedin';
  if (/(^|\.)(snapchat\.com|snap\.com)$/.test(host)) return 'snapchat';
  if (/(^|\.)(x\.com|twitter\.com|t\.co)$/.test(host)) return 'x';
  return null;
}

/** Countries offered for opening the platforms' own libraries (any country works there). */
export const LAUNCH_COUNTRIES = ['EG', 'SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'JO', 'IQ', 'LB', 'MA', 'DZ', 'TN', 'LY', 'TR', 'GB', 'US', 'DE', 'FR'] as const;

/**
 * Each platform's own public ad library, opened on the words and country picked here. Where a site has
 * no documented search parameter, it opens on the country and the words are typed there (`typed`).
 */
export function libraryLink(platform: LibraryPlatform, q: string, country: string): { url: string; typed: boolean } {
  const words = q.trim();
  const domain = /^[\w-]+(\.[\w-]+)+$/.test(words) ? words.toLowerCase() : null;
  switch (platform) {
    case 'facebook':
    case 'instagram': {
      const params = new URLSearchParams({ active_status: 'active', ad_type: 'all', country, media_type: 'all', search_type: 'keyword_unordered', q: words });
      if (platform === 'instagram') params.set('publisher_platforms[0]', 'instagram');
      return { url: `https://www.facebook.com/ads/library/?${params}`, typed: !words };
    }
    case 'google':
    case 'youtube': {
      const params = new URLSearchParams({ region: country });
      if (domain) params.set('domain', domain);
      if (platform === 'youtube') params.set('format', 'VIDEO');
      return { url: `https://adstransparency.google.com/?${params}`, typed: !domain };
    }
    case 'tiktok':
      return { url: `https://ads.tiktok.com/business/creativecenter/inspiration/topads/pc/en?${new URLSearchParams({ period: '30', region: country })}`, typed: true };
    case 'linkedin': {
      const params = new URLSearchParams({ countries: country });
      if (words) params.set('keyword', words);
      return { url: `https://www.linkedin.com/ad-library/search?${params}`, typed: !words };
    }
    case 'snapchat':
      return { url: 'https://adsgallery.snap.com/', typed: true };
    case 'x':
      return { url: 'https://ads.twitter.com/ads-repository', typed: true };
  }
}

/** What each platform's own library covers, shown on its button. */
export const LIBRARY_REACH: Record<LibraryPlatform, 'all' | 'eu'> = {
  facebook: 'all',
  instagram: 'all',
  google: 'all',
  youtube: 'all',
  tiktok: 'all',
  linkedin: 'all',
  snapchat: 'eu',
  x: 'eu',
};

export type LibraryPage = { ads: LibraryAd[]; pending: string[]; unavailable: string[]; errors: Record<string, string> };
export type LibraryStatus = { sources: Record<string, boolean>; countries: string[] };

/** Each platform's mark and colors, so a card says where it runs before it is read. */
export const PLATFORM_LOOK: Record<LibraryPlatform, { mark: string; color: string; ink: string; text: string }> = {
  facebook: { mark: 'f', color: '#1877f2', ink: '#ffffff', text: '#1877f2' },
  instagram: { mark: 'ig', color: '#d62976', ink: '#ffffff', text: '#c2185b' },
  tiktok: { mark: 'tt', color: '#111111', ink: '#25f4ee', text: '#111111' },
  google: { mark: 'G', color: '#188038', ink: '#ffffff', text: '#188038' },
  youtube: { mark: '▶', color: '#e62117', ink: '#ffffff', text: '#d01b12' },
  snapchat: { mark: 'sc', color: '#fffc00', ink: '#111111', text: '#7a7500' },
  linkedin: { mark: 'in', color: '#0a66c2', ink: '#ffffff', text: '#0a66c2' },
  x: { mark: 'X', color: '#14171a', ink: '#ffffff', text: '#14171a' },
};

export const scoreTier = (score: number) => (score >= 80 ? 'high' : score >= 60 ? 'mid' : 'low');

const sample = (ad: Partial<LibraryAd> & Pick<LibraryAd, 'id' | 'platform' | 'advertiser' | 'days' | 'variants' | 'score' | 'category'>): LibraryAd => ({
  placements: [ad.platform],
  externalId: ad.id,
  advertiserId: null,
  text: null,
  title: null,
  description: null,
  domain: null,
  startedAt: null,
  stoppedAt: null,
  active: true,
  countries: ['EG'],
  languages: ['ar'],
  reach: null,
  url: '',
  ...ad,
});

/**
 * Shown while no source is connected, under a "preview" banner: invented businesses (no real
 * advertiser), one or two per platform, so every card style can be seen.
 */
export const SAMPLE_ADS: LibraryAd[] = [
  sample({ id: 's1', platform: 'facebook', category: 'food', advertiser: 'مطعم بيت المشويات', text: 'عرض نهاية الأسبوع: وجبة عائلية لـ٤ أفراد ومعاها مشروبين مجانًا. اطلب دلوقتي والتوصيل علينا.', title: 'وجبة عائلية بسعر [السعر]', domain: 'beit-mashwyat.example', cta: 'اطلب الآن', days: 94, variants: 6, countries: ['EG', 'SA'], score: 88 }),
  sample({ id: 's2', platform: 'instagram', category: 'fashion', advertiser: 'دار أزياء ليان', handle: 'layan.fashion', text: 'تشكيلة الشتا وصلت — خصم ٣٠٪ على أول طلب ليكي.', cta: 'تسوق الآن', days: 61, variants: 12, countries: ['EG', 'SA', 'AE', 'KW'], score: 82 }),
  sample({ id: 's3', platform: 'tiktok', category: 'beauty', advertiser: 'عيادة نضارة', handle: '@nadara.clinic', text: 'جلسة تنظيف بشرة كاملة في ٤٥ دقيقة — شوف النتيجة بنفسك قبل وبعد.', cta: 'احجز الآن', days: 38, variants: 9, score: 74 }),
  sample({ id: 's4', platform: 'google', category: 'realestate', advertiser: 'مسكن للتطوير', title: 'شقق للبيع في التجمع الخامس | مقدم يبدأ من [المبلغ]', text: 'تقسيط لحد ٨ سنين. استلام فوري. احجز معاينة مجانية النهارده.', domain: 'maskan-homes.example', days: 210, variants: 4, score: 91 }),
  sample({ id: 's5', platform: 'youtube', category: 'education', advertiser: 'أكاديمية طلاقة للغات', title: 'اتكلم إنجليزي بثقة في ٣ شهور — أول حصة مجانًا', cta: 'سجّل الآن', days: 45, variants: 3, countries: ['EG', 'SA', 'AE', 'JO', 'MA'], score: 69 }),
  sample({ id: 's6', platform: 'snapchat', category: 'apps', advertiser: 'تطبيق سفرة', text: 'أول طلب عليك… والتوصيل علينا', cta: 'اسحب للتحميل', days: 22, variants: 5, countries: ['SA', 'AE', 'KW'], score: 58 }),
  sample({ id: 's7', platform: 'linkedin', category: 'apps', advertiser: 'مدار للحلول البرمجية', text: 'بنساعد الشركات الصغيرة تبني تطبيقها في ٦٠ يوم. احجز استشارة مجانية مع فريقنا.', title: 'تطبيقك جاهز في ٦٠ يوم', cta: 'احجز استشارة', days: 33, variants: 2, countries: ['EG', 'SA', 'AE', 'QA', 'KW', 'BH'], score: 64 }),
  sample({ id: 's8', platform: 'x', category: 'electronics', advertiser: 'متجر تقني', handle: '@taqani_store', text: 'سماعات لاسلكية بعزل ضوضاء — العرض لحد آخر الشهر بس.', days: 15, variants: 3, countries: ['EG', 'SA'], score: 52 }),
  sample({ id: 's9', platform: 'facebook', category: 'education', advertiser: 'استوديو لقطة', text: 'كورس تصوير بالموبايل من الصفر — ٨ محاضرات أونلاين وشهادة في الآخر.', title: 'ابدأ التصوير الاحترافي بموبايلك', domain: 'laqta-studio.example', cta: 'سجّل الآن', days: 120, variants: 8, countries: ['EG', 'SA', 'AE'], score: 85 }),
  sample({ id: 's10', platform: 'instagram', category: 'food', advertiser: 'كافيه بُن', handle: 'bun.cafe', text: 'قهوة اليوم: لاتيه بالكراميل المملح — اشتري واحد والتاني هدية.', cta: 'اعرف المزيد', days: 18, variants: 2, score: 47 }),
  sample({ id: 's11', platform: 'tiktok', category: 'fashion', advertiser: 'شوز ستريت', handle: '@shoes.street', text: 'الكوتشي اللي الكل بيسأل عليه رجع تاني — المقاسات محدودة.', cta: 'تسوق الآن', days: 75, variants: 15, countries: ['EG', 'SA', 'AE'], score: 86 }),
  sample({ id: 's12', platform: 'google', category: 'beauty', advertiser: 'عيادة ابتسامة', title: 'دكتور أسنان في المعادي — كشف مجاني الأسبوع ده', text: 'تبييض وتقويم وزراعة بأحدث الأجهزة. مواعيد مسائية ويوم الجمعة.', domain: 'ebtsama-dental.example', days: 140, variants: 3, score: 79 }),
];
