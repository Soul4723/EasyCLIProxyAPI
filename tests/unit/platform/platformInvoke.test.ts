import { afterEach, beforeEach, expect, test } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { invoke as platformInvoke } from '../../../src/services/platform';
import { documentTarget } from '../../../src/services/documentTarget';
import { FENCED_COMMANDS } from '../../../src/services/fencedCommands';

let originalWindow: PropertyDescriptor | undefined;
let calls: Array<{ command: string; args: unknown }>;
beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: {}, writable: true, configurable: true });
  calls = [];
  documentTarget.restore();
  mockIPC((command, args) => { calls.push({ command, args }); return command === 'get_management_target_revision' ? 17 : 'result'; });
});
afterEach(() => {
  documentTarget.restore(); clearMocks();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

test('every fenced command binds the same revision through either entry point', async () => {
  for (const invoke of [platformInvoke, documentTarget.invoke]) {
    for (const command of FENCED_COMMANDS) {
      expect(await invoke(command, { fixture: true })).toBe('result');
      expect(calls.at(-1)).toEqual({ command, args: { fixture: true, expectedRevision: 17 } });
    }
    await invoke('management_request', { request: { method: 'GET', path: '/config' } });
    expect(calls.at(-1)).toEqual({ command: 'management_request', args: { request: { method: 'GET', path: '/config', expectedRevision: 17 } } });
  }
  expect(calls.filter(call => call.command === 'get_management_target_revision')).toHaveLength(1);
});

test('platform refuses a mismatched revision and a blocked target without sending the command', async () => {
  await expect(platformInvoke('start_oauth_login', { expectedRevision: 18 })).rejects.toThrow('connection changed');
  await expect(platformInvoke('management_request', { request: { expectedRevision: 18 } })).rejects.toThrow('connection changed');
  documentTarget.block();
  await expect(platformInvoke('get_core_config_settings')).rejects.toThrow('connection changed');
  expect(calls.map(call => call.command)).toEqual(['get_management_target_revision']);
});

test('unfenced platform commands pass through unchanged without acquiring a revision', async () => {
  await platformInvoke('get_core_status', { fixture: true });
  expect(calls).toEqual([{ command: 'get_core_status', args: { fixture: true } }]);
});
