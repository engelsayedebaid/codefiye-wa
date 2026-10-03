import { PLANS, type Plan } from '@wa/shared/plans';
import {
  ArrowLeftRight,
  BarChart3,
  Bell,
  BookOpen,
  Bot,
  Contact,
  FileText,
  Image,
  KeyRound,
  MapPin,
  MessageSquare,
  Mic,
  QrCode,
  Send,
  ShieldCheck,
  ShoppingCart,
  Type,
  User,
  Users,
} from 'lucide-react';

/**
 * Icons, links and plan data for the marketing page. The copy lives in i18n/ (same order as these
 * arrays), so both languages share one layout.
 */

export const NAV_HREFS = ['#features', '#how', '#pricing', '/docs', '#faq'];

export const LANGUAGES = ['Node.js', 'Python', 'PHP', 'Laravel', 'Go', 'Java', 'C#', 'Ruby', 'n8n', 'Make'];

export const RESOURCES = [
  { icon: BookOpen, tint: 'text-sky-400', href: '/docs' },
  { icon: KeyRound, tint: 'text-amber-400', href: '/register' },
  { icon: ShieldCheck, tint: 'text-brand', href: '/docs' },
  { icon: ArrowLeftRight, tint: 'text-rose-400', href: '/docs' },
];

export const STEP_ICONS = [QrCode, MessageSquare, BarChart3];

export const MESSAGE_TYPE_ICONS = [Type, Image, FileText, Mic, Contact, MapPin];

export const RECIPIENTS = [
  { icon: User, tint: 'from-sky-500 to-blue-600' },
  { icon: Users, tint: 'from-emerald-400 to-green-600' },
];

export const USE_CASE_ICONS = [MessageSquare, Bell, Bot, Users, ShoppingCart, Send];

export type PricedPlan = Plan & { priceUsd: number; popular?: boolean };

export const PRICED_PLANS: PricedPlan[] = [PLANS.basic, { ...PLANS.pro, popular: true }, PLANS.plus, PLANS.business];

// Terms of service and privacy policy pages still need writing (README §10) — add them here once they exist.
export const FOOTER_HREFS = [
  ['/#features', '/#how', '/#pricing'],
  ['/docs', '/docs/openapi.json', '/dashboard'],
  ['/#faq', '/register', '/login'],
];
