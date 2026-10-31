/** Product identity in one place — copy lives in i18n/. */
export const BRAND = {
  name: 'WA CodeFiye',
  supportEmail: 'support@example.com',
} as const;

/** The numbers in the exchange & refund policy (/refund); the copy in i18n/ reads them from here. */
export const POLICY = {
  /** A paid plan that wasn't used can be refunded in full within this many days of payment. */
  refundDays: 7,
  /** We answer a refund request, and start paying it back, within this many business days. */
  refundReplyWorkDays: 3,
  /** Card and wallet refunds reach the customer within this many business days (the bank's part). */
  refundBankWorkDays: 14,
} as const;
