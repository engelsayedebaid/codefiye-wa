import {
  type BroadcastPace,
  isUserJid,
  jidToPhone,
  type OutboundContent,
  planSends,
  POLL_LIMITS,
  renderTemplateParts,
  rotationIndex,
  type SendingWindow,
  type TemplateParts,
  type TemplateVariables,
  toJid,
} from '@wa/shared';

export type SkipReason = 'invalid_number' | 'duplicate' | 'missing_variables' | 'invalid_buttons' | 'opted_out';
export type PlannedRecipient = { jid: string; contents: OutboundContent[] };

const validPoll = (poll: { name: string; options: string[] }) =>
  poll.name.length > 0 &&
  poll.name.length <= POLL_LIMITS.question &&
  poll.options.every((o) => o.length > 0 && o.length <= POLL_LIMITS.option) &&
  new Set(poll.options).size === poll.options.length;

/**
 * Renders each recipient's copy: the text (or an image card with the text as caption) and, with
 * buttons, a poll right after. Invalid numbers, repeats, recipients missing a variable and those who
 * replied "stop" (`optedOut`, E.164) are left out with the reason, so one bad row never blocks the
 * whole campaign.
 */
export function planRecipients(
  template: TemplateParts,
  recipients: { to: string; variables?: TemplateVariables }[],
  optedOut: ReadonlySet<string> = new Set(),
) {
  const seen = new Set<string>();
  const planned: PlannedRecipient[] = [];
  const skipped: { to: string; reason: SkipReason }[] = [];
  for (const { to, variables } of recipients) {
    const jid = toJid(to);
    if (!jid || !isUserJid(jid)) {
      skipped.push({ to, reason: 'invalid_number' });
      continue;
    }
    if (seen.has(jid)) {
      skipped.push({ to, reason: 'duplicate' });
      continue;
    }
    if (optedOut.has(jidToPhone(jid)!)) {
      seen.add(jid);
      skipped.push({ to, reason: 'opted_out' });
      continue;
    }
    const result = renderTemplateParts(template, variables);
    if (!result.rendered) {
      skipped.push({ to, reason: 'missing_variables' });
      continue;
    }
    const { text, imageUrl, poll } = result.rendered;
    if (poll && !validPoll(poll)) {
      skipped.push({ to, reason: 'invalid_buttons' });
      continue;
    }
    seen.add(jid);
    const main: OutboundContent = imageUrl ? { type: 'image', url: imageUrl, caption: text } : { type: 'text', text };
    planned.push({ jid, contents: poll ? [main, { type: 'poll', name: poll.name, options: poll.options, selectableCount: 1 }] : [main] });
  }
  return { planned, skipped };
}

export type ScheduledMessage = { sessionId: string; jid: string; content: OutboundContent; notBefore: Date };

/**
 * Hands recipients to the sessions in turn, `rotateEvery` in a row each, then plans each session's
 * share with the campaign shield (`planSends`): random gaps, rests between bursts, the number's daily
 * cap (lower while it warms up) and the sending window. `now` comes from the database clock, the one
 * the worker's queue compares against; `numbers` holds each session's age and campaign history.
 */
export function scheduleBroadcast(
  planned: PlannedRecipient[],
  sessionIds: string[],
  options: {
    rotateEvery: number;
    pace: BroadcastPace;
    window: SendingWindow | null;
    now: number;
    numbers: ReadonlyMap<string, { addedAt: number; history: readonly number[] }>;
    random?: (min: number, max: number) => number;
  },
): ScheduledMessage[] {
  const shares = new Map<string, number[]>(sessionIds.map((id) => [id, []]));
  planned.forEach((_, i) => shares.get(sessionIds[rotationIndex(i, sessionIds.length, options.rotateEvery)]!)!.push(i));

  const times: number[] = [];
  for (const [sessionId, indexes] of shares) {
    if (!indexes.length) continue;
    const number = options.numbers.get(sessionId) ?? { addedAt: options.now, history: [] };
    const slots = planSends({ ...number, count: indexes.length, pace: options.pace, window: options.window, now: options.now, random: options.random });
    indexes.forEach((recipient, k) => (times[recipient] = slots[k]!));
  }

  // In recipient order; a card and its buttons poll go out together.
  return planned.flatMap((recipient, i) => {
    const sessionId = sessionIds[rotationIndex(i, sessionIds.length, options.rotateEvery)]!;
    const notBefore = new Date(times[i]!);
    return recipient.contents.map((content) => ({ sessionId, jid: recipient.jid, content, notBefore }));
  });
}
