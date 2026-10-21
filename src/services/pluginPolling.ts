import { pluginListSource } from './pluginList';
import { pluginStoreApi, type PluginListResponse, type PluginStoreInstallResult } from './plugins';

export type PluginActionStatus = 'ready' | 'globalDisabled' | 'restart' | 'pending' | 'cancelled';

/** A successful write is not evidence that the runtime has applied it.
 * Intentional bounded action reconciliation, not a subscribed data resource: the
 * caller awaits one outcome with its own cancellation/deadline (including hidden
 * windows). The plugin list itself is owned by pluginListSource.
 */
export async function waitForPluginAction(
  check: () => Promise<PluginActionStatus>,
  cancelled: () => boolean = () => false,
  timeoutMs = 15_000,
  intervalMs = 500,
): Promise<PluginActionStatus> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (cancelled()) return 'cancelled';
    const status = await check();
    if (cancelled()) return 'cancelled';
    if (status !== 'pending' || Date.now() >= deadline) return status;
    await new Promise(resolve => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
}

export function pluginToggleStatus(response: PluginListResponse, id: string, enabled: boolean): PluginActionStatus {
  const plugin = response.plugins.find(item => item.id === id);
  if (!plugin || plugin.enabled !== enabled) return 'pending';
  if (!enabled) return plugin.effectiveEnabled ? 'pending' : 'ready';
  if (!response.pluginsEnabled) return 'globalDisabled';
  return plugin.registered && plugin.effectiveEnabled ? 'ready' : 'pending';
}

export async function waitForPluginToggle(id: string, enabled: boolean, cancelled: () => boolean) {
  await pluginListSource.refresh();
  return waitForPluginAction(async () => {
    await pluginListSource.load();
    const source = pluginListSource.getSnapshot();
    if (source.error) throw new Error(source.error);
    return source.data?.list ? pluginToggleStatus(source.data.list, id, enabled) : 'pending';
  }, cancelled, 15_000, 1_500);
}

export async function waitForPluginInstall(result: PluginStoreInstallResult, cancelled: () => boolean): Promise<PluginActionStatus> {
  // A restart is authoritative: polling cannot make a restart-required install active.
  if (result.restartRequired) return 'restart';
  return waitForPluginAction(async () => {
    const response = await pluginStoreApi.list();
    const plugin = response.plugins.find(item => item.id === result.id && item.sourceId === result.sourceId);
    if (!plugin?.installed || !plugin.configured) return 'pending';
    const normalize = (version: string) => version.replace(/^[vV](?=\d)/, '');
    if (result.version && normalize(plugin.installedVersion) !== normalize(result.version)) return 'pending';
    if (!response.pluginsEnabled) return 'globalDisabled';
    if (!plugin.enabled) return 'ready';
    return plugin.registered && plugin.effectiveEnabled ? 'ready' : 'pending';
  }, cancelled);
}
