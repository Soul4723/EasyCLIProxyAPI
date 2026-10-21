import { effectiveProviderKey, providerGroupKeys } from '../../../services/providerGroups';
import { readString } from '../../../services/managementApi';
import { fetchModels, modelsFromRecord, type ModelOption } from '../../../services/modelService';
import {
  checkProviderModelHealth,
  mergeProviderHealthModels,
  PROVIDER_HEALTH_TIMEOUT_MS,
  type ProviderHealthCheckOptions,
  type ProviderModelHealthResult,
} from '../../../services/providerHealthCheck';
import { providerHeadersFromRecord, providerModelType, type ProviderRow } from './logic';

export type ApiHealth = 'ok' | 'error' | 'checking';

/** The row as seen by one key of a native key group (a plain row when the config has no `keys`). */
export function healthRowForKey<Row extends ProviderRow>(row: Row, keyIndex: number): Row {
  const key = providerGroupKeys(row.record)[keyIndex];
  if (!key) return row;
  const record = effectiveProviderKey(row.record, key);
  const apiKey = readString(key, 'api-key');
  return {
    ...row,
    record,
    apiKey,
    apiKeys: [apiKey],
    authIndex: readString(key, 'auth-index', 'authIndex'),
    models: modelsFromRecord(record.models),
  };
}

export const healthOptionsFor = (row: ProviderRow): ProviderHealthCheckOptions => ({
  provider: row.category === 'deepseek' ? 'deepseek' : providerModelType(row.section, row.record),
  baseUrl: row.baseUrl,
  apiKeys: row.apiKeys,
  authIndex: row.authIndex,
  customHeaders: providerHeadersFromRecord(row.record),
  proxyUrl: readString(row.record, 'proxy-url'),
  timeoutMs: PROVIDER_HEALTH_TIMEOUT_MS,
});

/** The models the upstream lists for this config's connection (raw, nothing merged). */
export function fetchUpstreamModels(row: ProviderRow): Promise<ModelOption[]> {
  const options = healthOptionsFor(row);
  return fetchModels(
    options.provider,
    options.baseUrl,
    row.apiKeys.find((key) => key.trim()) ?? '',
    options.authIndex,
    options.customHeaders,
    options.timeoutMs,
    options.proxyUrl,
  );
}

/** Model list used by the health dialog: the configured models, enriched with the upstream list when it can be fetched. */
export async function discoverHealthModels(row: ProviderRow): Promise<ModelOption[]> {
  return mergeProviderHealthModels(await fetchUpstreamModels(row), row.models);
}

export type QuickCheck =
  | { status: 'ok' | 'error'; model: string; result: ProviderModelHealthResult }
  | { status: 'skipped'; model?: undefined; error: string };

/**
 * One minimal probe for a whole config (used by "check all"): the first configured model, or the first model the
 * upstream lists when none is configured. The first key of a key group is used.
 */
export async function quickCheckRow(row: ProviderRow): Promise<QuickCheck> {
  const effective = Array.isArray(row.record.keys) ? healthRowForKey(row, 0) : row;
  const options = healthOptionsFor(effective);
  let model = effective.models.find((item) => item.name.trim())?.name;
  if (!model) {
    try {
      model = (await fetchUpstreamModels(effective))[0]?.name;
    } catch (error) {
      return { status: 'skipped', error: String(error).replace(/^Error:\s*/i, '') };
    }
  }
  if (!model) return { status: 'skipped', error: '' };
  const result = await checkProviderModelHealth(options, model);
  return { status: result.status === 'healthy' ? 'ok' : 'error', model, result };
}
