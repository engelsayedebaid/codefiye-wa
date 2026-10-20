import {
  addAiProviderKey,
  deleteAiProviderKey,
  listAutoReplySettings,
  loadAvailableAiProviderKeys,
  loadAiProviderKeys,
  resetAiKeyCircuit,
  saveAutoReplySettings,
  updateAiProviderKey,
  type Sql,
} from '@wa/db';
import { openAiKey, sealAiKey } from '@wa/provider';
import {
  AI_PROVIDERS,
  type AiProviderId,
  AUTO_REPLY_LANGUAGES,
  AUTO_REPLY_PERSONALITIES,
  type AutoReplyLanguage,
  type AutoReplyPersonality,
  type AutoReplyRule,
  type AutoReplySettings,
  type AutoReplyStatus,
  type AutoReplyVariables,
  DEFAULT_AUTO_REPLY_SETTINGS,
  DEFAULT_AUTO_REPLY_VARIABLES,
  generateText,
  ok,
  successSchema,
  validateGeminiModelAccess,
} from '@wa/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Deps } from '../deps';
import { requireAdmin } from '../lib/auth';
import { notFound, unavailable, unprocessable } from '../lib/errors';

/**
 * The AI auto-reply agent (admins only): the providers it may answer with, each number's own
 * settings, what it answered, and how it went. Hidden from /docs — it is the operator's panel, not
 * part of the public API.
 */

const schemaBase = { tags: ['Admin'], hide: true };

const providerId = z.enum(['anthropic', 'openai', 'gemini', 'groq', 'mistral', 'custom']);

const providerDto = z.object({
  id: providerId,
  enabled: z.boolean(),
  /** Whether a key is stored (never the key itself). */
  hasKey: z.boolean(),
  /** The last characters of the key, to tell two keys apart. */
  keyHint: z.string().nullable(),
  keyCount: z.number(),
  activeKeyCount: z.number(),
  baseUrl: z.string().nullable(),
  model: z.string().nullable(),
  needsKey: z.boolean(),
  defaultModel: z.string(),
  models: z.array(z.string()),
});

const providerKeyDto = z.object({
  id: z.uuid(),
  providerId: providerId,
  label: z.string(),
  enabled: z.boolean(),
  priority: z.number(),
  model: z.string().nullable(),
  baseUrl: z.string().nullable(),
  totalRequests: z.number(),
  successRequests: z.number(),
  failedRequests: z.number(),
  lastError: z.string().nullable(),
  cooldownUntil: z.string().nullable(),
  circuitState: z.enum(['closed', 'open', 'half-open']),
  circuitOpenedAt: z.string().nullable(),
  consecutiveFailures: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  keyHint: z.string().nullable(),
});

const ruleSchema = z.object({
  id: z.string().min(1).max(64),
  keywords: z.array(z.string().min(1).max(80)).min(1).max(20),
  reply: z.string().min(1).max(4_000),
  match: z.enum(['contains', 'exact']).default('contains'),
});

const variablesSchema = z.object({
  businessName: z.string().max(200).default(DEFAULT_AUTO_REPLY_VARIABLES.businessName),
  services: z.string().max(2_000).default(DEFAULT_AUTO_REPLY_VARIABLES.services),
  pricing: z.string().max(1_000).default(DEFAULT_AUTO_REPLY_VARIABLES.pricing),
  website: z.string().max(200).default(DEFAULT_AUTO_REPLY_VARIABLES.website),
  phone: z.string().max(64).default(''),
});

const settingsSchema = z.object({
  enabled: z.boolean().optional(),
  personality: z.enum(AUTO_REPLY_PERSONALITIES).optional(),
  systemPrompt: z.string().max(20_000).optional(),
  providerId: providerId.optional(),
  model: z.string().max(120).optional(),
  fallbackProviderId: providerId.nullable().optional(),
  fallbackModel: z.string().max(120).optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(64).max(32_000).optional(),
  delayMinMs: z.number().int().min(0).max(600_000).optional(),
  delayMaxMs: z.number().int().min(0).max(600_000).optional(),
  businessHoursOnly: z.boolean().optional(),
  hoursStart: z.number().int().min(0).max(23).optional(),
  hoursEnd: z.number().int().min(0).max(23).optional(),
  timezone: z.string().min(1).max(64).optional(),
  maxReplies: z.number().int().min(0).max(100).optional(),
  ignoreList: z.array(z.string().min(1).max(64)).max(200).optional(),
  rules: z.array(ruleSchema).max(50).optional(),
  language: z.enum(AUTO_REPLY_LANGUAGES).optional(),
  variables: variablesSchema.partial().optional(),
});

const settingsDto = z.object({
  enabled: z.boolean(),
  personality: z.enum(AUTO_REPLY_PERSONALITIES),
  systemPrompt: z.string(),
  providerId: providerId,
  model: z.string(),
  fallbackProviderId: providerId.nullable(),
  fallbackModel: z.string(),
  temperature: z.number(),
  maxTokens: z.number(),
  delayMinMs: z.number(),
  delayMaxMs: z.number(),
  businessHoursOnly: z.boolean(),
  hoursStart: z.number(),
  hoursEnd: z.number(),
  timezone: z.string(),
  maxReplies: z.number(),
  ignoreList: z.array(z.string()),
  rules: z.array(ruleSchema),
  language: z.enum(AUTO_REPLY_LANGUAGES),
  variables: variablesSchema,
});

const numberDto = z.object({
  sessionId: z.uuid(),
  name: z.string(),
  phone: z.string().nullable(),
  status: z.string(),
  enabled: z.boolean(),
  settings: settingsDto,
});

const logEntryDto = z.object({
  id: z.number(),
  sessionId: z.uuid(),
  sessionName: z.string().nullable(),
  chatJid: z.string(),
  provider: z.string(),
  model: z.string(),
  language: z.enum(['ar', 'en']),
  reply: z.string(),
  status: z.enum(['sent', 'failed', 'skipped']),
  reason: z.string().nullable(),
  latencyMs: z.number().nullable(),
  createdAt: z.string(),
});

/** The last characters of a key, so the admin can tell two keys apart without seeing them. */
function hint(key: string | null): string | null {
  if (!key) return null;
  return key.length <= 4 ? '••••' : `••••${key.slice(-4)}`;
}

export function autoReplyRoutes(deps: Deps): FastifyPluginAsyncZod {
  const { sql } = deps;

  /** The master key (AUTH_ENCRYPTION_KEY); without it the providers can't be managed. */
  const masterKey = () => {
    if (!deps.encryptionKey) throw unavailable('This server has no AUTH_ENCRYPTION_KEY, so the AI providers cannot be managed', 'ai_not_configured');
    return deps.encryptionKey;
  };

  return async (app) => {
    app.addHook('preHandler', async (req) => requireAdmin(req));

    app.get(
      '/providers',
      { schema: { ...schemaBase, summary: 'The AI providers and their settings', response: { 200: successSchema(z.object({ providers: z.array(providerDto) })) } } },
      async () => {
        const rows = await sql<
          { id: string; enabled: boolean; base_url: string | null; model: string | null }[]
        >`select id, enabled, base_url, model from ai_providers`;
        const keyRows = await sql<{ provider_id: string; api_key: Buffer; enabled: boolean }[]>`
          select provider_id, api_key, enabled from ai_provider_keys order by priority, created_at`;
        const byId = new Map(rows.map((r) => [r.id, r]));
        const providers = (Object.keys(AI_PROVIDERS) as AiProviderId[]).map((id) => {
          const info = AI_PROVIDERS[id];
          const row = byId.get(id);
          const keys = keyRows.filter((key) => key.provider_id === id);
          const first = keys[0];
          const key = first && deps.encryptionKey ? openAiKey(deps.encryptionKey, id, first.api_key) : null;
          return {
            id,
            enabled: row?.enabled ?? false,
            hasKey: keys.length > 0,
            keyHint: hint(key),
            keyCount: keys.length,
            activeKeyCount: keys.filter((entry) => entry.enabled).length,
            baseUrl: row?.base_url ?? (info.baseUrl || null),
            model: row?.model ?? null,
            needsKey: info.needsKey,
            defaultModel: info.defaultModel,
            models: info.models,
          };
        });
        return ok({ providers });
      },
    );

    app.put(
      '/providers/:id',
      {
        schema: {
          ...schemaBase,
          summary: 'Set up an AI provider',
          params: z.object({ id: providerId }),
          body: z.object({
            enabled: z.boolean().optional(),
            /** Backward-compatible shortcut: adds a key. New clients use /keys. */
            apiKey: z.string().min(8).max(500).optional(),
            /** Backward-compatible shortcut: removes every provider key. */
            removeKey: z.boolean().optional(),
            baseUrl: z.string().url().max(300).nullable().optional(),
            model: z.string().max(120).optional(),
          }),
          response: { 200: successSchema(z.object({ saved: z.boolean() })) },
        },
      },
      async (req) => {
        const { id } = req.params;
        const info = AI_PROVIDERS[id];
        const [current] = await sql<{ enabled: boolean; base_url: string | null; model: string | null }[]>`
          select enabled, base_url, model from ai_providers where id = ${id}`;
        const baseUrl = req.body.baseUrl === undefined ? (current?.base_url ?? (info.baseUrl || null)) : req.body.baseUrl;
        const model = req.body.model === undefined ? (current?.model ?? null) : req.body.model || null;
        const enabled = req.body.enabled ?? current?.enabled ?? false;
        const [keyCount] = await sql<{ count: number }[]>`
          select count(*)::int as count from ai_provider_keys where provider_id = ${id} and enabled = true`;
        const resultingKeys = req.body.removeKey ? 0 : (keyCount?.count ?? 0) + (req.body.apiKey ? 1 : 0);
        if (enabled && info.needsKey && resultingKeys === 0) {
          throw unprocessable('This provider needs an enabled API key', { apiKey: ['Add a key first'] });
        }
        if (enabled && id === 'custom' && !baseUrl) throw unprocessable('A custom provider needs a base URL', { baseUrl: ['Add the address of your OpenAI-compatible server'] });
        await sql`
          insert into ai_providers (id, enabled, base_url, model)
          values (${id}, ${enabled}, ${baseUrl}, ${model})
          on conflict (id) do update set
            enabled = excluded.enabled,
            base_url = excluded.base_url,
            model = excluded.model,
            updated_at = now()`;
        if (req.body.removeKey) await sql`delete from ai_provider_keys where provider_id = ${id}`;
        if (req.body.apiKey) {
          await addAiProviderKey(sql, id, 'Primary key', sealAiKey(masterKey(), id, req.body.apiKey));
        }
        return ok({ saved: true });
      },
    );

    app.post(
      '/providers/:id/test',
      {
        schema: {
          ...schemaBase,
          summary: 'Try a provider with a short message',
          params: z.object({ id: providerId }),
          body: z.object({ model: z.string().max(120).optional() }),
          response: { 200: successSchema(z.object({ ok: z.boolean(), model: z.string(), reply: z.string(), latencyMs: z.number() })) },
        },
      },
      async (req) => {
        const { id } = req.params;
        const [row] = await sql<{ enabled: boolean; base_url: string | null; model: string | null }[]>`
          select enabled, base_url, model from ai_providers where id = ${id}`;
        const info = AI_PROVIDERS[id];
        const model = req.body.model?.trim() || row?.model?.trim() || info.defaultModel;
        const keys = await loadAvailableAiProviderKeys(sql, id);
        const selected = keys[0];
        if (!row?.enabled) throw unprocessable('Enable this provider before testing it');
        if (info.needsKey && !selected) throw unprocessable('This provider has no available API key');
        const key = selected ? openAiKey(masterKey(), id, selected.apiKey) : '';
        if (selected && !key) throw unprocessable('The selected API key cannot be decrypted');
        const started = Date.now();
        try {
          if (id === 'gemini') {
            await validateGeminiModelAccess({
              apiKey: key ?? '',
              model: selected?.model?.trim() || model,
              baseUrl: selected?.baseUrl ?? row?.base_url ?? undefined,
              timeoutMs: 20_000,
            });
          }
          const answer = await generateText({
            provider: id,
            apiKey: key ?? '',
            baseUrl: selected?.baseUrl ?? row?.base_url ?? undefined,
            model: selected?.model?.trim() || model,
            system: 'You are a test. Answer with one short word.',
            messages: [{ role: 'user', content: 'Say: ready' }],
            temperature: 0,
            maxTokens: 32,
            timeoutMs: 20_000,
          });
          return ok({ ok: true, model: answer.model, reply: answer.text, latencyMs: Date.now() - started });
        } catch (err) {
          throw unprocessable(err instanceof Error ? err.message : 'The provider did not answer');
        }
      },
    );

    // Multi-key management endpoints

    app.get(
      '/providers/:id/keys',
      {
        schema: {
          ...schemaBase,
          summary: 'List all API keys for a provider',
          params: z.object({ id: providerId }),
          response: { 200: successSchema(z.object({ keys: z.array(providerKeyDto) })) },
        },
      },
      async (req) => {
        const { id } = req.params;
        const keys = await loadAiProviderKeys(sql, id);
        const keyDtos = keys.map((k) => ({
          id: k.id,
          providerId: k.providerId as AiProviderId,
          label: k.label,
          enabled: k.enabled,
          priority: k.priority,
          model: k.model,
          baseUrl: k.baseUrl,
          totalRequests: k.totalRequests,
          successRequests: k.successRequests,
          failedRequests: k.failedRequests,
          lastError: k.lastError,
          cooldownUntil: k.cooldownUntil?.toISOString() ?? null,
          circuitState: k.circuitState,
          circuitOpenedAt: k.circuitOpenedAt?.toISOString() ?? null,
          consecutiveFailures: k.consecutiveFailures,
          createdAt: k.createdAt.toISOString(),
          updatedAt: k.updatedAt.toISOString(),
          keyHint: hint(deps.encryptionKey ? openAiKey(deps.encryptionKey, id, k.apiKey) : null),
        }));
        return ok({ keys: keyDtos });
      },
    );

    app.post(
      '/providers/:id/keys',
      {
        schema: {
          ...schemaBase,
          summary: 'Add a new API key for a provider',
          params: z.object({ id: providerId }),
          body: z.object({
            label: z.string().min(1).max(100),
            apiKey: z.string().min(8).max(500),
            priority: z.number().int().min(0).max(1000).optional(),
            model: z.string().max(120).optional(),
            baseUrl: z.string().url().max(300).nullable().optional(),
          }),
          response: { 200: successSchema(z.object({ keyId: z.uuid() })) },
        },
      },
      async (req) => {
        const { id } = req.params;
        const keyId = await addAiProviderKey(sql, id, req.body.label, sealAiKey(masterKey(), id, req.body.apiKey), {
            priority: req.body.priority,
            model: req.body.model,
            baseUrl: req.body.baseUrl,
          });
        // The first key switches the provider on: otherwise the agent skips it ("disabled") although
        // its key tests fine. A provider switched off with keys stored stays off.
        await sql`
          update ai_providers set enabled = true, updated_at = now()
          where id = ${id} and not enabled
            and (select count(*) from ai_provider_keys where provider_id = ${id}) = 1`;
        return ok({ keyId });
      },
    );

    app.put(
      '/providers/:id/keys/:keyId',
      {
        schema: {
          ...schemaBase,
          summary: 'Update an API key',
          params: z.object({ id: providerId, keyId: z.uuid() }),
          body: z.object({
            label: z.string().min(1).max(100).optional(),
            apiKey: z.string().min(8).max(500).optional(),
            enabled: z.boolean().optional(),
            priority: z.number().int().min(0).max(1000).optional(),
            model: z.string().max(120).optional(),
            baseUrl: z.string().url().max(300).nullable().optional(),
          }),
          response: { 200: successSchema(z.object({ updated: z.boolean() })) },
        },
      },
      async (req) => {
        const { id, keyId } = req.params;
        const updated = await updateAiProviderKey(sql, id, keyId, {
            label: req.body.label,
            encryptedApiKey: req.body.apiKey ? sealAiKey(masterKey(), id, req.body.apiKey) : undefined,
            enabled: req.body.enabled,
            priority: req.body.priority,
            model: req.body.model,
            baseUrl: req.body.baseUrl,
          });
        if (!updated) throw notFound('AI provider key not found');
        return ok({ updated: true });
      },
    );

    app.delete(
      '/providers/:id/keys/:keyId',
      {
        schema: {
          ...schemaBase,
          summary: 'Delete an API key',
          params: z.object({ id: providerId, keyId: z.uuid() }),
          response: { 200: successSchema(z.object({ deleted: z.boolean() })) },
        },
      },
      async (req) => {
        const { id, keyId } = req.params;
        if (!await deleteAiProviderKey(sql, id, keyId)) throw notFound('AI provider key not found');
        return ok({ deleted: true });
      },
    );

    app.post(
      '/providers/:id/keys/:keyId/reset',
      {
        schema: {
          ...schemaBase,
          summary: 'Reset circuit breaker for a key',
          params: z.object({ id: providerId, keyId: z.uuid() }),
          response: { 200: successSchema(z.object({ reset: z.boolean() })) },
        },
      },
      async (req) => {
        const { id, keyId } = req.params;
        if (!await resetAiKeyCircuit(sql, id, keyId)) throw notFound('AI provider key not found');
        return ok({ reset: true });
      },
    );

    app.post(
      '/providers/:id/keys/:keyId/test',
      {
        schema: {
          ...schemaBase,
          summary: 'Test one AI provider key',
          params: z.object({ id: providerId, keyId: z.uuid() }),
          response: { 200: successSchema(z.object({ ok: z.boolean(), model: z.string(), reply: z.string(), latencyMs: z.number() })) },
        },
      },
      async (req) => {
        const { id, keyId } = req.params;
        const key = (await loadAiProviderKeys(sql, id)).find((entry) => entry.id === keyId);
        if (!key) throw notFound('AI provider key not found');
        const [provider] = await sql<{ base_url: string | null; model: string | null }[]>`
          select base_url, model from ai_providers where id = ${id}`;
        const plaintext = openAiKey(masterKey(), id, key.apiKey);
        if (!plaintext) throw unprocessable('This API key cannot be decrypted');
        const started = Date.now();
        try {
          const selectedModel = key.model?.trim() || provider?.model?.trim() || AI_PROVIDERS[id].defaultModel;
          if (id === 'gemini') {
            await validateGeminiModelAccess({
              apiKey: plaintext,
              model: selectedModel,
              baseUrl: key.baseUrl ?? provider?.base_url ?? undefined,
              timeoutMs: 20_000,
            });
          }
          const answer = await generateText({
            provider: id,
            apiKey: plaintext,
            baseUrl: key.baseUrl ?? provider?.base_url ?? undefined,
            model: selectedModel,
            system: 'You are a test. Answer with one short word.',
            messages: [{ role: 'user', content: 'Say: ready' }],
            temperature: 0,
            maxTokens: 32,
            timeoutMs: 20_000,
          });
          await resetAiKeyCircuit(sql, id, keyId);
          return ok({ ok: true, model: answer.model, reply: answer.text, latencyMs: Date.now() - started });
        } catch (err) {
          throw unprocessable(err instanceof Error ? err.message : 'The provider did not answer');
        }
      },
    );

    app.get(
      '/settings',
      { schema: { ...schemaBase, summary: 'Every number and its auto-reply settings', response: { 200: successSchema(z.object({ numbers: z.array(numberDto) })) } } },
      async (req) => {
        const rows = await sql<{ id: string; name: string; phone: string | null; status: string }[]>`
          select id, name, phone, status from sessions where workspace_id = ${req.auth.workspaceId} order by created_at`;
        const settings = await listAutoReplySettings(sql, req.auth.workspaceId);
        const bySession = new Map(settings.map((s) => [s.sessionId, s.settings]));
        const numbers = rows.map((row) => {
          const own = bySession.get(row.id);
          return {
            sessionId: row.id,
            name: row.name,
            phone: row.phone,
            status: row.status,
            enabled: own?.enabled ?? false,
            settings: own ?? { ...DEFAULT_AUTO_REPLY_SETTINGS },
          };
        });
        return ok({ numbers });
      },
    );

    app.put(
      '/settings/:sessionId',
      {
        schema: {
          ...schemaBase,
          summary: 'Save a number\'s auto-reply settings',
          params: z.object({ sessionId: z.uuid() }),
          body: settingsSchema,
          response: { 200: successSchema(z.object({ settings: settingsDto })) },
        },
      },
      async (req) => {
        const [session] = await sql<{ id: string }[]>`
          select id from sessions where id = ${req.params.sessionId} and workspace_id = ${req.auth.workspaceId}`;
        if (!session) throw notFound('Session not found');
        const patch: Partial<AutoReplySettings> = {};
        const body = req.body;
        if (body.enabled !== undefined) patch.enabled = body.enabled;
        if (body.personality !== undefined) patch.personality = body.personality as AutoReplyPersonality;
        if (body.systemPrompt !== undefined) patch.systemPrompt = body.systemPrompt;
        if (body.providerId !== undefined) patch.providerId = body.providerId as AiProviderId;
        if (body.model !== undefined) patch.model = body.model;
        if (body.fallbackProviderId !== undefined) patch.fallbackProviderId = body.fallbackProviderId as AiProviderId | null;
        if (body.fallbackModel !== undefined) patch.fallbackModel = body.fallbackModel;
        if (body.temperature !== undefined) patch.temperature = body.temperature;
        if (body.maxTokens !== undefined) patch.maxTokens = body.maxTokens;
        if (body.delayMinMs !== undefined) patch.delayMinMs = body.delayMinMs;
        if (body.delayMaxMs !== undefined) patch.delayMaxMs = body.delayMaxMs;
        if (body.businessHoursOnly !== undefined) patch.businessHoursOnly = body.businessHoursOnly;
        if (body.hoursStart !== undefined) patch.hoursStart = body.hoursStart;
        if (body.hoursEnd !== undefined) patch.hoursEnd = body.hoursEnd;
        if (body.timezone !== undefined) patch.timezone = body.timezone;
        if (body.maxReplies !== undefined) patch.maxReplies = body.maxReplies;
        if (body.ignoreList !== undefined) patch.ignoreList = body.ignoreList;
        if (body.rules !== undefined) patch.rules = body.rules as AutoReplyRule[];
        if (body.language !== undefined) patch.language = body.language as AutoReplyLanguage;
        if (body.variables !== undefined) patch.variables = { ...DEFAULT_AUTO_REPLY_VARIABLES, ...body.variables } as AutoReplyVariables;
        if (patch.delayMaxMs !== undefined && patch.delayMinMs !== undefined && patch.delayMaxMs < patch.delayMinMs) {
          throw unprocessable('The longest pause is shorter than the shortest one', { delayMaxMs: ['It must be at least as long as the shortest pause'] });
        }
        const settings = await saveAutoReplySettings(sql, session.id, req.auth.workspaceId, patch);
        return ok({ settings });
      },
    );

    app.get(
      '/log',
      {
        schema: {
          ...schemaBase,
          summary: 'What the agent answered (and what it skipped)',
          querystring: z.object({
            sessionId: z.uuid().optional(),
            status: z.enum(['sent', 'failed', 'skipped']).optional(),
            days: z.coerce.number().int().min(1).max(90).default(7),
            limit: z.coerce.number().int().min(1).max(200).default(50),
          }),
          response: { 200: successSchema(z.object({ entries: z.array(logEntryDto) })) },
        },
      },
      async (req) => {
        const { sessionId, status, days, limit } = req.query;
        const rows = await sql<
          {
            id: number;
            session_id: string;
            session_name: string | null;
            chat_jid: string;
            provider: string;
            model: string;
            language: 'ar' | 'en';
            reply: string;
            status: AutoReplyStatus;
            reason: string | null;
            latency_ms: number | null;
            created_at: Date;
          }[]
        >`
          select l.id, l.session_id, s.name as session_name, l.chat_jid, l.provider, l.model, l.language, l.reply,
            l.status, l.reason, l.latency_ms, l.created_at
          from auto_reply_log l
          left join sessions s on s.id = l.session_id
          where l.workspace_id = ${req.auth.workspaceId}
            and l.created_at > now() - (${days}::int * interval '1 day')
            and (${sessionId ?? null}::uuid is null or l.session_id = ${sessionId ?? null}::uuid)
            and (${status ?? null}::text is null or l.status = ${status ?? null}::text)
          order by l.id desc limit ${limit}`;
        return ok({
          entries: rows.map((row) => ({
            id: row.id,
            sessionId: row.session_id,
            sessionName: row.session_name,
            chatJid: row.chat_jid,
            provider: row.provider,
            model: row.model,
            language: row.language,
            reply: row.reply,
            status: row.status,
            reason: row.reason,
            latencyMs: row.latency_ms,
            createdAt: new Date(row.created_at).toISOString(),
          })),
        });
      },
    );

    app.get(
      '/stats',
      {
        schema: {
          ...schemaBase,
          summary: 'How the agent is doing',
          querystring: z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }),
          response: {
            200: successSchema(
              z.object({
                perDay: z.array(z.object({ day: z.string(), sent: z.number(), failed: z.number(), skipped: z.number() })),
                byProvider: z.array(z.object({ provider: z.string(), count: z.number() })),
                byLanguage: z.array(z.object({ language: z.string(), count: z.number() })),
                perNumber: z.array(z.object({ sessionId: z.uuid(), name: z.string(), sent: z.number(), failed: z.number(), avgLatencyMs: z.number().nullable() })),
                totals: z.object({ sent: z.number(), failed: z.number(), skipped: z.number(), avgLatencyMs: z.number().nullable() }),
              }),
            ),
          },
        },
      },
      async (req) => {
        const days = req.query.days;
        const [perDay, byProvider, byLanguage, perNumber, totals] = await Promise.all([
          sql<{ day: Date; sent: number; failed: number; skipped: number }[]>`
            select date_trunc('day', created_at) as day,
              count(*) filter (where status = 'sent')::int as sent,
              count(*) filter (where status = 'failed')::int as failed,
              count(*) filter (where status = 'skipped')::int as skipped
            from auto_reply_log
            where workspace_id = ${req.auth.workspaceId} and created_at > now() - (${days}::int * interval '1 day')
            group by 1 order by 1`,
          sql<{ provider: string; count: number }[]>`
            select nullif(provider, '') as provider, count(*)::int as count
            from auto_reply_log
            where workspace_id = ${req.auth.workspaceId} and status = 'sent' and created_at > now() - (${days}::int * interval '1 day')
            group by 1 order by 2 desc`,
          sql<{ language: string; count: number }[]>`
            select language, count(*)::int as count
            from auto_reply_log
            where workspace_id = ${req.auth.workspaceId} and status = 'sent' and created_at > now() - (${days}::int * interval '1 day')
            group by 1 order by 2 desc`,
          sql<{ session_id: string; name: string; sent: number; failed: number; avg_latency: number | null }[]>`
            select l.session_id, coalesce(s.name, '') as name,
              count(*) filter (where l.status = 'sent')::int as sent,
              count(*) filter (where l.status = 'failed')::int as failed,
              avg(l.latency_ms) filter (where l.status = 'sent') as avg_latency
            from auto_reply_log l
            left join sessions s on s.id = l.session_id
            where l.workspace_id = ${req.auth.workspaceId} and l.created_at > now() - (${days}::int * interval '1 day')
            group by l.session_id, s.name order by sent desc`,
          sql<{ sent: number; failed: number; skipped: number; avg_latency: number | null }[]>`
            select count(*) filter (where status = 'sent')::int as sent,
              count(*) filter (where status = 'failed')::int as failed,
              count(*) filter (where status = 'skipped')::int as skipped,
              avg(latency_ms) filter (where status = 'sent') as avg_latency
            from auto_reply_log
            where workspace_id = ${req.auth.workspaceId} and created_at > now() - (${days}::int * interval '1 day')`,
        ]);
        return ok({
          perDay: perDay.map((row) => ({
            day: new Date(row.day).toISOString().slice(0, 10),
            sent: row.sent,
            failed: row.failed,
            skipped: row.skipped,
          })),
          byProvider: byProvider.map((row) => ({ provider: row.provider ?? 'rule', count: row.count })),
          byLanguage: byLanguage.map((row) => ({ language: row.language, count: row.count })),
          perNumber: perNumber.map((row) => ({
            sessionId: row.session_id,
            name: row.name,
            sent: row.sent,
            failed: row.failed,
            avgLatencyMs: row.avg_latency === null ? null : Math.round(Number(row.avg_latency)),
          })),
          totals: {
            sent: totals[0]?.sent ?? 0,
            failed: totals[0]?.failed ?? 0,
            skipped: totals[0]?.skipped ?? 0,
            avgLatencyMs: totals[0]?.avg_latency === null || totals[0]?.avg_latency === undefined ? null : Math.round(Number(totals[0].avg_latency)),
          },
        });
      },
    );
  };
}
