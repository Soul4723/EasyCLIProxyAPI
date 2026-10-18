import { pluginListSource } from '../../services/pluginList';
import { useDataSource } from '../../services/dataSource';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '../../services/platform';
import { useCoreRuntime } from '../../coreRuntime';
import { useI18n } from '../../i18n';
import { pluginText } from '../../i18n/plugins';
import {
  pluginsApi, pluginStoreApi,
  type PluginListEntry, type PluginStoreEntry, type PluginStoreInstallResult, type PluginStoreResponse,
} from '../../services/plugins';
import {
  collectPluginResourceEntries, getPluginTitle, notifyPluginResourcesChanged, type PluginResourceEntry,
} from '../../services/pluginResources';
import { waitForPluginInstall, waitForPluginToggle, type PluginActionStatus } from '../../services/pluginPolling';
import { refreshPluginReleaseVersions } from '../../services/pluginReleaseVersions';
import { chooseLocalPluginFile, installLocalPlugin, PLUGIN_DEVELOPMENT_GUIDE_URL } from '../../services/pluginLocalInstall';
import { getPluginStatus, isPluginInstalled } from '../../services/pluginStatus';
import { getPluginStoreSources, pluginStoreSourceKey } from '../../services/pluginStoreSources';
import { pluginPagePath } from '../../services/pluginNavigation';
import { navigate, routePath } from '../../shell/router';
import type { PluginTab } from './subs';

export type InstalledFilter = 'all' | 'updates' | 'local' | 'configOnly';
export type StoreFilter = 'all' | 'installed' | 'updates';
export type PluginNotice = { tone: 'success' | 'error' | 'info'; text: string };
export type PluginStatusKey = ReturnType<typeof getPluginStatus>;
/** What the store knows about an installed plugin (only available once the store listing was read). */
export type InstalledStoreInfo = { entry: PluginStoreEntry; updateAvailable: boolean };

/** Replaces the version / update state of installed store entries with the latest GitHub release (the store index can lag behind). */
async function withLatestReleases(store: PluginStoreResponse, installedPlugins: PluginListEntry[]): Promise<PluginStoreResponse> {
  const installedIds = new Set(installedPlugins.filter(isPluginInstalled).map(plugin => plugin.id));
  const refreshed = await refreshPluginReleaseVersions({ ...store, plugins: store.plugins.filter(entry =>
    installedIds.has(entry.id) && entry.installed && ['matched', 'assumed'].includes(entry.installSourceStatus),
  ) });
  const byKey = new Map(refreshed.plugins.map(entry => [entry.storeId, entry]));
  return { ...store, plugins: store.plugins.map(entry => byKey.get(entry.storeId) ?? entry), sourceErrors: refreshed.sourceErrors };
}

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

  const pluginSource = useDataSource(pluginListSource);
  const supported = pluginSource.data?.supported ?? null;
  const data = pluginSource.data?.list ?? null;
  const [store, setStore] = useState<PluginStoreResponse | null>(null);
  const [storeLoading, setStoreLoading] = useState(false);
  const [storeError, setStoreError] = useState('');
  const loading = pluginSource.loading;
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
  const [localInstallFile, setLocalInstallFile] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
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

  const load = useCallback(async (target: PluginTab = tabRef.current, refreshVersions = false, initial = false) => {
    const revision = ++requests.current;
    setError('');
    try {
      await (initial ? pluginListSource.load() : pluginListSource.refresh());
      if (!mounted.current || revision !== requests.current) return;
      const state = pluginListSource.getSnapshot();
      if (state.error) throw new Error(state.error);
      if (!state.data?.supported) { setStore(null); return; }
      const next = state.data.list!;
      if (target === 'store') {
        const nextStore = await pluginStoreApi.list();
        if (mounted.current && revision === requests.current) applyStore(nextStore);
      } else if (storeRef.current || (target === 'installed' && refreshVersions)) {
        // Keep update badges honest after a change; a failing store read must not hide the installed list.
        // An explicit refresh on the installed tab also asks GitHub for the latest release of each installed plugin.
        try {
          const nextStore = await pluginStoreApi.list();
          if (!mounted.current || revision !== requests.current) return;
          applyStore(target === 'installed' && refreshVersions ? await withLatestReleases(nextStore, next.plugins) : nextStore);
        } catch (reason) { if (mounted.current && revision === requests.current) setStoreError(errorMessage(reason)); }
      }
    } catch (reason) { if (mounted.current && revision === requests.current) setError(errorMessage(reason)); }
  }, [applyStore]);
  useEffect(() => { void load(tab, false, true); }, [tab, load]);

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
  /** A successful write is not proof the runtime applied it: follow the plugin for a bounded time and report what the core says. */
  const reportStatus = (status: PluginActionStatus, success: string) => {
    if (!mounted.current || status === 'cancelled') return;
    if (status === 'ready') notify(success);
    else notify(status === 'restart' ? pt('restart') : status === 'globalDisabled' ? pt('disabledHint') : t('sec.plugins.runtimePending'), 'info');
  };
  const setPluginEnabled = async (plugin: PluginListEntry, enabled: boolean) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    ++requests.current;
    let written = false;
    try {
      await pluginsApi.updateEnabled(plugin.id, enabled);
      written = true;
      const status = await waitForPluginToggle(plugin.id, enabled, () => !mounted.current);
      reportStatus(status, t('sec.plugins.runtimeReady'));
      if (mounted.current) await load();
    } catch (reason) {
      if (mounted.current) setError(`${written ? pt('refreshFailed') + ' ' : ''}${errorMessage(reason)}`);
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };

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

  // A plugin's menu page is a native webview page with its own sidebar entry (#/plugin/<id>), not an inline frame.
  const openResource = (entry: PluginResourceEntry) => navigate(pluginPagePath(entry));
  const openExternal = (url: string) => void invoke('open_external_url', { url }).catch(reason => { if (mounted.current) setError(errorMessage(reason)); });
  const openLogs = () => void invoke('open_core_logs_directory').catch(reason => { if (mounted.current) setError(errorMessage(reason)); });

  const openDevelopmentGuide = () => openExternal(PLUGIN_DEVELOPMENT_GUIDE_URL);

  /** Local install: pick a plugin library, confirm (trust warning), copy it into the plugin directory. Not available for a remote core. */
  const chooseLocalInstall = async () => {
    if (remote || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      const selected = await chooseLocalPluginFile(t('sec.plugins.localInstall'), t('sec.plugins.localBinary'));
      if (selected && mounted.current) setLocalInstallFile(selected);
    } catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  const confirmLocalInstall = async () => {
    const source = localInstallFile;
    setLocalInstallFile(null);
    if (!source || remote || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    ++requests.current;
    try {
      const path = await installLocalPlugin(source);
      if (!mounted.current) return;
      setRestartRequired(true);
      notify(`${t('sec.plugins.localInstalled')} ${path}`);
      notifyPluginResourcesChanged();
      navigate(routePath('plugins'));
      await load('installed');
    } catch (reason) { if (mounted.current) setError(errorMessage(reason)); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };

  /** Install already succeeded when this runs: wait (bounded) for the runtime to pick the plugin up, never invite a duplicate install. */
  const onInstalled = async (result: PluginStoreInstallResult) => {
    ++requests.current;
    setRestartRequired(previous => previous || result.restartRequired);
    try {
      reportStatus(await waitForPluginInstall(result, () => !mounted.current), pt('installedSuccess'));
    } catch (reason) {
      if (mounted.current) notify(`${pt('refreshFailed')} ${errorMessage(reason)}`, 'info');
    } finally {
      if (mounted.current) { setInstallEntry(null); notifyPluginResourcesChanged(); }
    }
    if (mounted.current) await load();
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
  const locked = busy || loading || Boolean(configPlugin || installEntry || oauthPlugin || removeTarget || localInstallFile);

  return {
    t, pt, locale, remote,
    supported, data, store, loading, busy, locked, error: error || pluginSource.error || '', setError, notice, dismissNotice, notify,
    storeLoading, storeError, ensureStore,
    installedSearch, setInstalledSearch, storeSearch, setStoreSearch,
    installedFilter, setInstalledFilter, storeFilter, setStoreFilter, sourceFilter, setSourceFilter,
    installedSource, setInstalledSource,
    plugins, storePlugins, storeSources, storeInfo,
    installedCount, configOnlyCount, updatesCount, activeCount,
    configPlugin, setConfigPlugin, installEntry, setInstallEntry, oauthPlugin, setOAuthPlugin,
    removeTarget, setRemoveTarget, restartOpen, setRestartOpen, restartRequired,
    load, setGlobalEnabled, setPluginEnabled, confirmRemove, confirmRestart, openResource, openExternal, openLogs,
    localInstallFile, setLocalInstallFile, chooseLocalInstall, confirmLocalInstall, openDevelopmentGuide,
    onInstalled, findInStore, getPluginTitle, getPluginStatus, isPluginInstalled,
  };
}

export type PluginsController = ReturnType<typeof usePlugins>;
