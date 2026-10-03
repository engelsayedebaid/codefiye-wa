import { estimateDuration, rotationIndex, rotationSplit } from '@wa/shared';
import { describe, expect, it } from 'vitest';
import { planRecipients, scheduleBroadcast } from '../src/lib/broadcast';

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

  it('estimates from the busiest session', () => {
    // 10 recipients over 2 sessions → 5 each → 4 gaps of 15s on `normal`.
    expect(estimateDuration(10, 2, 1, 'normal')).toBe(60);
    expect(estimateDuration(1, 1, 1, 'safe')).toBe(0);
  });
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
  const now = Date.UTC(2026, 9, 4, 12);

  it('rotates sessions and spaces each one by the pace gap', () => {
    const rows = scheduleBroadcast(recipients(4), ['a', 'b'], { rotateEvery: 1, pace: 'normal', now, backlog: new Map(), random: (min) => min });
    expect(rows.map((r) => [r.sessionId, r.notBefore!.getTime() - now])).toEqual([
      ['a', 0],
      ['b', 0],
      ['a', 10_000],
      ['b', 10_000],
    ]);
  });

  it('queues a card and its poll at the same time', () => {
    const rows = scheduleBroadcast(recipients(2, true), ['a'], { rotateEvery: 1, pace: 'safe', now, backlog: new Map(), random: (min) => min });
    expect(rows.map((r) => [r.content.type, r.notBefore!.getTime() - now])).toEqual([
      ['text', 0],
      ['poll', 0],
      ['text', 25_000],
      ['poll', 25_000],
    ]);
  });

  it('starts after what a session already has scheduled', () => {
    const rows = scheduleBroadcast(recipients(1), ['a'], { rotateEvery: 1, pace: 'normal', now, backlog: new Map([['a', now + 60_000]]), random: (min) => min });
    expect(rows[0]!.notBefore!.getTime() - now).toBe(70_000);
  });

  it('leaves `fast` to the worker', () => {
    const rows = scheduleBroadcast(recipients(3), ['a', 'b'], { rotateEvery: 2, pace: 'fast', now, backlog: new Map() });
    expect(rows.map((r) => [r.sessionId, r.notBefore])).toEqual([
      ['a', null],
      ['a', null],
      ['b', null],
    ]);
  });
});
