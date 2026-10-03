import { and, asc, eq, messageTemplates, type MessageTemplate } from '@wa/db';
import { ok, POLL_LIMITS, successSchema, TEMPLATE_CATEGORIES, templateBody, templateName, templatePartsVariables } from '@wa/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps';
import { requirePat } from '../lib/auth';
import { ApiError, notFound, unprocessable } from '../lib/errors';

const tags = ['Templates'];

export const templateDto = z.object({
  id: z.uuid(),
  name: z.string(),
  category: z.enum(TEMPLATE_CATEGORIES),
  body: z.string(),
  imageUrl: z.string().nullable(),
  buttons: z.array(z.string()).nullable(),
  buttonsTitle: z.string().nullable(),
  variables: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const toTemplateDto = (t: MessageTemplate) => ({
  id: t.id,
  name: t.name,
  category: t.category,
  body: t.body,
  imageUrl: t.imageUrl,
  buttons: t.buttons,
  buttonsTitle: t.buttonsTitle,
  variables: templatePartsVariables(t),
  createdAt: t.createdAt.toISOString(),
  updatedAt: t.updatedAt.toISOString(),
});

/** Optional "card" parts: a header image and poll "buttons". `null` clears a part on update. */
const partsInput = {
  imageUrl: z.url({ protocol: /^https?$/, error: 'Must be an http(s) URL' }).max(2048).nullable().optional(),
  buttons: z.array(z.string().trim().min(1).max(POLL_LIMITS.option)).max(POLL_LIMITS.maxOptions).nullable().optional(),
  buttonsTitle: z.string().trim().max(POLL_LIMITS.question).nullable().optional(),
};

type Parts = { imageUrl: string | null; buttons: string[] | null; buttonsTitle: string | null };

/** Checks the parts together (they're only valid as a whole) and normalizes empties to null. */
function checkParts(parts: Parts): Parts {
  const buttons = parts.buttons?.length ? parts.buttons : null;
  if (buttons) {
    if (buttons.length < POLL_LIMITS.minOptions) throw unprocessable('Validation failed', { buttons: [`Add at least ${POLL_LIMITS.minOptions} buttons`] });
    if (new Set(buttons).size !== buttons.length) throw unprocessable('Validation failed', { buttons: ['Buttons must be different'] });
    if (!parts.buttonsTitle) throw unprocessable('Validation failed', { buttonsTitle: ['Required when the template has buttons'] });
  }
  return { imageUrl: parts.imageUrl || null, buttons, buttonsTitle: buttons ? parts.buttonsTitle : null };
}

const duplicateName = () => new ApiError(409, 'A template with this name already exists', { name: ['Already used by another template'] });
const isUniqueViolation = (err: unknown) => (err as { code?: string; cause?: { code?: string } }).code === '23505' || (err as { cause?: { code?: string } }).cause?.code === '23505';

/** CRUD for message templates. Sending uses them through `template` on /send-message and /send-otp. */
export function templateRoutes({ db }: Deps): FastifyPluginAsyncZod {
  return async (app) => {
    app.get(
      '/templates',
      { schema: { tags, summary: 'List templates', response: { 200: successSchema(z.array(templateDto)) } } },
      async (req) => {
        requirePat(req);
        const rows = await db.select().from(messageTemplates).where(eq(messageTemplates.workspaceId, req.auth.workspaceId)).orderBy(asc(messageTemplates.name));
        return ok(rows.map(toTemplateDto));
      },
    );

    app.post(
      '/templates',
      {
        schema: {
          tags,
          summary: 'Create a template',
          description:
            'Placeholders look like `{{code}}`. Send it with `POST /api/send-message` and `{ "template": "<name>", "variables": { … } }`. ' +
            'With `imageUrl` the text becomes the caption of an image "card"; `buttons` (2–12) are sent right after as a WhatsApp poll titled `buttonsTitle`.',
          body: z.object({ name: templateName, category: z.enum(TEMPLATE_CATEGORIES).default('custom'), body: templateBody, ...partsInput }),
          response: { 201: successSchema(templateDto) },
        },
      },
      async (req, reply) => {
        requirePat(req);
        const parts = checkParts({ imageUrl: req.body.imageUrl ?? null, buttons: req.body.buttons ?? null, buttonsTitle: req.body.buttonsTitle ?? null });
        try {
          const [row] = await db
            .insert(messageTemplates)
            .values({ workspaceId: req.auth.workspaceId, name: req.body.name, category: req.body.category, body: req.body.body, ...parts })
            .returning();
          reply.code(201);
          return ok(toTemplateDto(row!));
        } catch (err) {
          if (isUniqueViolation(err)) throw duplicateName();
          throw err;
        }
      },
    );

    app.put(
      '/templates/:id',
      {
        schema: {
          tags,
          summary: 'Update a template',
          params: z.object({ id: z.uuid() }),
          body: z.object({ name: templateName.optional(), category: z.enum(TEMPLATE_CATEGORIES).optional(), body: templateBody.optional(), ...partsInput }),
          response: { 200: successSchema(templateDto) },
        },
      },
      async (req) => {
        requirePat(req);
        const where = and(eq(messageTemplates.id, req.params.id), eq(messageTemplates.workspaceId, req.auth.workspaceId));
        const [current] = await db.select().from(messageTemplates).where(where);
        if (!current) throw notFound('Template not found');
        const { imageUrl, buttons, buttonsTitle, ...rest } = req.body;
        const parts = checkParts({
          imageUrl: imageUrl === undefined ? current.imageUrl : imageUrl,
          buttons: buttons === undefined ? current.buttons : buttons,
          buttonsTitle: buttonsTitle === undefined ? current.buttonsTitle : buttonsTitle,
        });
        try {
          const [row] = await db
            .update(messageTemplates)
            .set({ ...rest, ...parts, updatedAt: new Date() })
            .where(where)
            .returning();
          if (!row) throw notFound('Template not found');
          return ok(toTemplateDto(row));
        } catch (err) {
          if (isUniqueViolation(err)) throw duplicateName();
          throw err;
        }
      },
    );

    app.delete(
      '/templates/:id',
      {
        schema: { tags, summary: 'Delete a template', params: z.object({ id: z.uuid() }), response: { 200: successSchema(z.object({ deleted: z.literal(true) })) } },
      },
      async (req) => {
        requirePat(req);
        const [row] = await db
          .delete(messageTemplates)
          .where(and(eq(messageTemplates.id, req.params.id), eq(messageTemplates.workspaceId, req.auth.workspaceId)))
          .returning({ id: messageTemplates.id });
        if (!row) throw notFound('Template not found');
        return ok({ deleted: true as const });
      },
    );
  };
}
