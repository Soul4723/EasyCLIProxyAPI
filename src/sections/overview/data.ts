import { coreConfigSource, useSharedCoreConfig } from '../../services/coreConfig';
import { CORE_CONFIG_SCOPES, configChangeFilter, listenConfigChange } from '../../services/configChange';
import { credentialsSource } from '../../services/credentials';
import { createDataSource, useDataSource } from '../../services/dataSource';
// Data hooks for the Overview. Everything comes from the real services; the Overview owns no state of its own
// beyond what it reads (connection/runtime details, a credentials snapshot, usage 24h, lighting schedules).
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../../services/documentTarget';
import { type AuthFileRecord } from '../../services/authFiles';
import { getCoreConnection, type CoreConnection } from '../../services/coreConnection';
import { countHomeProviderKeys, normalizeHomeModels, summarizeHomeUsage, type HomeUsageSummary } from '../../services/homeOverview';
import type { CoreHealthModel } from '../../services/coreHealthCheck';
import { lightingSource, type LightingSchedule } from '../../services/lighting';
import { managementApi } from '../../services/managementApi';

type GuiSettings = { host: string; port: number };
type CoreTlsSettings = { enabled: boolean };

export type RuntimeDetails = {
  connection: CoreConnection | null;
  host: string;
  port: number;
  tls: boolean;
  /** undefined = loading, null = none configured, string = first client API key (raw; mask when displayed). */
  clientKey: string | null | undefined;
  clientKeyError: boolean;
  /** Bumps when the core config files change on disk. */
  configRevision: number;
  error: string;
};

const INITIAL_DETAILS: RuntimeDetails = {
  connection: null, host: '127.0.0.1', port: 8317, tls: false, clientKey: undefined, clientKeyError: false, configRevision: 0, error: '',
};

/** Connection mode, listen host/port, TLS and the first client key (local mode only). */
export function useRuntimeDetails(): RuntimeDetails & { reload: () => void } {
  const [details, setDetails] = useState<RuntimeDetails>(INITIAL_DETAILS);
  const config = useSharedCoreConfig(undefined, details.connection?.mode === 'local');
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    let connection: CoreConnection;
    try { connection = await getCoreConnection(); } catch (error) {
      if (id === request.current) setDetails(current => ({ ...current, error: errorText(error) }));
      return;
    }
    if (id !== request.current) return;
    if (connection.mode !== 'local') {
      setDetails((current) => ({ ...current, connection, clientKey: connection.clientKey || null, clientKeyError: false, error: '' }));
      return;
    }
    const [gui, tls] = await Promise.allSettled([
      invoke<GuiSettings>('get_gui_settings'),
      invoke<CoreTlsSettings>('get_core_tls_settings'),
    ]);
    if (id !== request.current) return;
    setDetails((current) => ({
      ...current,
      error: [gui, tls].filter(result => result.status === 'rejected').map(result => errorText((result as PromiseRejectedResult).reason)).join('; '),
      connection,
      host: gui.status === 'fulfilled' ? gui.value.host : current.host,
      port: gui.status === 'fulfilled' ? gui.value.port : current.port,
      tls: tls.status === 'fulfilled' ? tls.value.enabled : current.tls,
    }));
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listenConfigChange(CORE_CONFIG_SCOPES, () => {
      if (disposed) return;
      setDetails((current) => ({ ...current, configRevision: current.configRevision + 1 }));
      void load();
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; });
    void load();
    return () => { disposed = true; request.current++; unlisten?.(); };
  }, [load]);

  return { ...details,
    clientKey: details.connection?.mode === 'local' ? config.data ? config.data.apiKeys[0]?.apiKey ?? null : undefined : details.clientKey,
    clientKeyError: details.connection?.mode === 'local' && !!config.error,
    error: [details.error, details.connection?.mode === 'local' ? config.error : null].filter(Boolean).join('; '),
    reload: () => { if (details.connection?.mode === 'local') coreConfigSource.invalidate(); void load(); },
  };
}

export type OverviewSnapshot = {
  files: AuthFileRecord[];
  filesReceivedAt: number;
  schedules: LightingSchedule[];
  usage: HomeUsageSummary | null;
  series: number[];
  models: CoreHealthModel[];
  /** API-key provider configs (null = unknown). */
  providerKeys: number | null;
  /** Set when the credentials list failed (the lists below are then empty, not "all fine"). */
  credentialsError: string;
  usageError: string;
  blockErrors: string[];
};

const errorText = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

async function loadProviderKeys(): Promise<number> {
  try {
    return countHomeProviderKeys(await managementApi.get('/config/api-keys'));
  } catch (error) {
    // An omitted optional config node is reported as this exact 404; other failures stay unknown.
    if (errorText(error) === 'Management API error (404): not_found') return 0;
    throw error;
  }
}

async function loadUsage(nowMs: number): Promise<{ usage: HomeUsageSummary; series: number[] }> {
  const payload = await invoke<{ timeline?: Array<{ requests: number }> }>('get_usage_overview', {
    query: { start: new Date(nowMs - 24 * 3_600_000).toISOString(), end: new Date(nowMs).toISOString() },
  });
  return {
    usage: summarizeHomeUsage(payload),
    series: (payload.timeline ?? []).map((point) => point.requests),
  };
}

const usageSource = createDataSource({
  load: () => loadUsage(Date.now()), events: ['usage-records-updated'], minIntervalMs: 10_000,
});
export const modelsSource = createDataSource({
  load: () => invoke<unknown>('get_core_models').then(normalizeHomeModels), events: ['config-files-changed'], eventFilter: configChangeFilter(CORE_CONFIG_SCOPES), minIntervalMs: 1_000,
});
export const providerKeysSource = createDataSource({
  load: loadProviderKeys, events: ['config-files-changed'], eventFilter: configChangeFilter(CORE_CONFIG_SCOPES), minIntervalMs: 1_000,
});

/** Blocks retain their own last successful value and expose failure independently. */
export function useOverviewSnapshot(coreReady: boolean) {
  const files = useDataSource(credentialsSource, coreReady);
  const lighting = useDataSource(lightingSource, coreReady);
  const usage = useDataSource(usageSource);
  const models = useDataSource(modelsSource, coreReady);
  const keys = useDataSource(providerKeysSource, coreReady);
  const snapshot: OverviewSnapshot = {
    files: files.data?.files ?? [], filesReceivedAt: files.data?.receivedAtMs ?? 0,
    schedules: lighting.data?.schedules ?? [], usage: usage.data?.usage ?? null, series: usage.data?.series ?? [],
    models: models.data ?? [], providerKeys: keys.data ?? null,
    credentialsError: files.error ?? '', usageError: usage.error ?? '',
    blockErrors: [lighting.error, lighting.data?.status.error, models.error, keys.error].filter((error): error is string => !!error),
  };
  const refresh = useCallback(() => {
    void usageSource.refresh();
    if (coreReady) {
      void credentialsSource.refresh(); void lightingSource.refresh();
      void modelsSource.refresh(); void providerKeysSource.refresh();
    }
  }, [coreReady]);
  return { snapshot, loading: usage.loading || (coreReady && (files.loading || lighting.loading || models.loading || keys.loading)), refresh };
}
