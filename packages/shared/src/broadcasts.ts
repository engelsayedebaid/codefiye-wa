/**
 * Bulk "ads" campaigns (`/api/broadcasts`, dashboard `/ads`) and the shield that paces them so the
 * sending numbers keep their reputation (README §10). Zod-free and dependency-free: the API plans a
 * campaign with it, the worker re-plans one after a number fell behind, the dashboard previews it.
 */

/** Per campaign. 5 000 recipients with a few variables each stay well under the API's 1 MB body limit. */
export const BROADCAST_LIMITS = { recipients: 5_000, sessions: 50, rotateEvery: 1_000 } as const;

export const BROADCAST_PACE_IDS = ['safe', 'normal', 'fast'] as const;
export type BroadcastPace = (typeof BROADCAST_PACE_IDS)[number];

export type Range = { min: number; max: number };

/**
 * How one number sends a campaign. Every value is drawn at random in its range so the rhythm doesn't
 * look automated: `gap` seconds between two recipients, a `rest` (seconds) after every `burst`
 * recipients, and at most `daily` recipients in any 24 hours — a longer list carries on the next day.
 */
export type PaceProfile = { gap: Range; burst: Range; rest: Range; daily: number };

export const BROADCAST_PACES: Record<BroadcastPace, PaceProfile> = {
  safe: { gap: { min: 30, max: 60 }, burst: { min: 15, max: 25 }, rest: { min: 10 * 60, max: 20 * 60 }, daily: 150 },
  normal: { gap: { min: 15, max: 35 }, burst: { min: 25, max: 40 }, rest: { min: 5 * 60, max: 12 * 60 }, daily: 300 },
  fast: { gap: { min: 8, max: 15 }, burst: { min: 40, max: 60 }, rest: { min: 3 * 60, max: 6 * 60 }, daily: 400 },
};

/** A number new to the platform warms up: at most `daily` recipients a day until it is `days` old. */
export const WARMUP = [
  { days: 3, daily: 40 },
  { days: 7, daily: 100 },
] as const;

const DAY_MS = 86_400_000;

/** Recipients a number may reach in the 24 hours before `at`: the pace's cap, lower while it warms up. */
export function dailyCap(pace: BroadcastPace, addedAt: number, at: number): number {
  const age = (at - addedAt) / DAY_MS;
  const warmup = WARMUP.find((w) => age < w.days);
  return Math.min(BROADCAST_PACES[pace].daily, warmup?.daily ?? Number.POSITIVE_INFINITY);
}

/** True while a number added at `addedAt` is still warming up. */
export const isWarmingUp = (addedAt: number, at: number) => at - addedAt < WARMUP[WARMUP.length - 1]!.days * DAY_MS;

// --- sending window ----------------------------------------------------------------------------------

/** Local hours `[from, to)` in which a campaign sends, in an IANA time zone; the rest waits for the morning. */
export type SendingWindow = { from: number; to: number; timeZone: string };
export const DEFAULT_SENDING_HOURS = { from: 9, to: 21 } as const;

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const clocks = new Map<string, Intl.DateTimeFormat>();

/** Minutes since local midnight at `at` (epoch ms). */
function localMinutes(at: number, timeZone: string): number {
  let clock = clocks.get(timeZone);
  if (!clock) {
    clock = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', hour: 'numeric', minute: 'numeric' });
    clocks.set(timeZone, clock);
  }
  let minutes = 0;
  for (const part of clock.formatToParts(at)) {
    if (part.type === 'hour') minutes += (Number(part.value) % 24) * 60;
    else if (part.type === 'minute') minutes += Number(part.value);
  }
  return minutes;
}

/** `at` when it falls inside the window, else when the window next opens (to the minute). */
export function nextOpen(at: number, window: SendingWindow): number {
  const open = window.from * 60;
  const close = window.to * 60;
  let t = at;
  // Another pass corrects for a daylight-saving change in between.
  for (let pass = 0; pass < 3; pass++) {
    const now = localMinutes(t, window.timeZone);
    if (now >= open && now < close) return t;
    t = t - (t % 60_000) + (now < open ? open - now : 1440 - now + open) * 60_000;
  }
  return t;
}

// --- planning --------------------------------------------------------------------------------------

export type PlanInput = {
  /** Recipients to place, in sending order. */
  count: number;
  pace: BroadcastPace;
  window: SendingWindow | null;
  /** When the number was added (epoch ms), for the warm-up. */
  addedAt: number;
  /** Earliest send (epoch ms), from the database clock: the one the worker's queue compares against. */
  now: number;
  /**
   * Campaign recipients the number reached in the last 24 hours or has scheduled already (epoch ms,
   * ascending). They count toward the daily cap; the latest ones toward the gap and the current burst.
   */
  history?: readonly number[];
  /** A value in `[min, max]`; Math.random by default. */
  random?: (min: number, max: number) => number;
};

/**
 * When each recipient goes out (epoch ms, ascending): a random gap between two, a rest after each
 * burst, never more than the daily cap in any 24 hours, and only inside the sending window.
 */
export function planSends(input: PlanInput): number[] {
  const { gap, burst, rest } = BROADCAST_PACES[input.pace];
  const random = input.random ?? ((min: number, max: number) => min + Math.random() * (max - min));
  const draw = (range: Range) => Math.round(random(range.min, range.max) * 1000);
  const drawBurst = () => Math.max(1, Math.round(random(burst.min, burst.max)));
  const restMs = rest.min * 1000;

  const sent = [...(input.history ?? [])];
  let oldest = 0; // first entry of `sent` inside the 24 hours before the candidate
  let last = sent.at(-1);
  // Recipients since the number last paused as long as a rest.
  let streak = 0;
  for (let i = sent.length - 1; i >= 0; i--) {
    streak++;
    if (i === 0 || sent[i]! - sent[i - 1]! >= restMs) break;
  }
  let burstSize = drawBurst();
  let next = input.now;
  if (last !== undefined) {
    const resting = streak >= burstSize;
    next = Math.max(input.now, last + draw(resting ? rest : gap));
    if (resting) {
      streak = 0;
      burstSize = drawBurst();
    }
  }

  const times: number[] = [];
  for (let k = 0; k < input.count; k++) {
    let t = next;
    for (let pass = 0; pass < 50; pass++) {
      let moved = input.window ? nextOpen(t, input.window) : t;
      while (oldest < sent.length && sent[oldest]! <= moved - DAY_MS) oldest++;
      const cap = Math.max(1, dailyCap(input.pace, input.addedAt, moved));
      if (sent.length - oldest >= cap) moved = Math.max(moved, sent[sent.length - cap]! + DAY_MS);
      if (moved === t) break;
      // Waited for the window or the cap: add a gap so the numbers don't all start on the same minute.
      t = moved + draw(gap);
    }
    if (last !== undefined && t - last >= restMs) streak = 0;
    times.push(t);
    sent.push(t);
    last = t;
    streak++;
    if (streak >= burstSize) {
      streak = 0;
      burstSize = drawBurst();
      next = t + draw(rest);
    } else next = t + draw(gap);
  }
  return times;
}

/** The session (index into the chosen ones) that sends the i-th recipient: `rotateEvery` in a row, then the next. */
export const rotationIndex = (i: number, sessions: number, rotateEvery: number) => Math.floor(i / Math.max(1, rotateEvery)) % Math.max(1, sessions);

/** How many recipients each session gets. */
export function rotationSplit(recipients: number, sessions: number, rotateEvery: number): number[] {
  const counts = Array.from({ length: Math.max(1, sessions) }, () => 0);
  for (let i = 0; i < recipients; i++) counts[rotationIndex(i, sessions, rotateEvery)]! += 1;
  return counts;
}

/** When a campaign should finish (epoch ms): each number planned with average gaps and rests. */
export function estimateFinish(
  numbers: { count: number; addedAt: number; history?: readonly number[] }[],
  options: { pace: BroadcastPace; window: SendingWindow | null; now: number },
): number {
  const average = (min: number, max: number) => (min + max) / 2;
  let finish = options.now;
  for (const n of numbers) {
    if (n.count <= 0) continue;
    const times = planSends({ ...options, count: n.count, addedAt: n.addedAt, history: n.history, random: average });
    finish = Math.max(finish, times.at(-1) ?? finish);
  }
  return finish;
}

// --- the shield --------------------------------------------------------------------------------------

/** Why the shield stopped a number's queued campaign messages (`messages.error`); the dashboard words them. */
export const SHIELD_STOPS = {
  restricted: 'Stopped to protect the number: WhatsApp restricted it from starting new chats. Let it rest at least 24 hours.',
  loggedOut: 'Stopped to protect the number: it was logged out of WhatsApp.',
  failures: 'Stopped to protect the number after several failed sends in a row.',
  optedOut: 'Not sent: the recipient asked to stop receiving campaigns.',
} as const;
export type ShieldStop = keyof typeof SHIELD_STOPS;

/** How long a number rests from campaigns after WhatsApp restricted it. */
export const RESTRICTION_REST_MS = DAY_MS;

/** Letter variants, diacritics, punctuation and case don't matter in a keyword reply. */
function normalizeReply(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[إأآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const OPT_OUT_REPLIES = new Set(['stop', 'stop all', 'unsubscribe', 'توقف', 'وقف', 'ايقاف', 'الغاء', 'الغاء الاشتراك', 'الغي الاشتراك', 'لا اريد']);
const OPT_IN_REPLIES = new Set(['start', 'subscribe', 'اشتراك', 'اشترك', 'تفعيل']);

/** A reply asking to stop (`out`) or to start again (`in`) receiving campaigns. Only the whole message counts. */
export function optOutReply(text: string | null | undefined): 'out' | 'in' | null {
  if (!text || text.length > 40) return null;
  const reply = normalizeReply(text);
  return OPT_OUT_REPLIES.has(reply) ? 'out' : OPT_IN_REPLIES.has(reply) ? 'in' : null;
}
