// Plugin-declared OAuth providers: the list/refresh logic of the old PluginOAuthProviders card grid, as a hook.
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { pluginsApi, type PluginListEntry } from '../../../services/plugins';
import { collectPluginOAuthProviders } from '../../../services/pluginOAuthProviders';
import { PLUGIN_RESOURCES_REFRESH_EVENT } from '../../../services/pluginResources';

export type PluginOAuthProvidersState = {
  plugins: PluginListEntry[];
  loading: boolean;
  error: boolean;
  reload: () => Promise<void> | undefined;
};

/**
 * Loads plugins that declare an OAuth provider (enabled, registered, unique, not a built-in id). Refreshes on window
 * focus and on PLUGIN_RESOURCES_REFRESH_EVENT, ignores stale responses, and follows a plugin that is installed but
 * not yet registered with a bounded retry. A failing plugin system leaves the list empty and sets `error`.
 */
export function usePluginOAuthProviders(builtInProviderIds: readonly string[]): PluginOAuthProvidersState {
  const [plugins, setPlugins] = useState<PluginListEntry[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const revision = useRef(0);
  const mounted = useRef(false);
  const retryTimer = useRef<number | undefined>(undefined);

  const load = useCallback(() => {
    window.clearTimeout(retryTimer.current);
    const current = ++revision.current;
    setLoading(true);
    setError(false);
    const active = () => mounted.current && current === revision.current;
    const refresh = async (attempt: number): Promise<void> => {
      try {
        if (attempt === 0) {
          const supported = await invoke<boolean>('get_plugin_support');
          if (!active()) return;
          if (!supported) {
            setPlugins([]);
            return;
          }
        }
        const response = await pluginsApi.list();
        if (!active()) return;
        setPlugins(response.pluginsEnabled
          ? collectPluginOAuthProviders(response.plugins, builtInProviderIds) : []);
        // Installation can finish before the core registers the plugin. Keep following that transition even if the
        // user has already left the plugin manager.
        if (attempt < 8 && response.pluginsEnabled
          && response.plugins.some((plugin) => plugin.path && plugin.enabled && !plugin.effectiveEnabled)) {
          retryTimer.current = window.setTimeout(() => {
            if (active()) void refresh(attempt + 1);
          }, 1500);
        }
      } catch {
        if (active()) {
          setPlugins([]);
          setError(true);
        }
      } finally {
        if (active()) setLoading(false);
      }
    };
    return refresh(0);
  }, [builtInProviderIds]);

  useEffect(() => {
    mounted.current = true;
    const refresh = () => { void load(); };
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener(PLUGIN_RESOURCES_REFRESH_EVENT, refresh);
    return () => {
      mounted.current = false;
      ++revision.current;
      window.clearTimeout(retryTimer.current);
      window.removeEventListener('focus', refresh);
      window.removeEventListener(PLUGIN_RESOURCES_REFRESH_EVENT, refresh);
    };
  }, [load]);

  return { plugins, loading, error, reload: load };
}
