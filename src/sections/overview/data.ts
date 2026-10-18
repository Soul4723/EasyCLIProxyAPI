// Data hooks for the Overview. Everything comes from the real services; the Overview owns no state of its own
// beyond what it reads (connection/runtime details, a credentials snapshot, usage 24h, lighting schedules).
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '../../services/documentTarget';
import { listen } from '../../services/platform';
import { dedupeAuthFiles, type AuthFileRecord } from '../../services/authFiles';
import { getCoreConnection, type CoreConnection } from '../../services/coreConnection';
import { countHomeProviderKeys, normalizeHomeModels, summarizeHomeUsage, type HomeUsageSummary } from '../../services/homeOverview';
import type { CoreHealthModel } from '../../services/coreHealthCheck';
import { listLightingSchedules, listenForLightingRunResult, type LightingSchedule } from '../../services/lighting';
import { managementApi, responseList } from '../../services/managementApi';

type GuiSettings = { host: string; port: number };
type CoreConfigSummary = { apiKeys: Array<{ apiKey: string }> };
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
};

const INITIAL_DETAILS: RuntimeDetails = {
  connection: null, host: '127.0.0.1', port: 8317, tls: false, clientKey: undefined, clientKeyError: false, configRevision: 0,
};

/** Connection mode, listen host/port, TLS and the first client key (local mode only). */
export function useRuntimeDetails(refreshStatus: () => Promise<void>): RuntimeDetails & { reload: () => void } {
  const [details, setDetails] = useState<RuntimeDetails>(INITIAL_DETAILS);
  const refreshRef = useRef(refreshStatus);
  refreshRef.current = refreshStatus;

  const load = useCallback(async () => {
    let connection: CoreConnection;
    try { connection = await getCoreConnection(); } catch { return; }
    if (connection.mode !== 'local') {
      setDetails((current) => ({ ...current, connection, clientKey: connection.clientKey || null, clientKeyError: false }));
      return;
    }
    const [gui, tls, config] = await Promise.allSettled([
      invoke<GuiSettings>('get_gui_settings'),
      invoke<CoreTlsSettings>('get_core_tls_settings'),
      invoke<CoreConfigSummary>('get_core_config_settings'),
    ]);
    setDetails((current) => ({
      ...current,
      connection,
      host: gui.status === 'fulfilled' ? gui.value.host : current.host,
      port: gui.status === 'fulfilled' ? gui.value.port : current.port,
      tls: tls.status === 'fulfilled' ? tls.value.enabled : false,
      clientKey: config.status === 'fulfilled' ? config.value.apiKeys[0]?.apiKey ?? null : undefined,
      clientKeyError: config.status === 'rejected',
    }));
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void listen('config-files-changed', () => {
      if (disposed) return;
      setDetails((current) => ({ ...current, configRevision: current.configRevision + 1 }));
      void load();
      void refreshRef.current();
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; });
    void load();
    return () => { disposed = true; unlisten?.(); };
  }, [load]);

  return { ...details, reload: () => void load() };
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
};

const EMPTY: OverviewSnapshot = {
  files: [], filesReceivedAt: 0, schedules: [], usage: null, series: [], models: [], providerKeys: null, credentialsError: '', usageError: '',
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

/** 60s polling snapshot of what the Overview summarises. Usage is local and works while the core is stopped. */
export function useOverviewSnapshot(coreReady: boolean, contextKey: string) {
  const [snapshot, setSnapshot] = useState<OverviewSnapshot>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const scope = `${coreReady}:${contextKey}`;

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const load = async (showLoading: boolean) => {
      if (inFlight) return;
      inFlight = true;
      if (showLoading) setLoading(true);
      const now = Date.now();
      const [files, schedules, usage, models, providerKeys] = await Promise.allSettled([
        coreReady ? managementApi.get('/credentials').then((payload) => dedupeAuthFiles(responseList(payload, 'files'))) : Promise.resolve([] as AuthFileRecord[]),
        coreReady ? listLightingSchedules() : Promise.resolve([] as LightingSchedule[]),
        loadUsage(now),
        coreReady ? invoke<unknown>('get_core_models').then(normalizeHomeModels) : Promise.resolve([] as CoreHealthModel[]),
        coreReady ? loadProviderKeys() : Promise.resolve(null),
      ]);
      inFlight = false;
      if (!active) return;
      setSnapshot({
        files: files.status === 'fulfilled' ? files.value : [],
        filesReceivedAt: now,
        schedules: schedules.status === 'fulfilled' ? schedules.value : [],
        usage: usage.status === 'fulfilled' ? usage.value.usage : null,
        series: usage.status === 'fulfilled' ? usage.value.series : [],
        models: models.status === 'fulfilled' ? models.value : [],
        providerKeys: providerKeys.status === 'fulfilled' ? providerKeys.value : null,
        credentialsError: files.status === 'rejected' ? errorText(files.reason) : '',
        usageError: usage.status === 'rejected' ? errorText(usage.reason) : '',
      });
      setLoading(false);
    };
    void load(true);
    const timer = window.setInterval(() => { if (!document.hidden) void load(false); }, 60_000);
    // A finished light changes needs-action/coming-up straight away.
    let stopLight: (() => void) | null = null;
    void listenForLightingRunResult(() => { void load(false); }).then((stop) => { if (active) stopLight = stop; else stop(); }).catch(() => undefined);
    return () => { active = false; window.clearInterval(timer); stopLight?.(); };
  }, [coreReady, scope, revision]);

  return { snapshot, loading, refresh: useCallback(() => setRevision((value) => value + 1), []) };
}
