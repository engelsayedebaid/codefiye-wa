/**
 * The auto-reply agent's settings: the personality it speaks with, the rules it follows and the
 * provider that answers. Zod-free (the request schemas live in the API) so the dashboard can import
 * the types and the templates.
 */

import type { AiProviderId } from './ai';

/** `custom` = the prompt the admin wrote; the others are the built-in personalities. */
export const AUTO_REPLY_PERSONALITIES = ['sales', 'support', 'booking', 'custom'] as const;
export type AutoReplyPersonality = (typeof AUTO_REPLY_PERSONALITIES)[number];

/** The languages the agent may answer in; `auto` follows the language of the message. */
export const AUTO_REPLY_LANGUAGES = ['auto', 'ar', 'en'] as const;
export type AutoReplyLanguage = (typeof AUTO_REPLY_LANGUAGES)[number];

/** What the prompts may refer to; each one is filled in when the prompt is built. */
export type AutoReplyVariables = {
  businessName: string;
  services: string;
  pricing: string;
  website: string;
  phone: string;
};

export const DEFAULT_AUTO_REPLY_VARIABLES: AutoReplyVariables = {
  businessName: 'CodeFiye',
  services: 'Web development (React, Next.js, PHP), mobile apps (Flutter for iOS and Android), UI/UX design, e-commerce',
  pricing: 'Every project is quoted on its own — ask for a price and we send a written proposal',
  website: 'codefiye.com',
  phone: '',
};

/** A canned answer for a word the contact writes (e.g. "price" → our price line). */
export type AutoReplyRule = {
  id: string;
  /** Words that trigger the rule; matched against the message, in Arabic or English. */
  keywords: string[];
  /** The answer to send, sent as it is (no AI). */
  reply: string;
  /** `contains`: the message contains a keyword; `exact`: it is one of them (after trimming). */
  match: 'contains' | 'exact';
};

/**
 * The built-in personalities. Each has an Arabic and an English version, so the agent speaks the
 * contact's language even in its own instructions.
 */
export const PERSONALITY_PROMPTS: Record<Exclude<AutoReplyPersonality, 'custom'>, { ar: string; en: string }> = {
  sales: {
    ar: `أنت المساعد الذكي لـ {{business_name}} ({{website}})، شركة متخصصة في تطوير المواقع والتطبيقات.

الخدمات التي نقدمها:
- تطوير المواقع (React، Next.js، PHP، WordPress)
- تطوير تطبيقات الجوال (Flutter - iOS و Android)
- تصميم واجهات المستخدم UX/UI
- حلول المتاجر الإلكترونية
- قوالب/themes جاهزة

تعليماتك:
- كن محترفاً وودوداً ومفيداً.
- اكتب بالعربية إن كتب العميل بالعربية، وبالإنجليزية إن كتب بالإنجليزية.
- عند سؤال عن السعر، اذكر {{pricing}} واعرض إرسال عرض سعر مفصل.
- اجمع اسم العميل، متطلبات المشروع، وطريقة التواصل المفضلة.
- وجّه العميل إلى {{website}} لمشاهدة الأعمال والخدمات.
- إن سأل عن القوالب، اذكر {{website}}/templates.
- لا تَعِد بتاريخ أو سعر نهائي قبل الاتفاق مع الفريق.`,
    en: `You are the AI assistant for {{business_name}} ({{website}}), a professional web and mobile development agency.

Services offered:
- Web Development (React, Next.js, PHP, WordPress)
- Mobile App Development (Flutter - iOS & Android)
- UI/UX Design
- E-commerce Solutions
- Custom Templates & Themes

Guidelines:
- Be professional, friendly, and helpful.
- Auto-detect the user's language (Arabic or English) and reply in the same language.
- For pricing inquiries, provide general ranges and offer to schedule a detailed consultation.
- Collect the user's name, project requirements, and preferred contact method.
- Always encourage users to visit {{website}} for portfolio and more details.
- If asked about templates, reference the templates page: {{website}}/templates.
- Never commit to a date or a final price before the team agrees to it.`,
  },
  support: {
    ar: `أنت مساعد دعم العملاء في {{business_name}} ({{website}}).

تعليماتك:
- أجب عن الأسئلة الشائعة بسرعة ودقة، وكن ودوداً.
- اكتب بالعربية إن كتب العميل بالعربية، وبالإنجليزية إن كتب بالإنجليزية.
- لا تخترع معلومات: إن لم تعرف، قل ذلك ووجّه العميل إلى {{website}} أو إلى الفريق.
- اجمع اسم العميل ورقم تواصله وموضوع الطلب قبل تحويله.
- الخدمات المتاحة: {{services}}.`,
    en: `You are the customer support assistant for {{business_name}} ({{website}}).

Guidelines:
- Answer common questions quickly and accurately, and stay friendly.
- Reply in Arabic when the customer writes in Arabic, and in English when they write in English.
- Never invent information: if you don't know, say so and point to {{website}} or to the team.
- Collect the customer's name, contact number and the subject before handing over.
- Services available: {{services}}.`,
  },
  booking: {
    ar: `أنت مساعد حجز المواعيد في {{business_name}} ({{website}}).

تعليماتك:
- رتّب موعد استشارة: اسأل عن الاسم، نوع المشروع، الميزانية التقريبية، والأوقات المتاحة.
- اعرض المواعيد المتاحة باليوم والساعة حسب توقيت العميل.
- أكّد الحجز بجملة واحدة واضحة (الاسم، الموعد، الخدمة).
- اكتب بالعربية إن كتب العميل بالعربية، وبالإنجليزية إن كتب بالإنجليزية.
- الخدمات: {{services}}. التسعير: {{pricing}}.`,
    en: `You are the appointment booking assistant for {{business_name}} ({{website}}).

Guidelines:
- Arrange a consultation: ask for the name, the kind of project, the rough budget and the times that suit.
- Offer available slots by day and hour, in the customer's own time zone.
- Confirm the booking in one clear sentence (name, slot, service).
- Reply in Arabic when the customer writes in Arabic, and in English when they write in English.
- Services: {{services}}. Pricing: {{pricing}}.`,
  },
};

/** Fills `{{name}}` placeholders; an unknown placeholder is left as it is. */
export function fillVariables(text: string, variables: AutoReplyVariables): string {
  const values: Record<string, string> = {
    business_name: variables.businessName,
    services: variables.services,
    pricing: variables.pricing,
    website: variables.website,
    phone: variables.phone,
  };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) => values[name] ?? whole);
}

/** The prompt the agent answers with: the custom one, or the personality in the contact's language. */
export function buildSystemPrompt(
  settings: { personality: AutoReplyPersonality; systemPrompt: string; variables: AutoReplyVariables },
  language: 'ar' | 'en',
): string {
  if (settings.personality === 'custom' && settings.systemPrompt.trim()) {
    return fillVariables(settings.systemPrompt, settings.variables);
  }
  const template = PERSONALITY_PROMPTS[(settings.personality === 'custom' ? 'sales' : settings.personality) as Exclude<
    AutoReplyPersonality,
    'custom'
  >];
  return fillVariables(template[language], settings.variables);
}

/** The rule that answers this message, if any: the first match wins. */
export function matchRule(text: string, rules: AutoReplyRule[]): AutoReplyRule | null {
  const trimmed = text.trim().toLowerCase();
  for (const rule of rules) {
    if (rule.keywords.length === 0) continue;
    for (const keyword of rule.keywords) {
      const needle = keyword.trim().toLowerCase();
      if (!needle) continue;
      if (rule.match === 'exact' ? trimmed === needle : trimmed.includes(needle)) return rule;
    }
  }
  return null;
}

/** Everything the agent needs for one number. */
export type AutoReplySettings = {
  /** Whether this number answers on its own. */
  enabled: boolean;
  personality: AutoReplyPersonality;
  /** The admin's own prompt; used when the personality is `custom`. */
  systemPrompt: string;
  providerId: AiProviderId;
  model: string;
  /** Used when the first provider fails; null = no fallback. */
  fallbackProviderId: AiProviderId | null;
  fallbackModel: string;
  temperature: number;
  maxTokens: number;
  /** The pause before the answer goes out (a human typing); the queue sends it when the time comes. */
  delayMinMs: number;
  delayMaxMs: number;
  /** Answer only inside the business hours below. */
  businessHoursOnly: boolean;
  hoursStart: number;
  hoursEnd: number;
  /** The time zone the hours are in (e.g. Africa/Cairo). */
  timezone: string;
  /** How many answers one conversation may get; 0 = no limit. */
  maxReplies: number;
  /** Numbers (E.164 or a JID) that are never answered. */
  ignoreList: string[];
  /** Canned answers for certain words. */
  rules: AutoReplyRule[];
  /** `auto` answers in the contact's language. */
  language: AutoReplyLanguage;
  variables: AutoReplyVariables;
};

export const DEFAULT_AUTO_REPLY_SETTINGS: AutoReplySettings = {
  enabled: false,
  personality: 'sales',
  systemPrompt: '',
  providerId: 'anthropic',
  model: '',
  fallbackProviderId: null,
  fallbackModel: '',
  temperature: 0.7,
  maxTokens: 800,
  delayMinMs: 1_500,
  delayMaxMs: 4_000,
  businessHoursOnly: false,
  hoursStart: 9,
  hoursEnd: 18,
  timezone: 'Africa/Cairo',
  maxReplies: 6,
  ignoreList: [],
  rules: [],
  language: 'auto',
  variables: DEFAULT_AUTO_REPLY_VARIABLES,
};

/** How an auto-reply ended; the dashboard shows it as the activity log. */
export const AUTO_REPLY_STATUSES = ['sent', 'failed', 'skipped'] as const;
export type AutoReplyStatus = (typeof AUTO_REPLY_STATUSES)[number];

/** Why an answer was skipped (the agent stays quiet). */
export const AUTO_REPLY_SKIP_REASONS = [
  'disabled',
  'ignored',
  'outside_hours',
  'no_words',
  'group',
  'limit_reached',
  'history',
] as const;
export type AutoReplySkipReason = (typeof AUTO_REPLY_SKIP_REASONS)[number];
