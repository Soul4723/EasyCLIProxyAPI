import { afterEach, beforeEach, expect, test } from 'bun:test';
import { emit } from '@tauri-apps/api/event';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { CORE_CONFIG_SCOPES, configChangeAffects, listenConfigChange } from '../../../src/services/configChange';
import { coreConfigSource, extendedCoreConfigSource } from '../../../src/services/coreConfig';
import { credentialsSource } from '../../../src/services/credentials';

let originalWindow: PropertyDescriptor | undefined;
let stops: Array<() => void> = [];
const sources = [coreConfigSource, extendedCoreConfigSource, credentialsSource];
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

test('a payload only counts when it names a scope the listener reads', () => {
  expect(configChangeAffects({ paths: ['/home/u/.codex/config.toml'], scopes: ['agent'], errors: [] }, CORE_CONFIG_SCOPES)).toBe(false);
  expect(configChangeAffects({ scopes: ['agent', 'agent'] }, CORE_CONFIG_SCOPES)).toBe(false);
  expect(configChangeAffects({ scopes: ['core'] }, CORE_CONFIG_SCOPES)).toBe(true);
  expect(configChangeAffects({ scopes: ['gui'] }, CORE_CONFIG_SCOPES)).toBe(true);
  expect(configChangeAffects({ scopes: ['agent', 'core'] }, CORE_CONFIG_SCOPES)).toBe(true);
  expect(configChangeAffects({ scopes: ['agent'] }, ['agent'])).toBe(true);
  expect(configChangeAffects({ scopes: ['core'] }, ['agent'])).toBe(false);
});

test('a payload that does not say what changed always counts', () => {
  for (const payload of [undefined, null, 'x', {}, { paths: ['/anywhere'] }, { paths: [], errors: ['bad yaml'] },
    { scopes: [] }, { scopes: 'agent' }, { scopes: ['agent', 'later-scope'] }, { scopes: [7] }]) {
    expect(configChangeAffects(payload, CORE_CONFIG_SCOPES)).toBe(true);
  }
});

test('listenConfigChange skips unrelated changes and fires for related or unknown ones', async () => {
  mockIPC(() => null, { shouldMockEvents: true });
  let calls = 0;
  stops.push(await listenConfigChange(CORE_CONFIG_SCOPES, () => { calls++; }));
  await emit('config-files-changed', { paths: ['/home/u/.codex/config.toml'], scopes: ['agent'], errors: [] });
  await wait(20);
  expect(calls).toBe(0);
  await emit('config-files-changed', { paths: ['/app/config.toml'], scopes: ['gui'], errors: [] });
  await emit('config-files-changed', { paths: ['/app/cpa-core/config.yaml'], scopes: ['core'], errors: [] });
  await emit('config-files-changed');
  await emit('config-files-changed', { paths: ['/anywhere'], errors: [] });
  await wait(20);
  expect(calls).toBe(4);
});

test('core config, extended config and credentials refetch only for gui/core changes', async () => {
  const reads = { core: 0, extended: 0, credentials: 0 };
  mockIPC((command, args) => {
    if (command === 'get_management_target_revision') return 7;
    if (command === 'get_core_config_settings') { reads.core++; return { port: 8317, apiKeys: [] }; }
    if (command === 'get_extended_core_config') { reads.extended++; return {}; }
    if (command === 'management_request' && (args as { request: { path: string } }).request.path === '/credentials') { reads.credentials++; return { files: [] }; }
    return null;
  }, { shouldMockEvents: true });
  stops.push(...sources.map(source => source.subscribe(() => {})));
  await Promise.all(sources.map(source => source.load()));
  expect(reads).toEqual({ core: 1, extended: 1, credentials: 1 });

  // Past the 1 s per-source throttle, so an accepted event reloads at once and a refused one is visible.
  await wait(1_100);
  await emit('config-files-changed', { paths: ['/home/u/.codex/config.toml', '/home/u/.claude/settings.json'], scopes: ['agent'], errors: [] });
  await wait(1_100);
  expect(reads).toEqual({ core: 1, extended: 1, credentials: 1 });

  let expected = 1;
  for (const payload of [
    { paths: ['/app/cpa-core/config.yaml'], scopes: ['core'], errors: [] },
    { paths: ['/app/config.toml'], scopes: ['gui'], errors: [] },
    undefined,
    { paths: ['/anywhere'], errors: [] },
  ]) {
    await emit('config-files-changed', payload);
    await wait(1_100);
    expected++;
    expect(reads).toEqual({ core: expected, extended: expected, credentials: expected });
  }
}, 20_000);
