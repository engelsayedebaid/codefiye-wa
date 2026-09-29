import type { SessionStatus } from './api';

export const statusLabel: Record<SessionStatus, string> = {
  created: 'جديدة',
  qr: 'بانتظار المسح',
  pairing: 'ربط بالرمز',
  connecting: 'جارٍ الاتصال',
  connected: 'متصلة',
  disconnected: 'غير متصلة',
  needs_attention: 'تحتاج تدخّل',
  logged_out: 'تم الخروج',
};

export const statusTone: Record<SessionStatus, string> = {
  created: 'neutral',
  qr: 'warning',
  pairing: 'warning',
  connecting: 'warning',
  connected: 'success',
  disconnected: 'neutral',
  needs_attention: 'danger',
  logged_out: 'neutral',
};

export const messageStatusLabel: Record<string, string> = {
  pending: 'في الانتظار',
  sent: 'أُرسلت',
  delivered: 'وصلت',
  read: 'مقروءة',
  played: 'مسموعة',
  failed: 'فشلت',
};

export const messageStatusTone: Record<string, string> = {
  pending: 'warning',
  sent: 'neutral',
  delivered: 'success',
  read: 'success',
  played: 'success',
  failed: 'danger',
};

export const methodLabel: Record<string, string> = {
  instapay: 'إنستاباي',
  vodafone_cash: 'فودافون كاش',
  bank_transfer: 'تحويل بنكي',
  fawry: 'فوري',
  other: 'أخرى',
};
