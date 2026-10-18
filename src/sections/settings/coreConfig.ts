import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { invoke } from '../../services/documentTarget';
import { listen } from '@tauri-apps/api/event';

/** Core config values returned by `get_core_config_settings` and by every native save command. */
export type CoreApiKey = { apiKey: string; remark: string };
export type CoreConfigSettings = {
  managementSecretConfigured: boolean;
  apiKeys: CoreApiKey[];
  debug: boolean;
  commercialMode: boolean;
  loggingToFile: boolean;
  logsMaxTotalSizeMb: number;
  errorLogsMaxFiles: number;
  usageStatisticsEnabled: boolean;
  redisUsageQueueRetentionSeconds: number;
  host: string;
  port: number;
  allowLan: boolean;
  routingStrategy: string;
  proxyUrl: string;
  proxyOverride: boolean;
  routingSessionAffinity: boolean;
  routingSessionAffinityTtl: string;
  disableCooling: boolean;
  requestRetry: number;
  maxRetryCredentials: number;
  maxRetryInterval: number;
  streamingBootstrapRetries: number;
};

export type CoreConfigApi = {
  settings: CoreConfigSettings | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
  /** Replace the cached settings with the value a save command returned. */
  apply: (next: CoreConfigSettings) => void;
};

export const CoreConfigContext = createContext<CoreConfigApi | null>(null);

export function useCoreConfig(): CoreConfigApi {
  const api = useContext(CoreConfigContext);
  if (!api) throw new Error('useCoreConfig must be used inside the Settings page');
  return api;
}

/** Loads core config once for the page and refreshes it when the config files change on disk. */
export function useCoreConfigLoader(): CoreConfigApi {
  const [settings, setSettings] = useState<CoreConfigSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const reload = useCallback(async () => {
    const request = ++revision.current;
    setLoading(true);
    try {
      const value = await invoke<CoreConfigSettings>('get_core_config_settings');
      if (request !== revision.current) return;
      setSettings(value); setError('');
    } catch (cause) {
      if (request !== revision.current) return;
      setSettings(null); setError(String(cause));
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void reload();
    void listen('config-files-changed', () => { if (!disposed) void reload(); }).then((unlisten) => {
      if (disposed) unlisten(); else stop = unlisten;
    });
    return () => { disposed = true; stop?.(); };
  }, [reload]);
  const apply = useCallback((next: CoreConfigSettings) => { revision.current++; setSettings(next); setError(''); setLoading(false); }, []);
  return { settings, loading, error, reload, apply };
}
