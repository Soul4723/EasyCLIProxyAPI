import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useI18n } from './i18n';
import { resetQuotaCache } from './services/quotaCache';
import { initializeTargetRevision } from './services/targetInvoke';
import { beginConnectionChange } from './services/connectionGeneration';

export type CoreConnection = {
  mode: 'local' | 'remote';
  remoteManagementOrigin: string;
  remoteManagementKey: string;
  clientApiOrigin: string;
  clientApiKey: string;
};

type ConnectionContext = { connection: CoreConnection; reload: () => void };
export const CoreConnectionContext = createContext<ConnectionContext | null>(null);

export function CoreConnectionProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [connection, setConnection] = useState<CoreConnection | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const switching = useRef(false);
  const reload = useCallback(() => {
    if (switching.current) return;
    switching.current = true;
    beginConnectionChange();
    resetQuotaCache();
    setConnection(null);
    // ponytail: one persisted target; reload isolates old async work. Live switching needs target-bound requests.
    window.location.reload();
  }, []);
  useEffect(() => {
    let disposed = false;
    window.addEventListener('core-target-stale', reload);
    let stop: (() => void) | undefined;
    void listen('core-connection-changed', () => { if (!disposed) reload(); }).then(unlisten => {
      if (disposed) unlisten(); else stop = unlisten;
    }).catch(cause => { if (!disposed) setError(String(cause)); });
    void invoke<CoreConnection & { targetRevision: number }>('get_core_connection').then(next => {
      if (!disposed && !switching.current) { initializeTargetRevision(next.targetRevision); setConnection(next); setError(''); }
    }).catch(cause => { if (!disposed) setError(String(cause)); });
    return () => { disposed = true; stop?.(); window.removeEventListener('core-target-stale', reload); };
  }, [attempt, reload]);
  if (!connection) return <div className="panel" role="status">{error || t('common.detecting')}{error ? <button type="button" className="secondary-button" onClick={() => { setError(''); setAttempt(value => value + 1); }}>{t('common.retry')}</button> : null}</div>;
  return <CoreConnectionContext.Provider value={{ connection, reload }}>{children}</CoreConnectionContext.Provider>;
}

export function useCoreConnection() {
  const value = useContext(CoreConnectionContext);
  if (!value) throw new Error('useCoreConnection must be used inside CoreConnectionProvider');
  return value;
}
