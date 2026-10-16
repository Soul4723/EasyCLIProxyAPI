import { invoke } from '@tauri-apps/api/core';

export type CoreConnection = {
  mode: 'local' | 'remote';
  managementOrigin: string;
  managementKey: string;
  clientOrigin: string;
  clientKey: string;
};
export type ConnectionTestResult = { connected: boolean; version: string | null; message: string };
export const getCoreConnection = () => invoke<CoreConnection>('get_core_connection');
export const saveCoreConnection = (connection: CoreConnection) => invoke<CoreConnection>('save_core_connection', { connection });
export const testCoreConnection = (connection: CoreConnection) => invoke<ConnectionTestResult>('test_core_connection', { connection });
