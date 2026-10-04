import { dailyCap, estimateFinish, isTimeZone, nextOpen, optOutReply, planSends, rotationIndex, rotationSplit, type SendingWindow } from '@wa/shared';
import { describe, expect, it } from 'vitest';
import { planRecipients, scheduleBroadcast } from '../src/lib/broadcast';

const SECOND = 1_000;
const DAY = 86_400_000;
const lowest = (min: number) => min;
const now = Date.UTC(2026, 9, 4, 12);
/** An established number: no warm-up. */
const old = now - 30 * DAY;

describe('rotation', () => {
  it('switches session every `rotateEvery` recipients and wraps around', () => {
    expect(Array.from({ length: 7 }, (_, i) => rotationIndex(i, 3, 1))).toEqual([0, 1, 2, 0, 1, 2, 0]);
    expect(Array.from({ length: 7 }, (_, i) => rotationIndex(i, 2, 3))).toEqual([0, 0, 0, 1, 1, 1, 0]);
  });

  it('splits recipients between sessions', () => {
    expect(rotationSplit(10, 3, 1)).toEqual([4, 3, 3]);
    expect(rotationSplit(10, 2, 5)).toEqual([5, 5]);
    expect(rotationSplit(3, 4, 1)).toEqual([1, 1, 1, 0]);
  });
});

describe('dailyCap', () => {
  it('warms new numbers up before the pace’s own cap applies', () => {
    expect(dailyCap('fast', now, now + DAY)).toBe(40);
    expect(dailyCap('fast', now, now + 5 * DAY)).toBe(100);
    expect(dailyCap('fast', now, now + 8 * DAY)).toBe(400);
    expect(dailyCap('safe', now, now + 8 * DAY)).toBe(150);
    expect(dailyCap('safe', now, now + DAY)).toBe(40);
  });
});

describe('nextOpen', () => {
  // Riyadh is UTC+3 all year.
  const riyadh: SendingWindow = { from: 9, to: 21, timeZone: 'Asia/Riyadh' };

  it('keeps a time inside the window', () => expect(nextOpen(Date.UTC(2026, 9, 4, 17, 59), riyadh)).toBe(Date.UTC(2026, 9, 4, 17, 59)));

  it('moves the evening to the next morning, and the night to the same morning', () => {
    expect(nextOpen(Date.UTC(2026, 9, 4, 18, 0, 42), riyadh)).toBe(Date.UTC(2026, 9, 5, 6, 0));
    expect(nextOpen(Date.UTC(2026, 9, 4, 0, 30), riyadh)).toBe(Date.UTC(2026, 9, 4, 6, 0));
  });

  it('lands on local opening time across a daylight-saving change', () => {
    // Berlin leaves summer time on 2026-10-25: 09:00 that morning is 08:00 UTC, not 07:00.
    expect(nextOpen(Date.UTC(2026, 9, 24, 20, 0), { from: 9, to: 21, timeZone: 'Europe/Berlin' })).toBe(Date.UTC(2026, 9, 25, 8, 0));
  });

  it('knows real time zones', () => {
    expect(isTimeZone('Africa/Cairo')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
  });
});

describe('planSends', () => {
  const plan = (count: number, extra: Partial<Parameters<typeof planSends>[0]> = {}) =>
    planSends({ count, pace: 'safe', window: null, addedAt: old, now, random: lowest, ...extra }).map((t) => t - now);

  it('spaces recipients by the gap and rests after each burst', () => {
    // safe: 30 s apart, a 10-minute rest after 15.
    expect(plan(17)).toEqual([...Array.from({ length: 15 }, (_, i) => i * 30 * SECOND), 1_020 * SECOND, 1_050 * SECOND]);
  });

  it('never exceeds the daily cap in any 24 hours: the rest waits for the next day', () => {
    const times = plan(152);
    expect(times[149]).toBeLessThan(DAY);
    expect(times[150]).toBe(DAY + 30 * SECOND);
    expect(times[151]).toBe(DAY + 60 * SECOND);
  });

  it('holds a new number to its warm-up cap', () => {
    const times = plan(41, { addedAt: now });
    expect(times[39]).toBeLessThan(DAY);
    expect(times[40]).toBe(DAY + 30 * SECOND);
  });

  it('counts what the number already sent and scheduled', () => {
    // 150 sends in the last hours (fills the cap) → nothing new until the first of them is a day old.
    const history = Array.from({ length: 150 }, (_, i) => now - 5 * 3_600_000 + i * 60 * SECOND);
    expect(plan(1, { history })[0]).toBe(history[0]! + DAY - now + 30 * SECOND);
    // A schedule running into the future: start after its last message.
    expect(plan(1, { history: [now + 60 * SECOND] })).toEqual([90 * SECOND]);
  });

  it('carries the current burst over from the history', () => {
    const history = Array.from({ length: 14 }, (_, i) => now - (14 - i) * 30 * SECOND);
    // The 15th of the burst goes now, then the number rests.
    expect(plan(2, { history })).toEqual([0, 600 * SECOND]);
  });

  it('sends only inside the window, starting each morning a gap after opening', () => {
    const riyadh: SendingWindow = { from: 9, to: 21, timeZone: 'Asia/Riyadh' };
    const at = (h: number, m: number, s = 0, day = 4) => Date.UTC(2026, 9, day, h, m, s);
    // 20:59 local: two fit before 21:00, the third goes the next morning.
    expect(planSends({ count: 3, pace: 'safe', window: riyadh, addedAt: old, now: at(17, 59), random: lowest })).toEqual([at(17, 59), at(17, 59, 30), at(6, 0, 30, 5)]);
    // 22:00 local: nothing before the morning.
    expect(planSends({ count: 1, pace: 'safe', window: riyadh, addedAt: old, now: at(19, 0), random: lowest })).toEqual([at(6, 0, 30, 5)]);
  });

  it('estimates a campaign from its busiest number', () => {
    const finish = estimateFinish(
      [
        { count: 10, addedAt: old },
        { count: 30, addedAt: old },
      ],
      { pace: 'safe', window: null, now },
    );
    const average = (min: number, max: number) => (min + max) / 2;
    expect(finish).toBe(planSends({ count: 30, pace: 'safe', window: null, addedAt: old, now, random: average }).at(-1));
  });
});

describe('optOutReply', () => {
  it.each(['STOP', ' stop ', 'إلغاء', 'الغاء الاشتراك', 'توقّف!', 'ايقاف', 'Unsubscribe'])('%j stops', (text) => expect(optOutReply(text)).toBe('out'));
  it.each(['start', 'اشتراك'])('%j starts again', (text) => expect(optOutReply(text)).toBe('in'));
  it.each(['لا تتوقف عن العروض', 'stop sending me the old price list please', 'شكراً', '', null])('%j is a normal reply', (text) => expect(optOutReply(text)).toBeNull());
});

describe('planRecipients', () => {
  it('renders each copy and drops invalid, repeated and incomplete recipients', () => {
    const { planned, skipped } = planRecipients({ body: 'Hi {{name}}' }, [
      { to: '+201012345678', variables: { name: 'Sara' } },
      { to: '201012345678', variables: { name: 'Again' } },
      { to: '0101234', variables: { name: 'Local' } },
      { to: '+201098765432' },
      { to: '+201011111111', variables: { name: 'Omar' } },
    ]);
    expect(planned).toEqual([
      { jid: '201012345678@s.whatsapp.net', contents: [{ type: 'text', text: 'Hi Sara' }] },
      { jid: '201011111111@s.whatsapp.net', contents: [{ type: 'text', text: 'Hi Omar' }] },
    ]);
    expect(skipped).toEqual([
      { to: '201012345678', reason: 'duplicate' },
      { to: '0101234', reason: 'invalid_number' },
      { to: '+201098765432', reason: 'missing_variables' },
    ]);
  });

  it('leaves out recipients who replied stop', () => {
    const { planned, skipped } = planRecipients({ body: 'Sale' }, [{ to: '+201012345678' }, { to: '00201011111111' }], new Set(['+201011111111']));
    expect(planned.map((p) => p.jid)).toEqual(['201012345678@s.whatsapp.net']);
    expect(skipped).toEqual([{ to: '00201011111111', reason: 'opted_out' }]);
  });

  it('sends a card with its buttons poll right after', () => {
    const { planned } = planRecipients({ body: 'Sale', imageUrl: 'https://x.test/a.jpg', buttons: ['Yes', 'No'], buttonsTitle: 'Interested?' }, [{ to: '+201012345678' }]);
    expect(planned[0]!.contents).toEqual([
      { type: 'image', url: 'https://x.test/a.jpg', caption: 'Sale' },
      { type: 'poll', name: 'Interested?', options: ['Yes', 'No'], selectableCount: 1 },
    ]);
  });

  it('lets a later row of the same number stand in for an incomplete one', () => {
    const { planned, skipped } = planRecipients({ body: 'Hi {{name}}' }, [{ to: '+201012345678' }, { to: '+201012345678', variables: { name: 'Sara' } }]);
    expect(planned).toHaveLength(1);
    expect(skipped).toEqual([{ to: '+201012345678', reason: 'missing_variables' }]);
  });
});

describe('scheduleBroadcast', () => {
  const recipients = (n: number, polls = false) =>
    Array.from({ length: n }, (_, i) => ({
      jid: `2010000000${i}@s.whatsapp.net`,
      contents: polls ? [{ type: 'text' as const, text: 'a' }, { type: 'poll' as const, name: 'q', options: ['x', 'y'], selectableCount: 1 }] : [{ type: 'text' as const, text: 'a' }],
    }));
  const numbers = (history: Record<string, number[]> = {}) => new Map(['a', 'b'].map((id) => [id, { addedAt: old, history: history[id] ?? [] }]));

  it('rotates sessions and spaces each one by its pace', () => {
    const rows = scheduleBroadcast(recipients(4), ['a', 'b'], { rotateEvery: 1, pace: 'normal', window: null, now, numbers: numbers(), random: lowest });
    expect(rows.map((r) => [r.sessionId, r.notBefore.getTime() - now])).toEqual([
      ['a', 0],
      ['b', 0],
      ['a', 15_000],
      ['b', 15_000],
    ]);
  });

  it('queues a card and its poll at the same time', () => {
    const rows = scheduleBroadcast(recipients(2, true), ['a'], { rotateEvery: 1, pace: 'safe', window: null, now, numbers: numbers(), random: lowest });
    expect(rows.map((r) => [r.content.type, r.notBefore.getTime() - now])).toEqual([
      ['text', 0],
      ['poll', 0],
      ['text', 30_000],
      ['poll', 30_000],
    ]);
  });

  it('starts after what a session already has scheduled', () => {
    const rows = scheduleBroadcast(recipients(1), ['a'], { rotateEvery: 1, pace: 'normal', window: null, now, numbers: numbers({ a: [now + 60_000] }), random: lowest });
    expect(rows[0]!.notBefore.getTime() - now).toBe(75_000);
  });

  it('paces `fast` too', () => {
    const rows = scheduleBroadcast(recipients(3), ['a', 'b'], { rotateEvery: 2, pace: 'fast', window: null, now, numbers: numbers(), random: lowest });
    expect(rows.map((r) => [r.sessionId, r.notBefore.getTime() - now])).toEqual([
      ['a', 0],
      ['a', 8_000],
      ['b', 0],
    ]);
  });
});
