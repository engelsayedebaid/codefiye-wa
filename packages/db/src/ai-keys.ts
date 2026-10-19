import type { Sql } from './client';
import { openAiKey } from '@wa/provider';

export type AiProviderKeyRow = {
  id: string;
  providerId: string;
  label: string;
  apiKey: Buffer | null;
  enabled: boolean;
  priority: number;
  model: string | null;
  baseUrl: string | null;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  lastError: string | null;
  cooldownUntil: Date | null;
  circuitState: 'closed' | 'open' | 'half-open';
  circuitOpenedAt: Date | null;
  consecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
};

/** Circuit breaker configuration */
const CIRCUIT_BREAKER_THRESHOLD = 5; // Open after 5 consecutive failures
const CIRCUIT_BREAKER_TIMEOUT_MS = 60_000; // Try again after 60 seconds
const COOLDOWN_RETRY_AFTER_MS = 60_000; // Default cooldown for rate limits

/**
 * Selects the best available key for a provider, considering health, priority, and cooldown.
 * Returns null if no healthy key is available.
 */
export async function selectAiProviderKey(
  sql: Sql,
  providerId: string,
): Promise<AiProviderKeyRow | null> {
  const now = new Date();
  const [row] = await sql<AiProviderKeyRow[]>`
    select * from ai_provider_keys
    where provider_id = ${providerId}
      and enabled = true
      and (cooldown_until is null or cooldown_until <= ${now})
      and (circuit_state = 'closed' or (circuit_state = 'half-open' and circuit_opened_at <= ${new Date(now.getTime() - CIRCUIT_BREAKER_TIMEOUT_MS)}))
    order by priority asc, total_requests asc
    limit 1
    for update skip locked
  `;
  return row ?? null;
}

/**
 * Records a successful request for a key, updating statistics and closing the circuit if half-open.
 */
export async function recordAiKeySuccess(sql: Sql, keyId: string): Promise<void> {
  await sql`
    update ai_provider_keys
    set
      total_requests = total_requests + 1,
      success_requests = success_requests + 1,
      consecutive_failures = 0,
      circuit_state = 'closed',
      circuit_opened_at = null,
      last_error = null,
      updated_at = now()
    where id = ${keyId}
  `;
}

/**
 * Records a failed request for a key, updating statistics and potentially opening the circuit.
 */
export async function recordAiKeyFailure(
  sql: Sql,
  keyId: string,
  error: string,
  isRateLimit: boolean,
  retryAfterMs?: number,
): Promise<void> {
  const cooldownUntil = isRateLimit && retryAfterMs
    ? new Date(Date.now() + retryAfterMs)
    : isRateLimit
    ? new Date(Date.now() + COOLDOWN_RETRY_AFTER_MS)
    : null;

  await sql`
    update ai_provider_keys
    set
      total_requests = total_requests + 1,
      failed_requests = failed_requests + 1,
      consecutive_failures = consecutive_failures + 1,
      last_error = ${error},
      cooldown_until = ${cooldownUntil},
      circuit_state = case
        when consecutive_failures + 1 >= ${CIRCUIT_BREAKER_THRESHOLD} then 'open'
        when circuit_state = 'half-open' then 'open'
        else circuit_state
      end,
      circuit_opened_at = case
        when (consecutive_failures + 1 >= ${CIRCUIT_BREAKER_THRESHOLD} or circuit_state = 'half-open') then now()
        else circuit_opened_at
      end,
      updated_at = now()
    where id = ${keyId}
  `;
}

/**
 * Loads all keys for a provider, including disabled ones (for admin display).
 */
export async function loadAiProviderKeys(sql: Sql, providerId: string): Promise<AiProviderKeyRow[]> {
  return await sql<AiProviderKeyRow[]>`
    select * from ai_provider_keys
    where provider_id = ${providerId}
    order by priority asc, created_at asc
  `;
}

/**
 * Adds a new API key for a provider. The key is encrypted before storage.
 */
export async function addAiProviderKey(
  sql: Sql,
  providerId: string,
  label: string,
  apiKey: string,
  masterKey: Buffer,
  options?: {
    priority?: number;
    model?: string;
    baseUrl?: string;
  },
): Promise<string> {
  const encrypted = openAiKey(masterKey, providerId, Buffer.from(apiKey));
  if (!encrypted) throw new Error('Failed to encrypt API key');

  const [row] = await sql<{ id: string }[]>`
    insert into ai_provider_keys (provider_id, label, api_key, enabled, priority, model, base_url)
    values (${providerId}, ${label}, ${Buffer.from(encrypted)}, true, ${options?.priority ?? 0}, ${options?.model ?? null}, ${options?.baseUrl ?? null})
    returning id
  `;
  return row.id;
}

/**
 * Updates an existing API key. The key is re-encrypted if provided.
 */
export async function updateAiProviderKey(
  sql: Sql,
  keyId: string,
  updates: {
    label?: string;
    apiKey?: string;
    enabled?: boolean;
    priority?: number;
    model?: string;
    baseUrl?: string;
  },
  masterKey: Buffer,
  providerId: string,
): Promise<void> {
  const encrypted = updates.apiKey ? openAiKey(masterKey, providerId, Buffer.from(updates.apiKey)) : null;
  if (updates.apiKey && !encrypted) throw new Error('Failed to encrypt API key');

  await sql`
    update ai_provider_keys
    set
      label = coalesce(${updates.label}, label),
      api_key = coalesce(${encrypted ? Buffer.from(encrypted) : null}, api_key),
      enabled = coalesce(${updates.enabled}, enabled),
      priority = coalesce(${updates.priority}, priority),
      model = coalesce(${updates.model}, model),
      base_url = coalesce(${updates.baseUrl}, base_url),
      updated_at = now()
    where id = ${keyId}
  `;
}

/**
 * Deletes an API key.
 */
export async function deleteAiProviderKey(sql: Sql, keyId: string): Promise<void> {
  await sql`delete from ai_provider_keys where id = ${keyId}`;
}

/**
 * Resets the circuit breaker for a key (admin action).
 */
export async function resetAiKeyCircuit(sql: Sql, keyId: string): Promise<void> {
  await sql`
    update ai_provider_keys
    set
      circuit_state = 'closed',
      circuit_opened_at = null,
      consecutive_failures = 0,
      cooldown_until = null,
      last_error = null,
      updated_at = now()
    where id = ${keyId}
  `;
}

/**
 * Migrates existing single key from ai_providers to ai_provider_keys for backward compatibility.
 * This is a one-time migration helper.
 */
export async function migrateLegacyApiKey(
  sql: Sql,
  providerId: string,
  masterKey: Buffer,
): Promise<void> {
  const [provider] = await sql<{ apiKey: Buffer | null; model: string | null; baseUrl: string | null }[]>`
    select api_key, model, base_url from ai_providers where id = ${providerId}
  `;
  if (!provider?.apiKey) return; // No key to migrate

  // Check if keys already exist
  const [existing] = await sql<{ count: bigint }[]>`
    select count(*) as count from ai_provider_keys where provider_id = ${providerId}
  `;
  if (existing.count > 0n) return; // Already migrated

  await addAiProviderKey(
    sql,
    providerId,
    'Legacy Key',
    provider.apiKey.toString(),
    masterKey,
    {
      model: provider.model ?? undefined,
      baseUrl: provider.baseUrl ?? undefined,
    },
  );

  // Clear the old key field
  await sql`update ai_providers set api_key = null where id = ${providerId}`;
}
