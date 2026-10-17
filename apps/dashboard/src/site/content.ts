import type { OfferedPlan } from '@wa/shared/plan-pricing';
import {
  Activity,
  Bot,
  CalendarClock,
  CheckCheck,
  CodeXml,
  Headphones,
  KeyRound,
  LockKeyhole,
  Megaphone,
  MessagesSquare,
  QrCode,
  Repeat,
  SendHorizontal,
  Server,
  ShieldCheck,
  ShieldHalf,
  ShoppingCart,
  Smartphone,
} from 'lucide-react';

/**
 * Icons and links for the public pages. The copy lives in i18n/ (same order as these arrays), so
 * both languages share one layout.
 */

/** Header links: `#…` are landing-page sections (SiteHeader points them back to `/` elsewhere). */
export const NAV_HREFS = ['#platform', '#solutions', '#developers', '#pricing', '/guide'];

export const LANGUAGES = ['Node.js', 'Python', 'PHP', 'Laravel', 'Go', 'Java', 'C#', 'Ruby', 'Flutter', 'cURL', 'n8n', 'Make'];

export const PLATFORM_ICONS = { api: CodeXml, numbers: Smartphone, inbox: MessagesSquare, campaigns: Megaphone, otp: ShieldCheck, tracking: CheckCheck };

export const DEMO_ICONS = [QrCode, SendHorizontal, Activity];

export const STEP_ICONS = [QrCode, KeyRound, SendHorizontal];

export const SOLUTION_ICONS = [ShoppingCart, Headphones, ShieldCheck, CalendarClock, Megaphone, Bot];

export const SECURITY_ICONS = [LockKeyhole, Smartphone, KeyRound, Server, ShieldHalf, Repeat];

export const SECURITY_BADGES = ['AES-256-GCM', 'TLS', 'TOTP 2FA', 'SHA-256', 'Idempotency-Key'];

export type PricedPlan = OfferedPlan;

/** `mailto:` is the support address; `#…` as in NAV_HREFS. The terms of service page still needs writing (README §10). */
export const FOOTER_HREFS = [
  ['#platform', '#demo', '#solutions', '#pricing'],
  ['/guide', '/docs', '/dashboard'],
  ['#faq', 'mailto:', '/register', '/login'],
  ['/privacy'],
];
