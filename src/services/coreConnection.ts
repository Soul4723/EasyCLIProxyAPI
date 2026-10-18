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
