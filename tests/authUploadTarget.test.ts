import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { managementApi } from '../src/services/managementApi';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
beforeAll(() => Object.defineProperty(globalThis, 'window', { value: {}, configurable: true }));
afterEach(() => clearMocks());
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

test('native target changes during file reading reject even before browser invalidation', async () => {
  let revision = 7;
  let sends = 0;
  mockIPC((command, args) => {
    if (command === 'get_management_target_revision') return revision;
    if (command === 'upload_auth_file') {
      if (args!.expectedRevision !== revision) throw new Error('Core connection changed; upload cancelled');
      sends++;
      return { ok: true };
    }
    throw new Error(command);
  });
  const file = new File(['{}'], 'account.json');
  file.arrayBuffer = async () => { revision++; return new TextEncoder().encode('{}').buffer; };
  await expect(managementApi.uploadAuthFile(file)).rejects.toThrow('upload cancelled');
  expect(sends).toBe(0);
});

test('batch revision is preserved and current upload retains bytes', async () => {
  const calls: unknown[] = [];
  mockIPC((command, args) => { calls.push({ command, args }); return { ok: true }; });
  await managementApi.uploadAuthFile(new File(['{}'], 'current.json'), () => true, 12);
  expect(calls).toEqual([{ command: 'upload_auth_file', args: {
    name: 'current.json', data: [123, 125], expectedRevision: 12,
  } }]);
});
