import { randomInt } from 'node:crypto';
import {
  BROADCAST_PACES,
  type BroadcastPace,
  isUserJid,
  type OutboundContent,
  POLL_LIMITS,
  renderTemplateParts,
  rotationIndex,
  type TemplateParts,
  type TemplateVariables,
  toJid,
} from '@wa/shared';

export type SkipReason = 'invalid_number' | 'duplicate' | 'missing_variables' | 'invalid_buttons';
export type PlannedRecipient = { jid: string; contents: OutboundContent[] };

const validPoll = (poll: { name: string; options: string[] }) =>
  poll.name.length > 0 &&
  poll.name.length <= POLL_LIMITS.question &&
  poll.options.every((o) => o.length > 0 && o.length <= POLL_LIMITS.option) &&
  new Set(poll.options).size === poll.options.length;

/**
 * Renders each recipient's copy: the text (or an image card with the text as caption) and, with
 * buttons, a poll right after. Invalid numbers, repeats and recipients missing a variable are left
 * out with the reason, so one bad row never blocks the whole campaign.
 */
export function planRecipients(template: TemplateParts, recipients: { to: string; variables?: TemplateVariables }[]) {
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

export type ScheduledMessage = { sessionId: string; jid: string; content: OutboundContent; notBefore: Date | null };

/**
 * Hands recipients to the sessions in turn, `rotateEvery` in a row each. Unless the pace is `fast`,
 * each session's messages are spaced by a random gap, starting after whatever that session already
 * has scheduled (`backlog`: its latest `not_before`, epoch ms). `now` comes from the database clock,
 * which is the one the worker's queue compares against.
 */
export function scheduleBroadcast(
  planned: PlannedRecipient[],
  sessionIds: string[],
  options: { rotateEvery: number; pace: BroadcastPace; now: number; backlog: ReadonlyMap<string, number>; random?: (min: number, max: number) => number },
): ScheduledMessage[] {
  const { min, max } = BROADCAST_PACES[options.pace];
  const random = options.random ?? randomInt;
  const gap = () => (max > min ? random(min * 1000, max * 1000 + 1) : min * 1000);
  const next = new Map(
    sessionIds.map((id) => {
      const last = options.backlog.get(id);
      return [id, last === undefined ? options.now : Math.max(options.now, last + gap())] as const;
    }),
  );
  const rows: ScheduledMessage[] = [];
  planned.forEach((recipient, i) => {
    const sessionId = sessionIds[rotationIndex(i, sessionIds.length, options.rotateEvery)]!;
    let notBefore: Date | null = null;
    if (max > 0) {
      const at = next.get(sessionId)!;
      notBefore = new Date(at);
      next.set(sessionId, at + gap());
    }
    // A card and its buttons poll go out together.
    for (const content of recipient.contents) rows.push({ sessionId, jid: recipient.jid, content, notBefore });
  });
  return rows;
}
