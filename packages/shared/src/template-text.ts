/** Template text helpers with no dependencies, shared by the API and the dashboard bundle. */

/** What a template is for. OTP templates must use `{{code}}`; the category only guides the dashboard. */
export const TEMPLATE_CATEGORIES = ['otp', 'notification', 'marketing', 'custom'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

/** `{{ name }}` placeholders: letters, digits and underscores, not starting with a digit. */
export const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Variable names used by a template body, in first-seen order. */
export function templateVariables(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

export type TemplateVariables = Record<string, string | number>;

/** Fills every placeholder, or reports the variables that weren't provided. */
export function renderTemplate(body: string, variables: TemplateVariables = {}): { text: string; missing: [] } | { text: null; missing: string[] } {
  const missing = templateVariables(body).filter((name) => variables[name] === undefined || String(variables[name]).trim() === '');
  if (missing.length) return { text: null, missing };
  return { text: body.replace(PLACEHOLDER, (_, name: string) => String(variables[name])), missing: [] };
}

/** WhatsApp's poll limits; template "buttons" are sent as a poll. */
export const POLL_LIMITS = { question: 255, option: 100, minOptions: 2, maxOptions: 12 } as const;

/**
 * Everything a template can carry: the text (the caption when there is an image), an optional
 * header image (sent together as one "card"), and optional buttons — a poll sent right after,
 * titled `buttonsTitle`.
 */
export type TemplateParts = { body: string; imageUrl?: string | null; buttons?: string[] | null; buttonsTitle?: string | null };

const textParts = (t: TemplateParts) => [t.body, ...(t.buttons?.length ? [t.buttonsTitle ?? '', ...t.buttons] : [])];

/** Placeholders across the text, the buttons title and the button labels, in first-seen order. */
export function templatePartsVariables(t: TemplateParts): string[] {
  return [...new Set(textParts(t).flatMap(templateVariables))];
}

export type RenderedTemplate = { text: string; imageUrl: string | null; poll: { name: string; options: string[] } | null };

/** Renders every part, or reports the variables (from any part) that weren't provided. */
export function renderTemplateParts(t: TemplateParts, variables: TemplateVariables = {}): { rendered: RenderedTemplate; missing: [] } | { rendered: null; missing: string[] } {
  const missing = templatePartsVariables(t).filter((name) => variables[name] === undefined || String(variables[name]).trim() === '');
  if (missing.length) return { rendered: null, missing };
  const fill = (text: string) => text.replace(PLACEHOLDER, (_, name: string) => String(variables[name]));
  return {
    rendered: {
      text: fill(t.body),
      imageUrl: t.imageUrl || null,
      poll: t.buttons?.length ? { name: fill(t.buttonsTitle ?? ''), options: t.buttons.map(fill) } : null,
    },
    missing: [],
  };
}

/** Used by `POST /api/send-otp` when the workspace has no template named `otp`. */
export const DEFAULT_OTP_TEMPLATES = {
  ar: 'رمز التحقق الخاص بك هو: *{{code}}*\nلا تشارك هذا الرمز مع أي شخص.',
  en: 'Your verification code is: *{{code}}*\nDo not share this code with anyone.',
} as const;
