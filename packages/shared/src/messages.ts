import { z } from 'zod';
import { POLL_LIMITS } from './template-text';
import { templateName, templateVariablesInput } from './templates';

/** The message an outbound message replies to (chats page): enough for WhatsApp to show the quote. */
export type OutboundQuote = { id: string; fromMe: boolean; participant?: string; text?: string | null };

/** Provider-agnostic outbound content. Stored in `messages.content` and consumed by workers. */
export type OutboundContent = (
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; caption?: string }
  | { type: 'video'; url: string; caption?: string }
  | { type: 'audio'; url: string; ptt?: boolean }
  | { type: 'document'; url: string; fileName?: string; mimetype?: string; caption?: string }
  | { type: 'sticker'; url: string }
  | { type: 'location'; latitude: number; longitude: number; name?: string; address?: string }
  | { type: 'contact'; name: string; phone: string }
  /** WhatsApp poll; `selectableCount` 0 = any number of answers. Votes land in `content.votes` (voter → chosen options). */
  | { type: 'poll'; name: string; options: string[]; selectableCount: number }
) & { quote?: OutboundQuote };

const httpUrl = z.url({ protocol: /^https?$/, error: 'Must be an http(s) URL' });

/** Media kinds that can't be combined with each other in one request. */
const EXCLUSIVE = ['imageUrl', 'videoUrl', 'audioUrl', 'documentUrl', 'stickerUrl', 'location', 'contact', 'poll'] as const;

/** WhatsApp poll — also how we offer tap-to-choose "buttons" (real buttons need the official Cloud API). */
export const pollInput = z.object({
  question: z.string().trim().min(1).max(POLL_LIMITS.question),
  options: z
    .array(z.string().trim().min(1).max(POLL_LIMITS.option))
    .min(POLL_LIMITS.minOptions)
    .max(POLL_LIMITS.maxOptions)
    .refine((options) => new Set(options).size === options.length, 'Options must be unique'),
  multiSelect: z.boolean().optional().describe('Allow choosing more than one option'),
});

/**
 * `POST /api/send-message` body — WasenderAPI-compatible: the type is inferred from which field is present.
 * `text` is the message for plain text, or the caption for image/video/document. Instead of `text`, a
 * saved `template` (by name) can be rendered with `variables`; the route turns it into `text`.
 */
export const sendMessageBody = z
  .object({
    to: z.string().min(3).max(128).describe('E.164 number (+201012345678) or a JID'),
    text: z.string().min(1).max(65_536).optional(),
    imageUrl: httpUrl.optional(),
    videoUrl: httpUrl.optional(),
    audioUrl: httpUrl.optional(),
    documentUrl: httpUrl.optional(),
    stickerUrl: httpUrl.optional(),
    fileName: z.string().min(1).max(255).optional(),
    mimetype: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/).optional(),
    ptt: z.boolean().optional().describe('Send audio as a voice note'),
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        name: z.string().max(256).optional(),
        address: z.string().max(512).optional(),
      })
      .optional(),
    contact: z.object({ name: z.string().min(1).max(256), phone: z.string().min(5).max(32) }).optional(),
    poll: pollInput.optional().describe('Send a poll: tap-to-choose options the recipient answers'),
    template: templateName.optional().describe('Name of a saved template to use as the text (or caption)'),
    variables: templateVariablesInput.optional().describe('Values for the template placeholders, e.g. { "code": "123456" }'),
  })
  .superRefine((body, ctx) => {
    const present = EXCLUSIVE.filter((k) => body[k] !== undefined);
    if (present.length > 1) {
      ctx.addIssue({ code: 'custom', path: [present[1]!], message: `Cannot be combined with ${present[0]}` });
    }
    if (body.template !== undefined && body.text !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['template'], message: 'Cannot be combined with text' });
    }
    if (body.poll !== undefined && (body.text !== undefined || body.template !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['poll'], message: 'Cannot be combined with text or template' });
    }
    if (present.length === 0 && body.text === undefined && body.template === undefined) {
      ctx.addIssue({ code: 'custom', path: ['text'], message: 'Provide text, a template, or one media field' });
    }
  });

export type SendMessageBody = z.infer<typeof sendMessageBody>;

export function toOutboundContent(body: SendMessageBody): OutboundContent {
  const caption = body.text;
  if (body.imageUrl) return { type: 'image', url: body.imageUrl, caption };
  if (body.videoUrl) return { type: 'video', url: body.videoUrl, caption };
  if (body.audioUrl) return { type: 'audio', url: body.audioUrl, ptt: body.ptt };
  if (body.documentUrl) {
    return { type: 'document', url: body.documentUrl, fileName: body.fileName, mimetype: body.mimetype, caption };
  }
  if (body.stickerUrl) return { type: 'sticker', url: body.stickerUrl };
  if (body.location) return { type: 'location', ...body.location };
  if (body.contact) return { type: 'contact', ...body.contact };
  if (body.poll) return { type: 'poll', name: body.poll.question, options: body.poll.options, selectableCount: body.poll.multiSelect ? 0 : 1 };
  return { type: 'text', text: body.text! };
}
