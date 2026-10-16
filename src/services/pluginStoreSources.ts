import type { PluginStoreResponse, PluginStoreSource } from './plugins';

export const pluginStoreSourceKey = (source: PluginStoreSource): string => source.sourceId || source.sourceUrl;

export function getPluginStoreSources(store: PluginStoreResponse | null) {
  const sources = new Map<string, PluginStoreSource>();
  for (const source of [...(store?.sources ?? []), ...(store?.plugins ?? []), ...(store?.sourceErrors ?? [])]) {
    const key = pluginStoreSourceKey(source);
    if (key && !sources.has(key)) sources.set(key, source);
  }
  const name = (source: PluginStoreSource) => source.sourceName || source.sourceId || source.sourceUrl;
  const names = [...sources.values()].map(name);
  return [...sources].map(([key, source]) => ({
    key, label: names.filter(value => value === name(source)).length > 1
      ? `${name(source)} (${key})` : name(source),
  }));
}
