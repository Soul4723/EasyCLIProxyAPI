import { createDataSource, type DataSource } from './dataSource';
import { invoke } from './documentTarget';
import { pluginsApi, type PluginListResponse } from './plugins';
import { PLUGIN_RESOURCES_REFRESH_EVENT } from './pluginResources';

let support: boolean | undefined;
let registrationAttempts = 0;
export const pluginListSource: DataSource<{ supported: boolean; list: PluginListResponse | null }> = createDataSource({
  load: async () => {
    support ??= await invoke<boolean>('get_plugin_support');
    const list = support ? await pluginsApi.list() : null;
    registrationAttempts++;
    return { supported: support, list };
  },
  subscribeEvents: invalidate => {
    const changed = () => { registrationAttempts = 0; invalidate(); };
    window.addEventListener(PLUGIN_RESOURCES_REFRESH_EVENT, changed);
    return () => window.removeEventListener(PLUGIN_RESOURCES_REFRESH_EVENT, changed);
  },
  pollMs: () => {
    const list = pluginListSource.getSnapshot().data?.list;
    return registrationAttempts < 8 && list?.pluginsEnabled
      && list.plugins.some(plugin => plugin.path && plugin.enabled && !plugin.effectiveEnabled) ? 1_500 : 0;
  },
});
