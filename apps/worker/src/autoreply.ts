import { randomInt } from 'node:crypto';
import {
  countChatReplies,
  loadAutoReplySettings,
  notify,
  queueAutoReply,
  recentChatLines,
  recordAutoReply,
  type Sql,
} from '@wa/db';
import {
  AI_PROVIDERS,
  type AiMessage,
  type AiProviderId,
  type ReplyLanguage,
  buildSystemPrompt,
  CHANNELS,
  detectLanguage,
  formatForWhatsApp,
  matchRule,
  type AutoReplySettings,
} from '@wa/shared';
import type { Logger } from 'pino';
import { AiKeyManager } from './ai-key-manager';

/**
 * The AI auto-reply agent: an inbound message comes in, the agent decides whether to answer, asks a
 * model what to say, and puts the answer in the session's send queue.
 *
 * It runs inside the worker, because the worker owns the socket and the send queue: the answer
 * goes out like any other message (paced, with "typing…", tracked with a receipt).
 *
 * The agent never invents: it only answers a message it was sent, and it stops when its number is
 * switched off, when the contact is on the ignore list, outside the business hours, or when the
 * conversation already got as many answers as it may.
 */

/** How many messages of the conversation the model sees. */
const CONTEXT_MESSAGES = 20;
/** How long a model may take before the answer is given up on. */
const MODEL_TIMEOUT_MS = 45_000;
/** The settings are read once per burst of messages, not once per message. */
const SETTINGS_TTL_MS = 30_000;
/**
 * The span `maxReplies` counts over. A loop with another bot answers within seconds, so it hits the
 * cap in a minute or two; a person asking questions is answered again once the window has passed.
 */
const REPLY_CAP_WINDOW_MS = 10 * 60_000;
/** `not_before` is the database's clock: wake a little after it, so the row is due when claimed. */
const WAKE_MARGIN_MS = 250;
export type AutoReplyInput = {
  sessionId: string;
  workspaceId: string;
  /** The inbound message's row id. */
  messageId: number;
  /** The chat the message came to (the contact's JID). */
  chatJid: string;
  /** The sender (the contact's JID; a group's member). */
  from: string;
  isGroup: boolean;
  text: string | null;
  /** True when the message came from the phone's history, not from a live chat. */
  history: boolean;
  /** Starts the session's send queue (the runner's own drain), so a delayed answer leaves on time. */
  wake?: () => void;
};

type Cached<T> = { value: T; at: number };

/** What the runner needs from the agent (the class itself, or a stub in the tests). */
export type AutoReplyHandler = Pick<AutoReplyAgent, 'handle'>;

export class AutoReplyAgent {
  private readonly settings = new Map<string, Cached<AutoReplySettings | null>>();
  private readonly keyManager: AiKeyManager;

  constructor(
    private readonly deps: { sql: Sql; log: Logger; masterKey: Buffer },
  ) {
    this.keyManager = new AiKeyManager({ sql: deps.sql, masterKey: deps.masterKey, log: deps.log });
  }

  /** The agent's answer to one inbound message; never throws (a failure is logged, not raised). */
  async handle(input: AutoReplyInput): Promise<void> {
    const { log } = this.deps;
    try {
      await this.answer(input);
    } catch (err) {
      log.error({ err, sessionId: input.sessionId }, 'auto-reply failed');
    }
  }

  private async answer(input: AutoReplyInput) {
    const { sql, log } = this.deps;
    const started = Date.now();
    const timings: Record<string, number> = {};

    const settings = await this.loadSettings(input.sessionId);
    timings.loadSettings = Date.now() - started;
    if (!settings?.enabled) return; // the number answers on its own: off
    if (input.history) return this.skip(input, settings, 'history', 'en');
    if (input.isGroup) return this.skip(input, settings, 'group', 'en');
    const text = input.text?.trim() ?? '';
    if (!text) return this.skip(input, settings, 'no_words', 'en');
    const language: ReplyLanguage = settings.language === 'auto' ? detectLanguage(text) : settings.language;
    if (this.ignored(settings, input)) return this.skip(input, settings, 'ignored', language);
    if (!this.withinHours(settings)) return this.skip(input, settings, 'outside_hours', language);

    // The cap that stops a loop with another bot: this conversation got its answers already.
    if (settings.maxReplies > 0) {
      const checkStart = Date.now();
      const answered = await countChatReplies(sql, input.sessionId, input.chatJid, REPLY_CAP_WINDOW_MS);
      timings.checkReplies = Date.now() - checkStart;
      if (answered >= settings.maxReplies) return this.skip(input, settings, 'limit_reached', language);
    }

    const rule = matchRule(text, settings.rules);
    if (rule) {
      // A canned answer goes out as it is: no model, no cost.
      await this.send(input, settings, rule.reply, language, '', '', 0, started);
      log.info({ sessionId: input.sessionId, timings, totalMs: Date.now() - started }, 'auto-reply: rule matched');
      return;
    }

    const historyStart = Date.now();
    const system = buildSystemPrompt(settings, language);
    const history = await recentChatLines(sql, input.sessionId, input.chatJid, CONTEXT_MESSAGES, input.messageId);
    timings.loadHistory = Date.now() - historyStart;
    const messages: AiMessage[] = [...history, { role: 'user', content: text }];

    const aiStart = Date.now();
    const first = await this.ask(settings.providerId, settings.model, system, messages, settings);
    timings.aiCall = Date.now() - aiStart;
    if (first) {
      await this.send(input, settings, first.text, language, first.provider, first.model, Date.now() - aiStart, started);
      log.info({ sessionId: input.sessionId, timings, totalMs: Date.now() - started }, 'auto-reply: AI answered');
      return;
    }

    await recordAutoReply(sql, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      chatJid: input.chatJid,
      provider: settings.providerId,
      model: settings.model,
      language,
      reply: '',
      status: 'failed',
      reason: 'The AI provider did not answer',
      latencyMs: Date.now() - started,
    });
    log.warn({ sessionId: input.sessionId, provider: settings.providerId, timings, totalMs: Date.now() - started }, 'auto-reply: no provider answered');
  }

  /** Asks one provider with automatic key selection and failover; null when it failed. */
  private async ask(
    providerId: AiProviderId,
    model: string,
    system: string,
    messages: AiMessage[],
    settings: AutoReplySettings,
  ): Promise<{ text: string; provider: string; model: string } | null> {
    const { log } = this.deps;
    const info = AI_PROVIDERS[providerId];
    const chosen = model.trim() || info.defaultModel;

    const result = await this.keyManager.executeWithFailover({
      providerId,
      fallbackProviderId: settings.fallbackProviderId,
      fallbackModel: settings.fallbackModel,
      model: chosen,
      system,
      messages,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      timeoutMs: MODEL_TIMEOUT_MS,
    });

    if (!result) {
      log.warn({ provider: providerId, model: chosen }, 'auto-reply: no provider key answered');
      return null;
    }

    return { text: result.text, provider: result.provider, model: result.model };
  }

  /** Queues the answer and records what happened. */
  private async send(
    input: AutoReplyInput,
    settings: AutoReplySettings,
    text: string,
    language: ReplyLanguage,
    provider: string,
    model: string,
    latencyMs: number,
    messageReceivedAt: number,
  ) {
    const { sql, log } = this.deps;
    const body = text.trim();
    if (!body) return;

    // Format the text for WhatsApp (remove Markdown, clean formatting)
    const formattedBody = formatForWhatsApp(body);

    // A human types before answering; the queue sends it when the time comes.
    const lo = Math.min(settings.delayMinMs, settings.delayMaxMs);
    const hi = Math.max(settings.delayMinMs, settings.delayMaxMs);
    const gap = hi > lo ? randomInt(lo, hi + 1) : lo;
    const { id: messageId } = await queueAutoReply(sql, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      chatJid: input.chatJid,
      text: formattedBody,
      delayMs: gap,
    });

    // Calculate end-to-end latency: from message received to queued
    const endToEndLatencyMs = Date.now() - messageReceivedAt;

    await recordAutoReply(sql, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      chatJid: input.chatJid,
      provider,
      model,
      language,
      reply: formattedBody,
      status: 'sent',
      reason: null,
      latencyMs,
    });
    // The worker's own queue: start it when the pause is over. Left to the supervisor's tick, the
    // answer would wait up to another 5 s after its `not_before`.
    if (input.wake) {
      setTimeout(input.wake, gap + WAKE_MARGIN_MS).unref();
    } else {
      await notify(sql, CHANNELS.control, { type: 'message.queued', sessionId: input.sessionId }).catch(() =>
        log.warn({ sessionId: input.sessionId }, 'auto-reply: could not wake the send queue'),
      );
    }
    log.info(
      {
        sessionId: input.sessionId,
        messageId,
        provider,
        model,
        latencyMs,
        endToEndLatencyMs,
        queueDelayMs: gap,
      },
      'auto-reply answered',
    );
  }

  /** Records that the agent stayed quiet (only the interesting reasons are kept). */
  private async skip(input: AutoReplyInput, settings: AutoReplySettings, reason: string, language: ReplyLanguage) {
    if (!['outside_hours', 'limit_reached', 'ignored'].includes(reason)) return;
    await recordAutoReply(this.deps.sql, {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      messageId: input.messageId,
      chatJid: input.chatJid,
      provider: settings.providerId,
      model: settings.model,
      language,
      reply: '',
      status: 'skipped',
      reason,
      latencyMs: null,
    });
  }

  /** A number on the ignore list (by phone number or by JID). */
  private ignored(settings: AutoReplySettings, input: AutoReplyInput) {
    if (settings.ignoreList.length === 0) return false;
    const jid = input.from.split('@')[0] ?? input.from;
    return settings.ignoreList.some((entry) => {
      const value = entry.trim().toLowerCase();
      if (!value) return false;
      return value === jid.toLowerCase() || value === input.from.toLowerCase() || value.endsWith(jid.toLowerCase());
    });
  }

  /** Whether now is inside the business hours (in the number's time zone). */
  private withinHours(settings: AutoReplySettings) {
    if (!settings.businessHoursOnly) return true;
    let hour: number;
    try {
      const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: settings.timezone }).formatToParts(new Date());
      const raw = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
      hour = raw === 24 ? 0 : raw;
    } catch {
      return true; // an unknown time zone doesn't stop the agent
    }
    const { hoursStart, hoursEnd } = settings;
    if (hoursStart === hoursEnd) return true;
    // Hours that run past midnight (22 → 6) wrap around.
    return hoursStart < hoursEnd ? hour >= hoursStart && hour < hoursEnd : hour >= hoursStart || hour < hoursEnd;
  }

  /** The number's settings (cached briefly, so a burst of messages reads them once). */
  private async loadSettings(sessionId: string): Promise<AutoReplySettings | null> {
    const hit = this.settings.get(sessionId);
    if (hit && Date.now() - hit.at < SETTINGS_TTL_MS) return hit.value;
    const value = await loadAutoReplySettings(this.deps.sql, sessionId);
    this.settings.set(sessionId, { value, at: Date.now() });
    return value;
  }
}
