import { useMemo } from 'react';
import { useDataSource } from './services/dataSource';
import { pluginListSource } from './services/pluginList';
import { collectPluginResourceEntries } from './services/pluginResources';
import { readCachedPluginNavEntries, toPluginNavEntry, writeCachedPluginNavEntries } from './services/pluginNavigation';

export function usePluginNavEntries(coreReady: boolean) {
  const source = useDataSource(pluginListSource, coreReady);
  const entries = useMemo(() => {
    if (!source.data) return readCachedPluginNavEntries();
    const list = source.data.list;
    const next = list?.pluginsEnabled ? collectPluginResourceEntries(list.plugins).map(toPluginNavEntry) : [];
    writeCachedPluginNavEntries(next);
    return next;
  }, [source.data]);
  return { entries, fetched: !!source.data, loading: source.loading, error: source.error, retry: pluginListSource.refresh };
}
