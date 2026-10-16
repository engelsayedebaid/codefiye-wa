import type { OfferedPlan } from '@wa/shared/plan-pricing';
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

export const NAV_HREFS = ['#features', '#how', '#pricing', '/guide', '#faq'];

export const LANGUAGES = ['Node.js', 'Python', 'PHP', 'Laravel', 'Go', 'Java', 'C#', 'Ruby', 'n8n', 'Make'];

export const RESOURCES = [
  { icon: BookOpen, tint: 'text-info', href: '/guide' },
  { icon: KeyRound, tint: 'text-sender-amber', href: '/guide#get-key' },
  { icon: ShieldCheck, tint: 'text-brand', href: '/guide#playground' },
  { icon: ArrowLeftRight, tint: 'text-sender-rose', href: '/guide#code' },
];

export const STEP_ICONS = [QrCode, MessageSquare, BarChart3];

export const MESSAGE_TYPE_ICONS = [Type, Image, FileText, Mic, Contact, MapPin];

export const RECIPIENTS = [
  { icon: User, tint: 'from-teal to-brand' },
  { icon: Users, tint: 'from-brand-strong to-brand-deep' },
];

export const USE_CASE_ICONS = [MessageSquare, Bell, Bot, Users, ShoppingCart, Send];

export type PricedPlan = OfferedPlan;

// The terms of service page still needs writing (README §10) — add it here once it exists.
export const FOOTER_HREFS = [
  ['/#features', '/#how', '/#pricing'],
  ['/guide', '/docs', '/dashboard'],
  ['/#faq', '/register', '/login', '/privacy'],
];
