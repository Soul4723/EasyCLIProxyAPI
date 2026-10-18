import { providerInfo } from '../../ui';
import type { ProviderCategory } from './api';
import type { CredentialStatus } from './creds';

/** One card per provider brand. `signInId` = the OAuth/import entry of that brand, `apiKinds` = its API-key config kinds. */
export type Brand = {
  id: string;
  name: string;
  signInId?: string;
  apiKinds: readonly ProviderCategory[];
};

const brand = (id: string, signInId: string | undefined, apiKinds: readonly ProviderCategory[], name?: string): Brand => ({
  id,
  name: name ?? providerInfo(id).name,
  signInId,
  apiKinds,
});

/** Display order: subscriptions first, then API-only brands. */
export const BRANDS: readonly Brand[] = [
  brand('codex', 'codex', ['codex-api-key']),
  brand('claude', 'claude', ['claude-api-key']),
  brand('antigravity', 'antigravity', []),
  brand('kimi', 'kimi', []),
  brand('xai', 'xai', ['xai-api-key']),
  brand('devin', 'devin', []),
  brand('meta', 'meta', ['meta-api-key']),
  brand('gemini', undefined, ['gemini-api-key', 'interactions-api-key']),
  brand('vertex', 'vertex', ['vertex-api-key']),
  brand('openai', undefined, ['openai-compatibility'], 'OpenAI-compatible'),
  brand('deepseek', undefined, ['deepseek']),
];

export const brandById = (id: string): Brand | undefined => BRANDS.find((entry) => entry.id === id);

/** Brand id of a free-form provider name (file provider/type, plugin id). Unknown names stay unknown. */
export const brandIdOf = (provider: string): string => {
  const id = providerInfo(provider).id;
  return id === 'other' ? provider || 'other' : id;
};

export type StatusCounts = Record<CredentialStatus, number>;

export const emptyStatusCounts = (): StatusCounts => ({ available: 0, cooldown: 0, disabled: 0, expired: 0, error: 0 });

export const CREDENTIAL_STATUS_ORDER: readonly CredentialStatus[] = ['available', 'cooldown', 'disabled', 'expired', 'error'];
