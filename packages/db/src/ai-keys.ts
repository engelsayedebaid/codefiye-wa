import type { Sql } from './client';

export type AiProviderKeyRow = {
  id: string;
  providerId: string;
  label: string;
  apiKey: Buffer;
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

const CIRCUIT_BREAKER_THRESHOLD = 5;
const CIRCUIT_BREAKER_TIMEOUT_MS = 5 * 60_000;

const columns = `
  k.id, k.provider_id as "providerId", k.label, k.api_key as "apiKey", k.enabled, k.priority,
  k.model, k.base_url as "baseUrl", k.total_requests as "totalRequests",
  k.success_requests as "successRequests", k.failed_requests as "failedRequests",
  k.last_error as "lastError", k.cooldown_until as "cooldownUntil",
  k.circuit_state as "circuitState", k.circuit_opened_at as "circuitOpenedAt",
  k.consecutive_failures as "consecutiveFailures", k.created_at as "createdAt",
  k.updated_at as "updatedAt"
`;

/** All keys visible to an admin. The encrypted bytes never leave the server. */
export async function loadAiProviderKeys(sql: Sql, providerId: string): Promise<AiProviderKeyRow[]> {
  return await sql.unsafe<AiProviderKeyRow[]>(`
    select ${columns}
    from ai_provider_keys k
    where k.provider_id = $1
    order by k.priority, k.created_at
  `, [providerId]);
}

/** Healthy keys in rotation order. Old open circuits get one recovery probe. */
export async function loadAvailableAiProviderKeys(sql: Sql, providerId: string): Promise<AiProviderKeyRow[]> {
  const recoverBefore = new Date(Date.now() - CIRCUIT_BREAKER_TIMEOUT_MS);
  return await sql.unsafe<AiProviderKeyRow[]>(`
    select ${columns}
    from ai_provider_keys k
    join ai_providers p on p.id = k.provider_id and p.enabled = true
    where k.provider_id = $1
      and k.enabled = true
      and (k.cooldown_until is null or k.cooldown_until <= now())
      and (
        k.circuit_state = 'closed'
        or (k.circuit_state in ('open', 'half-open') and k.circuit_opened_at <= $2)
      )
    order by k.priority, k.total_requests, k.created_at
  `, [providerId, recoverBefore]);
}

export async function recordAiKeySuccess(sql: Sql, keyId: string): Promise<void> {
  await sql`
    update ai_provider_keys
    set total_requests = total_requests + 1, success_requests = success_requests + 1,
      consecutive_failures = 0, circuit_state = 'closed', circuit_opened_at = null,
      cooldown_until = null, last_error = null, updated_at = now()
    where id = ${keyId}
  `;
}

export async function recordAiKeyFailure(
  sql: Sql,
  keyId: string,
  options: { message: string; cooldownMs?: number; openCircuit?: boolean; disable?: boolean; countTowardsCircuit?: boolean },
): Promise<void> {
  const cooldownUntil = options.cooldownMs ? new Date(Date.now() + options.cooldownMs) : null;
  const message = options.message.slice(0, 500);
  await sql`
    update ai_provider_keys
    set total_requests = total_requests + 1, failed_requests = failed_requests + 1,
      consecutive_failures = consecutive_failures + case when ${options.countTowardsCircuit ?? true} then 1 else 0 end,
      last_error = ${message},
      cooldown_until = ${cooldownUntil},
      enabled = case when ${options.disable ?? false} then false else enabled end,
      circuit_state = case
        when ${options.openCircuit ?? false} or circuit_state = 'half-open'
          or (${options.countTowardsCircuit ?? true} and consecutive_failures + 1 >= ${CIRCUIT_BREAKER_THRESHOLD}) then 'open'
        else circuit_state
      end,
      circuit_opened_at = case
        when ${options.openCircuit ?? false} or circuit_state = 'half-open'
          or (${options.countTowardsCircuit ?? true} and consecutive_failures + 1 >= ${CIRCUIT_BREAKER_THRESHOLD}) then now()
        else circuit_opened_at
      end,
      updated_at = now()
    where id = ${keyId}
  `;
}

/** Applies an account/project restriction to every key, preventing unsafe key churn. */
export async function coolDownAiProviderKeys(
  sql: Sql,
  providerId: string,
  message: string,
  cooldownMs: number,
): Promise<void> {
  const until = new Date(Date.now() + cooldownMs);
  await sql`
    update ai_provider_keys
    set cooldown_until = greatest(coalesce(cooldown_until, ${until}), ${until}),
      last_error = ${message.slice(0, 500)}, updated_at = now()
    where provider_id = ${providerId} and enabled = true
  `;
}

export async function ensureAiProvider(sql: Sql, providerId: string): Promise<void> {
  await sql`insert into ai_providers (id) values (${providerId}) on conflict (id) do nothing`;
}

export async function addAiProviderKey(
  sql: Sql,
  providerId: string,
  label: string,
  encryptedApiKey: Buffer,
  options: { priority?: number; model?: string | null; baseUrl?: string | null } = {},
): Promise<string> {
  await ensureAiProvider(sql, providerId);
  const [row] = await sql<{ id: string }[]>`
    insert into ai_provider_keys (provider_id, label, api_key, enabled, priority, model, base_url)
    values (${providerId}, ${label}, ${encryptedApiKey}, true, ${options.priority ?? 0},
      ${options.model ?? null}, ${options.baseUrl ?? null}) returning id
  `;
  if (!row) throw new Error('The AI key was not inserted');
  return row.id;
}

export async function updateAiProviderKey(
  sql: Sql,
  providerId: string,
  keyId: string,
  updates: {
    label?: string;
    encryptedApiKey?: Buffer;
    enabled?: boolean;
    priority?: number;
    model?: string | null;
    baseUrl?: string | null;
  },
): Promise<boolean> {
  const [row] = await sql<{ id: string }[]>`
    update ai_provider_keys
    set label = case when ${updates.label !== undefined} then ${updates.label ?? ''} else label end,
      api_key = case when ${updates.encryptedApiKey !== undefined} then ${updates.encryptedApiKey ?? null} else api_key end,
      enabled = case when ${updates.enabled !== undefined} then ${updates.enabled ?? false} else enabled end,
      priority = case when ${updates.priority !== undefined} then ${updates.priority ?? 0} else priority end,
      model = case when ${updates.model !== undefined} then ${updates.model ?? null} else model end,
      base_url = case when ${updates.baseUrl !== undefined} then ${updates.baseUrl ?? null} else base_url end,
      consecutive_failures = case when ${updates.encryptedApiKey !== undefined} then 0 else consecutive_failures end,
      circuit_state = case when ${updates.encryptedApiKey !== undefined} then 'closed' else circuit_state end,
      circuit_opened_at = case when ${updates.encryptedApiKey !== undefined} then null else circuit_opened_at end,
      cooldown_until = case when ${updates.encryptedApiKey !== undefined} then null else cooldown_until end,
      last_error = case when ${updates.encryptedApiKey !== undefined} then null else last_error end,
      updated_at = now()
    where id = ${keyId} and provider_id = ${providerId}
    returning id
  `;
  return Boolean(row);
}

export async function deleteAiProviderKey(sql: Sql, providerId: string, keyId: string): Promise<boolean> {
  const [row] = await sql<{ id: string }[]>`
    delete from ai_provider_keys where id = ${keyId} and provider_id = ${providerId} returning id`;
  return Boolean(row);
}

export async function resetAiKeyCircuit(sql: Sql, providerId: string, keyId: string): Promise<boolean> {
  const [row] = await sql<{ id: string }[]>`
    update ai_provider_keys
    set circuit_state = 'closed', circuit_opened_at = null, consecutive_failures = 0,
      cooldown_until = null, last_error = null, updated_at = now()
    where id = ${keyId} and provider_id = ${providerId}
    returning id
  `;
  return Boolean(row);
}
