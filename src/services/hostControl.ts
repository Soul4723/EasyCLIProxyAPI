import { invoke } from '@tauri-apps/api/core';

// This computer's remote host control listener (Local mode): lets another EasyCLIProxyAPI start, stop and restart this core.
export type HostControlSettings = {
  enabled: boolean;
  // Saved listen address; empty uses defaultAddress (this core's port + 100).
  address: string;
  defaultAddress: string | null;
  key: string;
  available: boolean;
  listening: string | null;
  error: string | null;
};
export type HostControlUpdate = { enabled: boolean; address: string; regenerateKey?: boolean };

export const getHostControlSettings = () => invoke<HostControlSettings>('get_host_control_settings');
export const saveHostControlSettings = (update: HostControlUpdate) => invoke<HostControlSettings>('save_host_control_settings', { update });

// Mirrors the native check: an IP literal and port 1024-65535 that is not the core's port.
export function isValidListenAddress(value: string, corePort?: number) {
  const match = value.trim().match(/^(?:(\d{1,3}(?:\.\d{1,3}){3})|\[([0-9a-fA-F:.]+)\]):(\d{1,5})$/);
  if (!match) return false;
  if (match[1] && match[1].split('.').some((part) => Number(part) > 255)) return false;
  const port = Number(match[3]);
  return port >= 1024 && port <= 65535 && port !== corePort;
}
