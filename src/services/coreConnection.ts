import { invoke } from '@tauri-apps/api/core';
import { documentTarget } from './documentTarget';

export type CoreConnection = {
  mode: 'local' | 'remote';
  managementOrigin: string;
  managementKey: string;
  clientOrigin: string;
  clientKey: string;
};
export type ConnectionTestResult = { connected: boolean; version: string | null; message: string };
export const getCoreConnection = () => invoke<CoreConnection>('get_core_connection');
export async function saveCoreConnection(connection: CoreConnection): Promise<CoreConnection> {
  // Block continuations before native save; restore the same revision only on failure.
  documentTarget.block();
  try {
    const saved = await invoke<CoreConnection>('save_core_connection', { connection });
    window.location.reload();
    return saved;
  } catch (error) {
    documentTarget.restore();
    throw error;
  }
}
export const testCoreConnection = (connection: CoreConnection) => invoke<ConnectionTestResult>('test_core_connection', { connection });

export const importCoreConnection = (path: string) => invoke<CoreConnection>('import_core_connection', { path });
export const exportCoreConnection = (path: string, includeSecrets: boolean) => invoke<void>('export_core_connection', { path, includeSecrets });

export const EMPTY_CONNECTION: CoreConnection = { mode: 'local', managementOrigin: '', managementKey: '', clientOrigin: '', clientKey: '' };

/** True for an http(s) origin without path, query, hash or credentials (what the backend accepts). */
export function isValidOrigin(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' && !value.trim().endsWith('?') && !value.trim().endsWith('#');
  } catch { return false; }
}

/** True for an http: origin whose host is not loopback: keys sent there cross the network unencrypted. */
export function isInsecureRemoteOrigin(value: string): boolean {
  if (!isValidOrigin(value)) return false;
  const url = new URL(value.trim());
  if (url.protocol !== 'http:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return !(host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host));
}

const CONNECTION_FIELDS = ['mode', 'managementOrigin', 'managementKey', 'clientOrigin', 'clientKey'] as const;
/** Number of draft fields that differ from the saved connection (remote-only fields are ignored in local mode). */
export function changedConnectionFields(draft: CoreConnection, saved: CoreConnection): number {
  if (draft.mode === 'local') return saved.mode === 'local' ? 0 : 1;
  return CONNECTION_FIELDS.filter((field) => draft[field] !== saved[field]).length;
}

export type ConnectionFailureKind = 'unreachable' | 'auth' | 'forbidden' | 'legacy' | 'http' | 'invalid';
export type ConnectionFailure = { kind: ConnectionFailureKind; status?: number };

/** Maps the backend's test message to a failure kind; null means connected. The backend only reports these classes. */
export function classifyConnectionResult(result: ConnectionTestResult): ConnectionFailure | null {
  if (result.connected) return null;
  const message = result.message;
  if (/unable to reach/i.test(message)) return { kind: 'unreachable' };
  if (/rejected the management key/i.test(message)) return { kind: 'auth' };
  if (/forbidden/i.test(message)) return { kind: 'forbidden' };
  if (/v8/i.test(message)) return { kind: 'legacy' };
  const http = /HTTP (\d{3})/.exec(message);
  if (http) return { kind: 'http', status: Number(http[1]) };
  return { kind: 'unreachable' };
}
