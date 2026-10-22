import { startCoreStatusPolling } from './services/coreStatusPolling';
import { windowActivity } from './services/windowActivity';
import { onCoreStatusChanged } from './services/events';
import { getCoreStatus } from './services/coreLifecycle';
import type { CoreStatus } from './services/coreLifecycle';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

export type { CoreStatus } from './services/coreLifecycle';

type CoreRuntimeContextValue = {
  status: CoreStatus | null;
  statusError: string;
  refreshStatus: () => Promise<void>;
  publishStatus: (status: CoreStatus | null) => void;
};

const CoreRuntimeContext = createContext<CoreRuntimeContextValue | null>(null);

export function CoreRuntimeProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<CoreStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const refreshRequest = useRef<Promise<void> | null>(null);
  const statusRevision = useRef(0);
  const reachable = useRef(true);

  const publishStatus = useCallback((nextStatus: CoreStatus | null) => {
    reachable.current = nextStatus !== null && (nextStatus.connectionMode !== 'remote' || nextStatus.ready
      || nextStatus.hostControl?.reachable === true);
    ++statusRevision.current;
    setStatus((previous) => JSON.stringify(previous) === JSON.stringify(nextStatus) ? previous : nextStatus);
    if (nextStatus) {
      setStatusError('');
    }
  }, []);

  const refreshStatus = useCallback(() => {
    if (refreshRequest.current) return refreshRequest.current;
    const revision = statusRevision.current;
    refreshRequest.current = getCoreStatus()
      .then((nextStatus) => {
        if (revision === statusRevision.current) publishStatus(nextStatus);
      })
      .catch((error) => {
        if (revision !== statusRevision.current) return;
        reachable.current = false;
        setStatus(null);
        setStatusError(String(error));
      })
      .finally(() => { refreshRequest.current = null; });
    return refreshRequest.current;
  }, [publishStatus]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    onCoreStatusChanged((event) => {
      if (!disposed && windowActivity.active()) {
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

    const stopPolling = startCoreStatusPolling(windowActivity, async () => {
      await refreshStatus();
      return reachable.current;
    });

    return () => {
      disposed = true;
      unlisten?.();
      stopPolling();
    };
  }, [publishStatus, refreshStatus]);

  const value = useMemo(
    () => ({ status, statusError, refreshStatus, publishStatus }),
    [publishStatus, refreshStatus, status, statusError],
  );

  return <CoreRuntimeContext.Provider value={value}>{children}</CoreRuntimeContext.Provider>;
}

// Pages rendered without the provider behave as Local.
export function useRemoteMode() {
  return useContext(CoreRuntimeContext)?.status?.connectionMode === 'remote';
}

// The remote core's host name in Remote mode; null while this app uses the core on this computer.
export function useRemoteCoreHost() {
  const status = useContext(CoreRuntimeContext)?.status;
  if (status?.connectionMode !== 'remote') return null;
  const origin = status.remoteOrigin ?? '';
  try { return new URL(origin).hostname; } catch { return origin; }
}

// Remote mode with a reachable remote host control: lifecycle actions go to the core's computer.
export function useRemoteHostControl() {
  const status = useContext(CoreRuntimeContext)?.status;
  return status?.connectionMode === 'remote' && status.hostControl?.reachable === true;
}

export function useCoreRuntime() {
  const context = useContext(CoreRuntimeContext);
  if (!context) {
    throw new Error('useCoreRuntime must be used inside CoreRuntimeProvider');
  }
  return context;
}
