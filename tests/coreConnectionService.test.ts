import { describe, expect, test } from 'bun:test';
import { changedConnectionFields, classifyConnectionResult, isValidOrigin, type CoreConnection } from '../src/services/coreConnection';

const remote: CoreConnection = { mode: 'remote', managementOrigin: 'https://a.test', managementKey: 'k', clientOrigin: 'https://a.test', clientKey: '' };

describe('core connection helpers', () => {
  test('origin validation matches the backend rules', () => {
    expect(isValidOrigin('https://core.test')).toBe(true);
    expect(isValidOrigin('http://10.0.0.5:8317')).toBe(true);
    for (const bad of ['', 'core.test', 'ftp://core.test', 'https://core.test/v1', 'https://u:p@core.test', 'https://core.test?x=1', 'https://core.test#h']) expect(isValidOrigin(bad)).toBe(false);
  });
  test('maps backend messages to failure kinds', () => {
    const fail = (message: string) => classifyConnectionResult({ connected: false, version: null, message });
    expect(classifyConnectionResult({ connected: true, version: '1', message: 'Connected' })).toBeNull();
    expect(fail('Unable to reach the core')?.kind).toBe('unreachable');
    expect(fail('Core rejected the management key')?.kind).toBe('auth');
    expect(fail('Remote management access is forbidden')?.kind).toBe('forbidden');
    expect(fail('Core does not expose the v8 management API')?.kind).toBe('legacy');
    expect(fail('Core did not return a v8 configuration')?.kind).toBe('legacy');
    expect(fail('Core management request failed (HTTP 502)')).toEqual({ kind: 'http', status: 502 });
  });
  test('counts changed fields; local drafts ignore remote fields', () => {
    expect(changedConnectionFields(remote, remote)).toBe(0);
    expect(changedConnectionFields({ ...remote, managementKey: 'x', clientKey: 'y' }, remote)).toBe(2);
    expect(changedConnectionFields({ ...remote, mode: 'local', managementKey: 'x' }, { ...remote, mode: 'local' })).toBe(0);
    expect(changedConnectionFields({ ...remote, mode: 'local' }, remote)).toBe(1);
  });
});
