import { providerInfo } from '../../ui';
import { kindsOfBrand, type ApiKind } from './api';
import type { SignInProvider } from './signin';

/** One card per provider brand. `signInId` = the OAuth/import entry of that brand, `kinds` = its API-key config kinds. */
export type Brand = {
  id: string;
  name: string;
  signInId?: string;
  kinds: readonly ApiKind[];
};

const brand = (id: string, signInId: string | undefined, name?: string): Brand => ({
  id,
  name: name ?? providerInfo(id).name,
  signInId,
  kinds: kindsOfBrand(id),
});

/** Display order: subscription brands first, then API-only brands. */
export const SUBSCRIPTION_BRANDS: readonly Brand[] = [
  brand('codex', 'codex'),
  brand('claude', 'claude'),
  brand('antigravity', 'antigravity'),
  brand('kimi', 'kimi'),
  brand('xai', 'xai'),
  brand('devin', 'devin'),
  brand('meta', 'meta'),
  brand('vertex', 'vertex'),
];

export const API_ONLY_BRANDS: readonly Brand[] = [
  brand('gemini', undefined),
  brand('openai', undefined, 'OpenAI-compatible'),
  brand('deepseek', undefined),
];

/**
 * Every brand to show: the known ones, plus plugin sign-in providers and any credential provider the section does
 * not know (so nothing the core holds is hidden).
 */
export function resolveBrands(signIn: readonly SignInProvider[], knownProviders: Iterable<string>): { subscriptions: Brand[]; apiOnly: Brand[] } {
  const subscriptions = [...SUBSCRIPTION_BRANDS];
  const have = new Set([...subscriptions, ...API_ONLY_BRANDS].map((entry) => entry.id));
  for (const provider of signIn) {
    if (have.has(provider.brand)) continue;
    have.add(provider.brand);
    subscriptions.push({ id: provider.brand, name: provider.name, signInId: provider.id, kinds: [] });
  }
  for (const id of knownProviders) {
    if (have.has(id)) continue;
    have.add(id);
    subscriptions.push({ id, name: providerInfo(id).name, kinds: [] });
  }
  return { subscriptions, apiOnly: [...API_ONLY_BRANDS] };
}
