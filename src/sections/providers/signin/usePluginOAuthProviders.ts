import { useMemo } from 'react';
import { useDataSource } from '../../../services/dataSource';
import { pluginListSource } from '../../../services/pluginList';
import { collectPluginOAuthProviders } from '../../../services/pluginOAuthProviders';
import type { PluginListEntry } from '../../../services/plugins';

export type PluginOAuthProvidersState = {
  plugins: PluginListEntry[];
  loading: boolean;
  error: boolean;
  reload: () => Promise<void>;
};
export function usePluginOAuthProviders(builtInProviderIds: readonly string[]): PluginOAuthProvidersState {
  const source = useDataSource(pluginListSource);
  const plugins = useMemo(() => source.data?.list?.pluginsEnabled
    ? collectPluginOAuthProviders(source.data.list.plugins, builtInProviderIds) : [], [source.data, builtInProviderIds]);
  return { plugins, loading: source.loading, error: !!source.error, reload: pluginListSource.refresh };
}
