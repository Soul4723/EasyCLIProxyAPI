import { coreConfigSource, extendedCoreConfigSource } from './services/coreConfig';
import { getCoreConnection, type CoreConnection } from './services/coreConnection';
import { createDataSource, useDataSource, type DataSource } from './services/dataSource';
import { credentialsSource } from './services/credentials';
import { pluginListSource } from './services/pluginList';
import { lightingSource } from './services/lighting';
import { invalidateQuotaCache } from './services/quotaCache';
import { invalidateQuotaRequests } from './services/quotaService';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from './services/platform';
import { listen } from './services/platform';

export type CoreStatus = {
  connectionMode?: 'local' | 'remote';
  remoteOrigin?: string | null;
  installed: boolean;
  running: boolean;
  ready: boolean;
  starting: boolean;
  managed: boolean;
  processId: number | null;
  currentVersion: string | null;
  installDir: string;
  binaryPath: string | null;
  message: string;
  recovery?: {
    phase: 'waiting' | 'restarting' | 'failed';
    attempt: number;
    /** Supervisor restart budget; absent in payloads from older builds. */
    limit?: number;
    delaySeconds: number;
    detail: string;
  } | null;
};

type CoreRuntimeContextValue = {
  status: CoreStatus | null;
  statusError: string;
  connection: CoreConnection | null;
  connectionRevision: number;
  refreshStatus: () => Promise<void>;
  publishStatus: (status: CoreStatus | null) => void;
};

const CoreRuntimeContext = createContext<CoreRuntimeContextValue | null>(null);

export function CoreRuntimeProvider({ children }: { children: ReactNode }) {
  const [connectionRevision, setConnectionRevision] = useState(0);
  const [connection, setConnection] = useState<CoreConnection | null>(null);
  const connectionRef = useRef(connection);
  connectionRef.current = connection;
  const source: DataSource<CoreStatus> = useMemo(() => createDataSource<CoreStatus>({
    load: () => invoke<CoreStatus>('get_core_status'),
    pollMs: () => connectionRef.current?.mode === 'remote' || source.getSnapshot().data?.connectionMode === 'remote' ? 15_000 : 30_000,
    maxPollMs: 60_000,
    focusMs: 10_000,
    subscribeEvents: () => {
      let disposed = false;
      let stop: (() => void) | undefined;
      // get_core_status emits this event too: publish its payload, never invalidate/refetch it.
      void listen<CoreStatus>('core-status-changed', event => {
        if (!disposed) source.mutate(() => event.payload);
      }).then(off => { if (disposed) off(); else stop = off; });
      return () => { disposed = true; stop?.(); };
    },
  }), []);
  const snapshot = useDataSource(source);
  const previousRuntime = useRef<CoreStatus | undefined>(undefined);
  useEffect(() => {
    const next = snapshot.data;
    const previous = previousRuntime.current;
    previousRuntime.current = next;
    if (next?.ready && previous && (!previous.ready || previous.processId !== next.processId)) {
      coreConfigSource.invalidate(); extendedCoreConfigSource.invalidate();
    }
  }, [snapshot.data]);

  useEffect(() => {
    let active = true;
    void getCoreConnection().then(config => {
      if (active) { connectionRef.current = config; setConnection(config); }
    }).catch(() => { /* Status remains independently available if connection metadata cannot be read. */ });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen('core-connection-changed', () => {
      if (disposed) return;
      invalidateQuotaRequests(); invalidateQuotaCache();
      credentialsSource.reset(); lightingSource.reset(); pluginListSource.reset();
      coreConfigSource.reset(); extendedCoreConfigSource.reset();
      source.reset();
      setConnectionRevision(value => value + 1);
    }).then(off => { if (disposed) off(); else stop = off; });
    return () => { disposed = true; stop?.(); };
  }, [source]);
  const publishStatus = useCallback((status: CoreStatus | null) => {
    if (status) source.mutate(() => status); else source.reset();
  }, [source]);
  const value = useMemo(() => ({
    status: snapshot.data ?? null, statusError: snapshot.error ?? '', connection, connectionRevision,
    refreshStatus: source.refresh, publishStatus,
  }), [snapshot.data, snapshot.error, connection, connectionRevision, source, publishStatus]);
  return <CoreRuntimeContext.Provider value={value}>{children}</CoreRuntimeContext.Provider>;
}

export function useCoreRuntime() {
  const context = useContext(CoreRuntimeContext);
  if (!context) {
    throw new Error('useCoreRuntime must be used inside CoreRuntimeProvider');
  }
  return context;
}

// Standalone agent-page fixtures have no runtime provider.
export function useCoreTargetRevision() {
  return useContext(CoreRuntimeContext)?.connectionRevision ?? 0;
}
