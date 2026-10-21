import { invoke } from '@tauri-apps/api/core';

// hostControlOrigin/hostControlKey: optional remote host control on the core's computer; both empty when not set up.
export type CoreConnection = {
  mode: 'local' | 'remote'; managementOrigin: string; managementKey: string;
  hostControlOrigin: string; hostControlKey: string;
};
export type ConnectionTestResult = { connected: boolean; version: string | null; message: string };
export type HostControlTestResult = { connected: boolean; running: boolean | null; message: string };

export const getCoreConnection = () => invoke<CoreConnection>('get_core_connection');
export const saveCoreConnection = (connection: CoreConnection) => invoke<CoreConnection>('save_core_connection', { connection });
export const testCoreConnection = (connection: CoreConnection) => invoke<ConnectionTestResult>('test_core_connection', { connection });
export const testHostControl = (connection: CoreConnection) => invoke<HostControlTestResult>('test_host_control', { connection });

const loopbackHosts = ['localhost', '127.0.0.1', '[::1]'];

function parseOrigin(value: string) {
  try { return new URL(value.trim()); } catch { return null; }
}

// Mirrors the native origin check so Save and Test are offered only for values the core will accept.
export function isValidRemoteOrigin(value: string) {
  const url = parseOrigin(value);
  return Boolean(url && ['http:', 'https:'].includes(url.protocol) && url.hostname
    && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash);
}

export function isInsecureRemoteOrigin({ mode, managementOrigin, hostControlOrigin }: CoreConnection) {
  return mode === 'remote' && [managementOrigin, hostControlOrigin].some((origin) => {
    const url = parseOrigin(origin);
    return url?.protocol === 'http:' && !loopbackHosts.includes(url.hostname);
  });
}

export type HostControlDraftProblem = 'invalidOrigin' | 'incomplete' | 'sameKey' | 'invalidKey' | null;

// Mirrors the native check: both empty, or a valid origin plus a 32+ character key that is not the management key.
export function hostControlDraftProblem(draft: CoreConnection): HostControlDraftProblem {
  const origin = draft.hostControlOrigin.trim();
  const key = draft.hostControlKey.trim();
  if (!origin && !key) return null;
  if (origin && !isValidRemoteOrigin(origin)) return 'invalidOrigin';
  if (!origin || !key) return 'incomplete';
  if (key === draft.managementKey.trim()) return 'sameKey';
  if (key.length < 32 || key.length > 256 || /[^\x21-\x7e]/.test(key)) return 'invalidKey';
  return null;
}

export function hasHostControl(draft: CoreConnection) {
  return Boolean(draft.hostControlOrigin.trim() || draft.hostControlKey.trim());
}

export function isCompleteRemoteDraft(draft: CoreConnection) {
  return draft.mode === 'remote' && isValidRemoteOrigin(draft.managementOrigin) && Boolean(draft.managementKey)
    && hostControlDraftProblem(draft) === null;
}

export function connectionChanged(draft: CoreConnection, saved: CoreConnection) {
  return draft.mode !== saved.mode || (draft.mode === 'remote'
    && (draft.managementOrigin.trim() !== saved.managementOrigin || draft.managementKey !== saved.managementKey
      || draft.hostControlOrigin.trim() !== saved.hostControlOrigin || draft.hostControlKey.trim() !== saved.hostControlKey));
}

export function canSaveConnection(draft: CoreConnection, saved: CoreConnection, localCoreRunning: boolean) {
  if (!connectionChanged(draft, saved)) return false;
  if (draft.mode === 'local') return true;
  return isCompleteRemoteDraft(draft) && (saved.mode === 'remote' || !localCoreRunning);
}
