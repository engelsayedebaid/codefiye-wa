/**
 * The path of a request URL as it may appear in logs: no query string (search terms, filters) and
 * no phone numbers (e.g. `/api/on-whatsapp/+201012345678` → `/api/on-whatsapp/+***`).
 */
export function scrubUrl(url: string): string {
  const path = url.split('?')[0] ?? '';
  return path.replace(/\+?\d{7,}/g, (m) => `${m.startsWith('+') ? '+' : ''}***`);
}
