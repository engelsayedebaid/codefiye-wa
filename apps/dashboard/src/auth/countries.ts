/** Calling codes for the phone field. Names live here because they are a catalog, not page chrome. */
export type Country = { iso: string; dial: string; ar: string; en: string };

/** Shown first, in this order, before the alphabetical rest. Egypt leads: it's the home market. */
export const COMMON_ISOS = ['EG', 'SA', 'AE', 'KW', 'QA', 'BH', 'OM', 'JO', 'LB', 'IQ', 'PS', 'YE', 'LY', 'SD', 'TN', 'DZ', 'MA', 'TR'] as const;

export const COUNTRIES: Country[] = [
  { iso: 'EG', dial: '+20', ar: 'مصر', en: 'Egypt' },
  { iso: 'SA', dial: '+966', ar: 'السعودية', en: 'Saudi Arabia' },
  { iso: 'AE', dial: '+971', ar: 'الإمارات', en: 'United Arab Emirates' },
  { iso: 'KW', dial: '+965', ar: 'الكويت', en: 'Kuwait' },
  { iso: 'QA', dial: '+974', ar: 'قطر', en: 'Qatar' },
  { iso: 'BH', dial: '+973', ar: 'البحرين', en: 'Bahrain' },
  { iso: 'OM', dial: '+968', ar: 'عُمان', en: 'Oman' },
  { iso: 'JO', dial: '+962', ar: 'الأردن', en: 'Jordan' },
  { iso: 'LB', dial: '+961', ar: 'لبنان', en: 'Lebanon' },
  { iso: 'IQ', dial: '+964', ar: 'العراق', en: 'Iraq' },
  { iso: 'SY', dial: '+963', ar: 'سوريا', en: 'Syria' },
  { iso: 'PS', dial: '+970', ar: 'فلسطين', en: 'Palestine' },
  { iso: 'YE', dial: '+967', ar: 'اليمن', en: 'Yemen' },
  { iso: 'LY', dial: '+218', ar: 'ليبيا', en: 'Libya' },
  { iso: 'SD', dial: '+249', ar: 'السودان', en: 'Sudan' },
  { iso: 'TN', dial: '+216', ar: 'تونس', en: 'Tunisia' },
  { iso: 'DZ', dial: '+213', ar: 'الجزائر', en: 'Algeria' },
  { iso: 'MA', dial: '+212', ar: 'المغرب', en: 'Morocco' },
  { iso: 'MR', dial: '+222', ar: 'موريتانيا', en: 'Mauritania' },
  { iso: 'SO', dial: '+252', ar: 'الصومال', en: 'Somalia' },
  { iso: 'DJ', dial: '+253', ar: 'جيبوتي', en: 'Djibouti' },
  { iso: 'KM', dial: '+269', ar: 'جزر القمر', en: 'Comoros' },
  { iso: 'TR', dial: '+90', ar: 'تركيا', en: 'Turkey' },
  { iso: 'IR', dial: '+98', ar: 'إيران', en: 'Iran' },
  { iso: 'US', dial: '+1', ar: 'الولايات المتحدة', en: 'United States' },
  { iso: 'CA', dial: '+1', ar: 'كندا', en: 'Canada' },
  { iso: 'GB', dial: '+44', ar: 'المملكة المتحدة', en: 'United Kingdom' },
  { iso: 'DE', dial: '+49', ar: 'ألمانيا', en: 'Germany' },
  { iso: 'FR', dial: '+33', ar: 'فرنسا', en: 'France' },
  { iso: 'IT', dial: '+39', ar: 'إيطاليا', en: 'Italy' },
  { iso: 'ES', dial: '+34', ar: 'إسبانيا', en: 'Spain' },
  { iso: 'NL', dial: '+31', ar: 'هولندا', en: 'Netherlands' },
  { iso: 'BE', dial: '+32', ar: 'بلجيكا', en: 'Belgium' },
  { iso: 'SE', dial: '+46', ar: 'السويد', en: 'Sweden' },
  { iso: 'NO', dial: '+47', ar: 'النرويج', en: 'Norway' },
  { iso: 'CH', dial: '+41', ar: 'سويسرا', en: 'Switzerland' },
  { iso: 'AT', dial: '+43', ar: 'النمسا', en: 'Austria' },
  { iso: 'GR', dial: '+30', ar: 'اليونان', en: 'Greece' },
  { iso: 'PT', dial: '+351', ar: 'البرتغال', en: 'Portugal' },
  { iso: 'PL', dial: '+48', ar: 'بولندا', en: 'Poland' },
  { iso: 'UA', dial: '+380', ar: 'أوكرانيا', en: 'Ukraine' },
  { iso: 'RU', dial: '+7', ar: 'روسيا', en: 'Russia' },
  { iso: 'CN', dial: '+86', ar: 'الصين', en: 'China' },
  { iso: 'JP', dial: '+81', ar: 'اليابان', en: 'Japan' },
  { iso: 'KR', dial: '+82', ar: 'كوريا الجنوبية', en: 'South Korea' },
  { iso: 'IN', dial: '+91', ar: 'الهند', en: 'India' },
  { iso: 'PK', dial: '+92', ar: 'باكستان', en: 'Pakistan' },
  { iso: 'BD', dial: '+880', ar: 'بنغلاديش', en: 'Bangladesh' },
  { iso: 'LK', dial: '+94', ar: 'سريلانكا', en: 'Sri Lanka' },
  { iso: 'AF', dial: '+93', ar: 'أفغانستان', en: 'Afghanistan' },
  { iso: 'PH', dial: '+63', ar: 'الفلبين', en: 'Philippines' },
  { iso: 'ID', dial: '+62', ar: 'إندونيسيا', en: 'Indonesia' },
  { iso: 'MY', dial: '+60', ar: 'ماليزيا', en: 'Malaysia' },
  { iso: 'SG', dial: '+65', ar: 'سنغافورة', en: 'Singapore' },
  { iso: 'TH', dial: '+66', ar: 'تايلاند', en: 'Thailand' },
  { iso: 'VN', dial: '+84', ar: 'فيتنام', en: 'Vietnam' },
  { iso: 'AU', dial: '+61', ar: 'أستراليا', en: 'Australia' },
  { iso: 'NZ', dial: '+64', ar: 'نيوزيلندا', en: 'New Zealand' },
  { iso: 'BR', dial: '+55', ar: 'البرازيل', en: 'Brazil' },
  { iso: 'MX', dial: '+52', ar: 'المكسيك', en: 'Mexico' },
  { iso: 'AR', dial: '+54', ar: 'الأرجنتين', en: 'Argentina' },
  { iso: 'NG', dial: '+234', ar: 'نيجيريا', en: 'Nigeria' },
  { iso: 'KE', dial: '+254', ar: 'كينيا', en: 'Kenya' },
  { iso: 'ZA', dial: '+27', ar: 'جنوب أفريقيا', en: 'South Africa' },
  { iso: 'ET', dial: '+251', ar: 'إثيوبيا', en: 'Ethiopia' },
  { iso: 'GH', dial: '+233', ar: 'غانا', en: 'Ghana' },
];

const byIso = new Map(COUNTRIES.map((c) => [c.iso, c]));

export const countryByIso = (iso: string) => byIso.get(iso) ?? COUNTRIES[0]!;

export function countryGroups(lang: 'ar' | 'en', query: string): { label: 'common' | 'all' | null; items: Country[] }[] {
  const q = query.trim().toLowerCase();
  const name = (c: Country) => (lang === 'ar' ? c.ar : c.en);
  if (q) {
    const items = COUNTRIES.filter(
      (c) => c.ar.includes(query.trim()) || c.en.toLowerCase().includes(q) || c.iso.toLowerCase().includes(q) || c.dial.includes(q.replace(/^\+/, '')),
    ).sort((a, b) => name(a).localeCompare(name(b), lang));
    return [{ label: null, items }];
  }
  const pinned = new Set<string>(COMMON_ISOS);
  const common = COMMON_ISOS.map((iso) => byIso.get(iso)).filter((c): c is Country => Boolean(c));
  const rest = COUNTRIES.filter((c) => !pinned.has(c.iso)).sort((a, b) => name(a).localeCompare(name(b), lang));
  return [
    { label: 'common', items: common },
    { label: 'all', items: rest },
  ];
}
