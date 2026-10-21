import { invoke } from '@tauri-apps/api/core';

export type CoreConnection = { mode: 'local' | 'remote'; managementOrigin: string; managementKey: string };
export type ConnectionTestResult = { connected: boolean; version: string | null; message: string };

export const getCoreConnection = () => invoke<CoreConnection>('get_core_connection');
export const saveCoreConnection = (connection: CoreConnection) => invoke<CoreConnection>('save_core_connection', { connection });
export const testCoreConnection = (connection: CoreConnection) => invoke<ConnectionTestResult>('test_core_connection', { connection });

const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];

export function isInsecureRemoteOrigin({ mode, managementOrigin }: CoreConnection) {
  if (mode !== 'remote') return false;
  try {
    const { protocol, hostname } = new URL(managementOrigin.trim());
    return protocol === 'http:' && !loopbackHosts.includes(hostname);
  } catch { return false; }
}

export function canSaveConnection(draft: CoreConnection, saved: CoreConnection, localCoreRunning: boolean) {
  if (draft.mode === 'local') return true;
  if (!draft.managementOrigin.trim() || !draft.managementKey) return false;
  return saved.mode === 'remote' || !localCoreRunning;
}
