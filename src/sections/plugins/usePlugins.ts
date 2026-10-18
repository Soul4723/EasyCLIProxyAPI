import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useCoreRuntime } from '../../coreRuntime';
import { useI18n } from '../../i18n';
import { pluginText } from '../../i18n/plugins';
import {
  pluginsApi, pluginStoreApi,
  type PluginListEntry, type PluginListResponse, type PluginStoreEntry, type PluginStoreResponse,
} from '../../services/plugins';
import {
  collectPluginResourceEntries, getPluginTitle, notifyPluginResourcesChanged, type PluginResourceEntry,
} from '../../services/pluginResources';
import { getPluginStatus, isPluginInstalled } from '../../services/pluginStatus';
import { getPluginStoreSources, pluginStoreSourceKey } from '../../services/pluginStoreSources';
import type { PluginTab } from './subs';

export type InstalledFilter = 'all' | 'updates' | 'local' | 'configOnly';
export type StoreFilter = 'all' | 'installed' | 'updates';
export type PluginNotice = { tone: 'success' | 'error'; text: string };
export type PluginStatusKey = ReturnType<typeof getPluginStatus>;
/** What the store knows about an installed plugin (only available once the store listing was read). */
export type InstalledStoreInfo = { entry: PluginStoreEntry; updateAvailable: boolean };

export const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * All plugin state and handlers for the Plugins section (the old PluginsPage logic, unchanged in behaviour):
 * list/store loading, global toggle, per-plugin enable, remove, resource pages, restart-core flow and the bounded
 * polling that follows plugins the core has not registered yet. Components only render and call handlers.
 */
export function usePlugins(tab: PluginTab) {
  const { t, locale } = useI18n();
  const { status: coreStatus } = useCoreRuntime();
  const remote = coreStatus?.connectionMode === 'remote';
  const pt = useCallback((key: Parameters<typeof pluginText>[0]) => pluginText(key, locale), [locale]);

  const [supported, setSupported] = useState<boolean | null>(null);
  const [data, setData] = useState<PluginListResponse | null>(null);
  const [store, setStore] = useState<PluginStoreResponse | null>(null);
  const [storeLoading, setStoreLoading] = useState(false);
  const [storeError, setStoreError] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState<PluginNotice | null>(null);
  const [installedSearch, setInstalledSearch] = useState('');
  const [storeSearch, setStoreSearch] = useState('');
  const [installedFilter, setInstalledFilter] = useState<InstalledFilter>('all');
  const [storeFilter, setStoreFilter] = useState<StoreFilter>('all');
  const [sourceFilter, setSourceFilter] = useState('');
  const [installedSource, setInstalledSource] = useState('');
  const [configPlugin, setConfigPlugin] = useState<PluginListEntry | null>(null);
  const [installEntry, setInstallEntry] = useState<PluginStoreEntry | null>(null);
  const [oauthPlugin, setOAuthPlugin] = useState<PluginListEntry | null>(null);
  const [removeTarget, setRemoveTarget] = useState<PluginListEntry | null>(null);
  const [restartOpen, setRestartOpen] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);
  const [resource, setResource] = useState<{ entry: PluginResourceEntry; url: string } | null>(null);
  const requests = useRef(0);
  const mounted = useRef(false);
  const pending = useRef(false);
  const storeBusy = useRef(false);
  const storeRef = useRef<PluginStoreResponse | null>(null);
  storeRef.current = store;
  const tabRef = useRef(tab);
  tabRef.current = tab;

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++requests.current; }; }, []);

  const notify = useCallback((text: string, tone: PluginNotice['tone'] = 'success') => setNotice({ tone, text }), []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  const applyStore = useCallback((next: PluginStoreResponse) => {
    setStore(next);
    setStoreError('');
    const known = (previous: string) => getPluginStoreSources(next).some(source => source.key === previous) ? previous : '';
    setSourceFilter(known); setInstalledSource(known);
  }, []);

  const load = useCallback(async (target: PluginTab = tabRef.current) => {
    const revision = ++requests.current;
    setLoading(true); setError('');
    try {
      const support = await invoke<boolean>('get_plugin_support');
      if (!mounted.current || revision !== requests.current) return;
      setSupported(support);
      if (!support) { setData(null); setStore(null); setResource(null); return; }
      const next = await pluginsApi.list();
      if (!mounted.current || revision !== requests.current) return;
      setData(next);
      notifyPluginResourcesChanged();
      setResource(previous => previous && collectPluginResourceEntries(next.plugins).some(entry => entry.pluginID === previous.entry.pluginID && entry.menuIndex === previous.entry.menuIndex && entry.menu.path === previous.entry.menu.path) ? previous : null);
      if (target === 'store') {
        const nextStore = await pluginStoreApi.list();
        if (mounted.current && revision === requests.current) applyStore(nextStore);
      } else if (storeRef.current) {
        // Keep update badges honest after a change; a failing store read must not hide the installed list.
        try {
          const nextStore = await pluginStoreApi.list();
          if (mounted.current && revision === requests.current) applyStore(nextStore);
        } catch (reason) { if (mounted.current && revision === requests.current) setStoreError(errorMessage(reason)); }
      }
    } catch (reason) { if (mounted.current && revision === requests.current) setError(errorMessage(reason)); }
    finally { if (mounted.current && revision === requests.current) setLoading(false); }
  }, [applyStore]);
  useEffect(() => { void load(tab); }, [tab, load]);

  /** Read the store listing on demand (the Updates filter needs it; the Store tab loads it through load()). */
  const ensureStore = useCallback(async () => {
    if (storeRef.current || storeBusy.current) return;
    storeBusy.current = true; setStoreLoading(true); setStoreError('');
    try {
      const next = await pluginStoreApi.list();
      if (mounted.current) applyStore(next);
    } catch (reason) { if (mounted.current) setStoreError(errorMessage(reason)); }
    finally { storeBusy.current = false; if (mounted.current) setStoreLoading(false); }
  }, [applyStore]);

  // Follow existing files for a bounded period after config writes. Missing
  // binaries cannot load by waiting, and the API does not report loading progress.
  const pendingPlugins = data?.pluginsEnabled
    ? data.plugins.filter(plugin => plugin.path && plugin.enabled && !plugin.effectiveEnabled).map(plugin => plugin.id).sort().join('|')
    : '';
  useEffect(() => {
    if (!pendingPlugins || busy || loading || restartRequired) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const revision = requests.current;
    const poll = async () => {
      try {
        const next = await pluginsApi.list();
        if (cancelled || requests.current !== revision) return;
        setData(next);
        notifyPluginResourcesChanged();
      } catch { /* The manual refresh exposes errors without replacing action feedback. */ }
      if (!cancelled && ++attempts < 8) timer = setTimeout(() => void poll(), 1500);
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [pendingPlugins, busy, loading, restartRequired]);

  const mutate = useCallback(async (operation: () => Promise<unknown>, success: string) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    ++requests.current;
    try {
      await operation();
      if (!mounted.current) return;
      notify(success);
      await load();
    } catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  }, [load, notify]);

  const setGlobalEnabled = (enabled: boolean) => void mutate(() => pluginsApi.updateSettings({ enabled }), pt('saved'));
  const setPluginEnabled = (plugin: PluginListEntry, enabled: boolean) =>
    void mutate(() => pluginsApi.updateEnabled(plugin.id, enabled), pt('saved'));

  const confirmRemove = async () => {
    const plugin = removeTarget;
    if (!plugin) return;
    const installed = isPluginInstalled(plugin);
    setRemoveTarget(null);
    await mutate(async () => {
      const result = await pluginsApi.deletePlugin(plugin.id);
      if (mounted.current && result.restartRequired) setRestartRequired(true);
    }, pt(installed ? 'removed' : 'removedConfig'));
  };

  const confirmRestart = async () => {
    setRestartOpen(false);
    await mutate(async () => { await invoke('restart_core_process'); if (mounted.current) setRestartRequired(false); }, pt('saved'));
  };

  const openResource = async (entry: PluginResourceEntry) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const url = await invoke<string>('get_plugin_resource_url', { pluginId: entry.pluginID, menuIndex: entry.menuIndex });
      if (mounted.current) setResource({ entry, url });
    } catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const openExternal = (url: string) => void invoke('open_external_url', { url }).catch(reason => { if (mounted.current) setError(errorMessage(reason)); });
  const openLogs = () => void invoke('open_core_logs_directory').catch(reason => { if (mounted.current) setError(errorMessage(reason)); });

  const onInstalled = (result: { restartRequired: boolean }) => {
    setInstallEntry(null);
    setRestartRequired(previous => previous || result.restartRequired);
    notify(pt('installedSuccess'));
    void load();
  };

  // What the store says about each installed plugin (version, source, update state).
  const storeInfo = useMemo(() => {
    const info = new Map<string, InstalledStoreInfo>();
    for (const entry of store?.plugins ?? []) {
      if (!entry.installed) continue;
      const existing = info.get(entry.id);
      // Prefer the registry the installed file came from when several registries list the same id.
      if (!existing || entry.installedSourceId === entry.sourceId) info.set(entry.id, { entry, updateAvailable: entry.updateAvailable });
    }
    return info;
  }, [store]);

  const matches = (search: string, values: (string | undefined)[]) => values.join(' ').toLowerCase().includes(search.trim().toLowerCase());
  const allPlugins = data?.plugins ?? [];
  const installedCount = allPlugins.filter(isPluginInstalled).length;
  const configOnlyCount = allPlugins.filter(plugin => plugin.configured && !isPluginInstalled(plugin)).length;
  const updatesCount = store ? allPlugins.filter(plugin => storeInfo.get(plugin.id)?.updateAvailable).length : undefined;
  const activeCount = allPlugins.filter(plugin => plugin.effectiveEnabled).length;
  const storeSources = useMemo(() => getPluginStoreSources(store), [store]);
  const plugins = allPlugins.filter(plugin => {
    if (!matches(installedSearch, [plugin.id, plugin.metadata?.name, plugin.metadata?.author])) return false;
    const installed = isPluginInstalled(plugin);
    if (installedFilter === 'local' && !installed) return false;
    if (installedFilter === 'configOnly' && installed) return false;
    if (installedFilter === 'updates' && !storeInfo.get(plugin.id)?.updateAvailable) return false;
    if (installedSource && store) {
      const info = storeInfo.get(plugin.id);
      if (!info || pluginStoreSourceKey(info.entry) !== installedSource) return false;
    }
    return true;
  });
  const storePlugins = (store?.plugins ?? []).filter(plugin => (!sourceFilter || pluginStoreSourceKey(plugin) === sourceFilter) && matches(storeSearch, [plugin.id, plugin.name, plugin.description, plugin.author, ...plugin.tags]) && (storeFilter === 'all' || (storeFilter === 'installed' && plugin.installed) || (storeFilter === 'updates' && plugin.updateAvailable)));

  const findInStore = (plugin: PluginListEntry) => {
    setStoreSearch(plugin.id); setStoreFilter('all'); setSourceFilter('');
  };
  const locked = busy || loading || Boolean(configPlugin || installEntry || oauthPlugin || removeTarget);

  return {
    t, pt, locale, remote,
    supported, data, store, loading, busy, locked, error, setError, notice, dismissNotice, notify,
    storeLoading, storeError, ensureStore,
    installedSearch, setInstalledSearch, storeSearch, setStoreSearch,
    installedFilter, setInstalledFilter, storeFilter, setStoreFilter, sourceFilter, setSourceFilter,
    installedSource, setInstalledSource,
    plugins, storePlugins, storeSources, storeInfo,
    installedCount, configOnlyCount, updatesCount, activeCount,
    configPlugin, setConfigPlugin, installEntry, setInstallEntry, oauthPlugin, setOAuthPlugin,
    removeTarget, setRemoveTarget, restartOpen, setRestartOpen, restartRequired,
    resource, setResource,
    load, setGlobalEnabled, setPluginEnabled, confirmRemove, confirmRestart, openResource, openExternal, openLogs,
    onInstalled, findInStore, getPluginTitle, getPluginStatus, isPluginInstalled,
  };
}

export type PluginsController = ReturnType<typeof usePlugins>;
