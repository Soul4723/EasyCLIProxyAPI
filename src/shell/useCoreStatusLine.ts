import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useCoreRuntime } from '../coreRuntime';

export type CoreStatusLine =
  | { kind: 'running'; tone: 'ok'; port: number | null }
  | { kind: 'starting' | 'stopped' | 'notInstalled'; tone: 'warn' | 'muted' }
  | { kind: 'remote' | 'remoteDown'; tone: 'ok' | 'warn'; host: string };

function hostOf(origin: string | null | undefined) {
  if (!origin) return '';
  try { return new URL(origin).host; } catch { return origin; }
}

/** One-line core state for the sidebar footer (local port from GUI settings, remote host from the connection). */
export function useCoreStatusLine(): CoreStatusLine {
  const { status } = useCoreRuntime();
  const [port, setPort] = useState<number | null>(null);
  const running = Boolean(status?.ready);
  useEffect(() => {
    if (!running || status?.connectionMode === 'remote') return;
    let cancelled = false;
    void invoke<{ port: number }>('get_gui_settings').then((settings) => {
      if (!cancelled) setPort(settings.port);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [running, status?.connectionMode]);
  if (status?.connectionMode === 'remote') {
    const host = hostOf(status.remoteOrigin);
    return running ? { kind: 'remote', tone: 'ok', host } : { kind: 'remoteDown', tone: 'warn', host };
  }
  if (running) return { kind: 'running', tone: 'ok', port };
  if (status?.starting) return { kind: 'starting', tone: 'warn' };
  if (status && !status.installed) return { kind: 'notInstalled', tone: 'muted' };
  return { kind: 'stopped', tone: 'muted' };
}
