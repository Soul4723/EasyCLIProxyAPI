import { afterEach, beforeEach, expect, test } from 'bun:test';
import { emit } from '@tauri-apps/api/event';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { modelsSource, providerKeysSource } from '../../../src/sections/overview/data';

let originalWindow: PropertyDescriptor | undefined;
let stops: Array<() => void> = [];
const sources = [modelsSource, providerKeysSource];
beforeEach(() => {
  originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { crypto: globalThis.crypto, addEventListener() {}, removeEventListener() {} }, writable: true, configurable: true });
  sources.forEach(source => source.reset());
});
afterEach(() => { stops.forEach(stop => stop()); stops = []; clearMocks();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});
const wait = (ms: number) => new Promise(done => setTimeout(done, ms));

test('Overview models and provider keys refetch only for gui/core changes', async () => {
  const reads = { models: 0, providerKeys: 0 };
  mockIPC((command, args) => {
    if (command === 'get_management_target_revision') return 7;
    if (command === 'get_core_models') { reads.models++; return []; }
    if (command === 'management_request' && (args as { request: { path: string } }).request.path === '/config/api-keys') { reads.providerKeys++; return {}; }
    return null;
  }, { shouldMockEvents: true });
  stops.push(...sources.map(source => source.subscribe(() => {})));
  await Promise.all(sources.map(source => source.load()));
  expect(reads).toEqual({ models: 1, providerKeys: 1 });

  await wait(1_100);
  await emit('config-files-changed', { paths: ['/home/u/.codex/config.toml'], scopes: ['agent'], errors: [] });
  await wait(1_100);
  expect(reads).toEqual({ models: 1, providerKeys: 1 });

  let expected = 1;
  for (const payload of [{ paths: ['/app/cpa-core/config.yaml'], scopes: ['core'], errors: [] }, undefined]) {
    await emit('config-files-changed', payload);
    await wait(1_100);
    expected++;
    expect(reads).toEqual({ models: expected, providerKeys: expected });
  }
});
