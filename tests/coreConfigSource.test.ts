import { afterEach, beforeEach, expect, test } from 'bun:test';
import { emit } from '@tauri-apps/api/event';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { coreConfigSource, extendedCoreConfigSource, type CoreConfigSettings } from '../src/services/coreConfig';

let originalWindow: PropertyDescriptor | undefined;
let stops: Array<() => void> = [];
beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { crypto: globalThis.crypto, addEventListener() {}, removeEventListener() {} }, writable: true, configurable: true });
  coreConfigSource.reset(); extendedCoreConfigSource.reset();
});
afterEach(() => { stops.forEach(stop => stop()); stops = []; clearMocks();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
const settings = (port: number) => ({ port, apiKeys: [], redisUsageQueueRetentionSeconds: 60 }) as unknown as CoreConfigSettings;

test('concurrent readers and navigation reuse one cached settings value', async () => {
  let reads = 0;
  mockIPC(command => command === 'get_management_target_revision' ? 7 : command === 'get_core_config_settings' ? (reads++, settings(8317)) : null);
  stops.push(coreConfigSource.subscribe(() => {}), coreConfigSource.subscribe(() => {}));
  await coreConfigSource.load();
  expect(reads).toBe(1);
  stops.splice(0).forEach(stop => stop());
  stops.push(coreConfigSource.subscribe(() => {}));
  await coreConfigSource.load();
  expect(reads).toBe(1);
  expect(coreConfigSource.getSnapshot().data?.port).toBe(8317);
});

test('save results reach all readers and fence a stale background read; failures retain the save', async () => {
  let resolve!: (value: CoreConfigSettings) => void;
  let fail = false;
  mockIPC(command => {
    if (command === 'get_management_target_revision') return 7;
    if (command === 'get_core_config_settings') {
      if (fail) throw new Error('offline');
      return new Promise<CoreConfigSettings>(done => { resolve = done; });
    }
    return null;
  });
  const pending = coreConfigSource.refresh();
  await new Promise(done => setTimeout(done, 0));
  coreConfigSource.mutate(() => settings(9000));
  resolve(settings(8317));
  await pending;
  expect(coreConfigSource.getSnapshot().data?.port).toBe(9000);
  fail = true;
  await coreConfigSource.refresh();
  expect(coreConfigSource.getSnapshot().data?.port).toBe(9000);
  expect(coreConfigSource.getSnapshot().error).toBe('offline');
  expect(coreConfigSource.getSnapshot().loading).toBe(false);
});

test('extended config sections share reads and publish save results', async () => {
  let reads = 0;
  mockIPC(command => command === 'get_management_target_revision' ? 7 : command === 'get_extended_core_config' ? (reads++, { debug: false }) : null);
  stops.push(extendedCoreConfigSource.subscribe(() => {}), extendedCoreConfigSource.subscribe(() => {}));
  await extendedCoreConfigSource.load();
  expect(reads).toBe(1);
  extendedCoreConfigSource.mutate(() => ({ debug: true }));
  expect(extendedCoreConfigSource.getSnapshot().data).toEqual({ debug: true });
});


test('disk-change bursts produce one throttled reload shared by all readers', async () => {
  let reads = 0;
  mockIPC(command => command === 'get_management_target_revision' ? 7 : command === 'get_core_config_settings' ? settings(++reads) : null, { shouldMockEvents: true });
  stops.push(coreConfigSource.subscribe(() => {}), coreConfigSource.subscribe(() => {}));
  await coreConfigSource.load();
  await emit('config-files-changed'); await emit('config-files-changed'); await emit('config-files-changed');
  expect(reads).toBe(1);
  await new Promise(done => setTimeout(done, 1_100));
  await coreConfigSource.load();
  expect(reads).toBe(2);
  expect(coreConfigSource.getSnapshot().data?.port).toBe(2);
});
