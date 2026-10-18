import { definitionFor, providerDefinitions, providerLabel, type ProviderCategory } from './logic';

export type ApiKind = { id: ProviderCategory; brand: string; label: string; openAi: boolean };

/** Provider brand (kit provider id) of an API-key kind. Gemini API and Interactions share the `gemini` brand. */
const BRAND_OF_KIND: Record<ProviderCategory, string> = {
  'codex-api-key': 'codex',
  'openai-compatibility': 'openai',
  deepseek: 'deepseek',
  'claude-api-key': 'claude',
  'gemini-api-key': 'gemini',
  'interactions-api-key': 'gemini',
  'vertex-api-key': 'vertex',
  'xai-api-key': 'xai',
  'meta-api-key': 'meta',
};

export const brandOfKind = (kind: ProviderCategory): string => BRAND_OF_KIND[kind];

/**
 * Every API-key config kind in display order. `label` is a getter so it follows the current locale when read at render time.
 */
export const API_KINDS: readonly ApiKind[] = providerDefinitions.map((definition) => ({
  id: definition.id,
  brand: BRAND_OF_KIND[definition.id],
  get label() {
    return providerLabel(definition);
  },
  openAi: definition.openAi,
}));

export const kindsOfBrand = (brand: string): readonly ApiKind[] => API_KINDS.filter((kind) => kind.brand === brand);

export const kindLabel = (kind: ProviderCategory): string => providerLabel(definitionFor(kind));
