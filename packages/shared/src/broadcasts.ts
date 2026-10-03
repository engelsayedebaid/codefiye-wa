/**
 * Bulk "ads" campaigns sent by admins (`/api/admin/broadcasts`, dashboard `/ads`). Zod-free so the
 * dashboard can import it to preview the split and the finish time before launching.
 */

/** Per campaign. 5 000 recipients with a few variables each stay well under the API's 1 MB body limit. */
export const BROADCAST_LIMITS = { recipients: 5_000, sessions: 50, rotateEvery: 1_000 } as const;

export const BROADCAST_PACE_IDS = ['safe', 'normal', 'fast'] as const;
export type BroadcastPace = (typeof BROADCAST_PACE_IDS)[number];

/**
 * Seconds between two messages from the same session, picked at random in the range so the rhythm
 * doesn't look automated. `fast` adds nothing on top of the worker's own pacing (SEND_DELAY_*_MS).
 */
export const BROADCAST_PACES: Record<BroadcastPace, { min: number; max: number }> = {
  safe: { min: 25, max: 45 },
  normal: { min: 10, max: 20 },
  fast: { min: 0, max: 0 },
};

/** The session (index into the chosen ones) that sends the i-th recipient: `rotateEvery` in a row, then the next. */
export const rotationIndex = (i: number, sessions: number, rotateEvery: number) => Math.floor(i / Math.max(1, rotateEvery)) % Math.max(1, sessions);

/** How many recipients each session gets. */
export function rotationSplit(recipients: number, sessions: number, rotateEvery: number): number[] {
  const counts = Array.from({ length: Math.max(1, sessions) }, () => 0);
  for (let i = 0; i < recipients; i++) counts[rotationIndex(i, sessions, rotateEvery)]! += 1;
  return counts;
}

/** Rough duration in seconds: the busiest session sends one message per average gap. */
export function estimateDuration(recipients: number, sessions: number, rotateEvery: number, pace: BroadcastPace): number {
  const busiest = Math.max(0, ...rotationSplit(recipients, sessions, rotateEvery));
  const { min, max } = BROADCAST_PACES[pace];
  // `fast`: about two seconds per message (the worker's default gap plus typing).
  const gap = max > 0 ? (min + max) / 2 : 2;
  return Math.max(0, busiest - 1) * gap;
}
