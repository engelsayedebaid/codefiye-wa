import { z } from 'zod';
import { isJid } from './jid';

export const recipientSchema = z
  .string()
  .trim()
  .refine((v) => isJid(v) || /^\+?\d{7,15}$/.test(v.replace(/[\s-]/g, '')), {
    message: 'Must be an E.164 phone number or a WhatsApp JID',
  });

const url = z.url();

export const sendMessageSchema = z
  .object({
    to: recipientSchema,
    text: z.string().min(1).max(65536).optional(),
    imageUrl: url.optional(),
    videoUrl: url.optional(),
    audioUrl: url.optional(),
    documentUrl: url.optional(),
    stickerUrl: url.optional(),
    fileName: z.string().max(255).optional(),
    mimetype: z.string().max(127).optional(),
    location: z
      .object({
        latitude: z.number().min(-90).max(90),
        longitude: z.number().min(-180).max(180),
        name: z.string().max(255).optional(),
        address: z.string().max(1024).optional(),
      })
      .optional(),
    contact: z
      .object({
        name: z.string().min(1).max(255),
        phone: z.string().regex(/^\+?\d{7,15}$/),
      })
      .optional(),
  })
  .superRefine((body, ctx) => {
    const kinds = (['imageUrl', 'videoUrl', 'audioUrl', 'documentUrl', 'stickerUrl', 'location', 'contact'] as const).filter(
      (k) => body[k] !== undefined,
    );
    if (kinds.length > 1) ctx.addIssue({ code: 'custom', message: `Only one of ${kinds.join(', ')} is allowed`, path: [kinds[1]!] });
    if (kinds.length === 0 && !body.text) ctx.addIssue({ code: 'custom', message: 'text is required', path: ['text'] });
  });

export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const createSessionSchema = z.object({
  name: z.string().trim().min(1).max(100),
  phone: z.string().regex(/^\+?\d{7,15}$/).optional(),
});

export const pairingCodeSchema = z.object({
  phone: z.string().regex(/^\+?\d{7,15}$/),
});
