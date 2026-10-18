import { invalidateQuotaCache } from './services/quotaCache';
import { invalidateQuotaRequests } from './services/quotaService';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

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
  connectionRevision: number;
  refreshStatus: () => Promise<void>;
  publishStatus: (status: CoreStatus | null) => void;
};

const CoreRuntimeContext = createContext<CoreRuntimeContextValue | null>(null);

export function CoreRuntimeProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<CoreStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [connectionRevision, setConnectionRevision] = useState(0);
  const refreshRequest = useRef<Promise<void> | null>(null);
  const statusRevision = useRef(0);

  const publishStatus = useCallback((nextStatus: CoreStatus | null) => {
    ++statusRevision.current;
    setStatus((previous) => JSON.stringify(previous) === JSON.stringify(nextStatus) ? previous : nextStatus);
    if (nextStatus) {
      setStatusError('');
    }
  }, []);

  const refreshStatus = useCallback(() => {
    if (refreshRequest.current) return refreshRequest.current;
    const revision = statusRevision.current;
    const request = invoke<CoreStatus>('get_core_status')
      .then((nextStatus) => {
        if (revision === statusRevision.current) publishStatus(nextStatus);
      })
      .catch((error) => {
        if (revision !== statusRevision.current) return;
        setStatus(null);
        setStatusError(String(error));
      })
      .finally(() => { if (refreshRequest.current === request) refreshRequest.current = null; });
    refreshRequest.current = request;
    return request;
  }, [publishStatus]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let unlistenConnection: (() => void) | null = null;
    listen('core-connection-changed', () => {
      if (disposed) return;
      ++statusRevision.current;
      invalidateQuotaRequests();
      invalidateQuotaCache();
      refreshRequest.current = null;
      setStatus(null);
      setStatusError('');
      setConnectionRevision(value => value + 1);
      void refreshStatus();
    }).then(stop => { if (disposed) stop(); else unlistenConnection = stop; }).catch(error => { if (!disposed) setStatusError(String(error)); });

    listen<CoreStatus>('core-status-changed', (event) => {
      if (!disposed) {
        publishStatus(event.payload);
      }
    }).then((stop) => {
      if (disposed) {
        stop();
      } else {
        unlisten = stop;
      }
    }).catch((error) => {
      if (!disposed) {
        setStatusError(String(error));
      }
    });

    void refreshStatus();
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        void refreshStatus();
      }
    }, 10_000);

    return () => {
      disposed = true;
      unlisten?.();
      unlistenConnection?.();
      window.clearInterval(timer);
    };
  }, [publishStatus, refreshStatus]);

  const value = useMemo(
    () => ({ status, statusError, connectionRevision, refreshStatus, publishStatus }),
    [connectionRevision, publishStatus, refreshStatus, status, statusError],
  );

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
