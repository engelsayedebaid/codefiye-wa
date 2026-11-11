import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OnlinePaymentPanel, PaymentMethodSelector } from '../src/app/payments/OnlinePay';
import {
  BillingPeriodSelector,
  CheckoutHeader,
  CheckoutProgress,
  SubscriptionSummary,
} from '../src/app/payments/RequestPlan';
import { PaymentSecurityFooter } from '../src/app/payments/Trust';
import { I18nProvider } from '../src/i18n';
import type { PricedPlan } from '../src/site/content';
import { ThemeProvider } from '../src/theme';

const PRO_PLAN: PricedPlan = {
  id: 'pro',
  name: 'Pro',
  priceUsd: 8.25,
  compareAtUsd: 16.5,
  sessions: 3,
  rpm: 60,
  dailyMessages: null,
  retentionDays: 90,
  features: ['api', 'webhooks'],
  popular: true,
};

function renderWithProviders(node: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(ThemeProvider, null, createElement(I18nProvider, null, node)),
    ),
  );
}

describe('checkout redesign components', () => {
  it('renders CheckoutHeader with CodeFiye brand, secure payment indicator, help link, and test badge', () => {
    const html = renderWithProviders(createElement(CheckoutHeader, { test: true, onClose: () => undefined }));
    expect(html).toContain('Code');
    expect(html).toContain('Fiye');
    expect(html).toContain('WA');
    expect(html).toContain('دفع آمن ومشفر');
    expect(html).toContain('مركز المساعدة');
    expect(html).toContain('href="/contact"');
    expect(html).toContain('تجريبي');
  });

  it('renders three-step CheckoutProgress with active and activating states', () => {
    const activeHtml = renderWithProviders(createElement(CheckoutProgress, { activating: false }));
    expect(activeHtml).toContain('اختر الخطة');
    expect(activeHtml).toContain('الدفع');
    expect(activeHtml).toContain('تفعيل الحساب');
    expect(activeHtml).toContain('aria-current="step"');

    const activatingHtml = renderWithProviders(createElement(CheckoutProgress, { activating: true }));
    expect(activatingHtml).toContain('تفعيل الحساب');
  });

  it('renders BillingPeriodSelector with dynamic EGP prices for 1, 3, 6, and 12 months', () => {
    // 8.25 USD * 50 EGP/USD = 413 EGP (rounded); compareAt 16.50 * 50 = 825 EGP
    const html = renderWithProviders(
      createElement(BillingPeriodSelector, {
        plan: PRO_PLAN,
        egpPerUsd: 50,
        value: 1,
        onChange: () => undefined,
      }),
    );
    expect(html).toContain('شهر واحد');
    expect(html).toContain('3 أشهر');
    expect(html).toContain('6 أشهر');
    expect(html).toContain('12 شهراً');
    expect(html).toContain('413 ج.م');
    expect(html).toContain('825 ج.م');
    expect(html).toContain('1,238 ج.م');
  });

  it('renders SubscriptionSummary with dynamic plan features, 50% discount calculation, and SSL badge', () => {
    const html = renderWithProviders(
      createElement(SubscriptionSummary, { plan: PRO_PLAN, months: 1, egpPerUsd: 50 }),
    );
    expect(html).toContain('خطة Pro');
    expect(html).toContain('825 ج.م');
    expect(html).toContain('خصم خاص (50%)');
    expect(html).toContain('- 412 ج.م');
    expect(html).toContain('الإجمالي المطلوب');
    expect(html).toContain('413 ج.م');
    expect(html).toContain('دفع آمن 100%');
    expect(html).toContain('3 جلسات واتساب');
  });

  it('renders PaymentMethodSelector and CardPanel with LTR numeric fields and dynamic CTA', () => {
    const html = renderWithProviders(
      createElement(OnlinePaymentPanel, {
        methods: ['card', 'wallet', 'bank_installments', 'aman'],
        planId: 'pro',
        months: 1,
        amountLabel: '413 ج.م',
        test: false,
        onNeedsPhone: () => undefined,
        onDone: () => undefined,
        onOpened: () => undefined,
        onLockedChange: () => undefined,
      }),
    );
    expect(html).toContain('اختر وسيلة الدفع');
    expect(html).toContain('بطاقة بنكية');
    expect(html).toContain('محافظ الموبايل');
    expect(html).toContain('تقسيط البنوك');
    expect(html).toContain('أمان');
    expect(html).toContain('بيانات البطاقة');
    expect(html).toContain('autoComplete="cc-number"');
    expect(html).toContain('autoComplete="cc-exp"');
    expect(html).toContain('autoComplete="cc-csc"');
    expect(html).toContain('autoComplete="cc-name"');
    expect(html).toContain('VISA');
    expect(html).toContain('meeza');
    expect(html).toContain('ادفع الآن — 413 ج.م');
  });

  it('renders PaymentSecurityFooter with Kashier mark and legal policy links', () => {
    const html = renderWithProviders(createElement(PaymentSecurityFooter, { showKashier: true }));
    expect(html).toContain('بوابة دفع آمنة مقدمة من');
    expect(html).toContain('Kashier');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/refund"');
    expect(html).toContain('href="/privacy"');
  });

  it('disables payment method options when a payment is locked in progress', () => {
    const html = renderWithProviders(
      createElement(PaymentMethodSelector, {
        methods: ['card', 'wallet'],
        active: 'card',
        disabled: true,
        onSelect: () => undefined,
      }),
    );
    expect(html).toContain('data-disabled="true"');
  });
});
