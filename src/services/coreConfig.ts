import { createDataSource, useDataSource } from './dataSource';
import { invoke } from './documentTarget';
import { useEffect, useRef } from 'react';

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

export const coreConfigSource = createDataSource({
  load: () => invoke<CoreConfigSettings>('get_core_config_settings'),
  events: ['config-files-changed'],
  minIntervalMs: 1_000,
});

export const extendedCoreConfigSource = createDataSource({
  load: () => invoke<Record<string, unknown>>('get_extended_core_config'),
  events: ['config-files-changed'],
  minIntervalMs: 1_000,
});

/** A Usage refresh invalidates the owner; mounting another consumer only subscribes. */
export function useSharedCoreConfig(refreshVersion?: number, enabled = true) {
  const snapshot = useDataSource(coreConfigSource, enabled);
  const previous = useRef(refreshVersion);
  useEffect(() => {
    if (previous.current !== refreshVersion) coreConfigSource.invalidate();
    previous.current = refreshVersion;
  }, [refreshVersion]);
  return snapshot;
}
