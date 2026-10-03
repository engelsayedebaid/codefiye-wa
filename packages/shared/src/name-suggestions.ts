/** Session-name helper with no dependencies, shared by the API's conflict response and the dashboard. */

/** Matches `sessions.name` validation (routes allow 1–100 chars). */
export const NAME_MAX = 100;

const NUMBERED = /^(.*?)[ _-](\d+)$/;

/**
 * Free names closest to `wanted`: its stem plus the smallest unused counter, so "Shop" taken
 * suggests "Shop 2", "Shop 3"… and a taken "Shop 2" continues from "Shop 3". Comparison is
 * case-insensitive, matching the unique index on sessions.
 */
export function suggestNames(wanted: string, taken: Iterable<string>, max = 3): string[] {
  const used = new Set([...taken].map((name) => name.trim().toLowerCase()));
  const trimmed = wanted.trim();
  const numbered = NUMBERED.exec(trimmed);
  const stem = (numbered?.[1]?.trim() || trimmed).slice(0, NAME_MAX);
  const start = numbered ? Number(numbered[2]) + 1 : 2;
  const out: string[] = [];
  for (let n = start; out.length < max && n < start + 100; n++) {
    const suffix = ` ${n}`;
    const name = stem.slice(0, NAME_MAX - suffix.length) + suffix;
    if (!used.has(name.toLowerCase()) && name.toLowerCase() !== trimmed.toLowerCase()) out.push(name);
  }
  return out;
}
