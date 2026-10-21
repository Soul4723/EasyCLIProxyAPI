import { describe, expect, test } from 'bun:test';
import { canSaveConnection, isInsecureRemoteOrigin, type CoreConnection } from '../src/services/coreConnection';

const local: CoreConnection = { mode: 'local', managementOrigin: '', managementKey: '' };
const remote = (managementOrigin: string, managementKey = 'secret'): CoreConnection => ({ mode: 'remote', managementOrigin, managementKey });

describe('core connection settings', () => {
  test('warns only for remote HTTP origins outside loopback', () => {
    expect(isInsecureRemoteOrigin(remote('http://core.example:8317'))).toBe(true);
    expect(isInsecureRemoteOrigin(remote(' http://10.0.0.5:8317 '))).toBe(true);
    for (const origin of ['http://localhost:8317', 'http://127.0.0.1:8317', 'http://[::1]:8317', 'https://core.example', 'core.example', '']) {
      expect(isInsecureRemoteOrigin(remote(origin))).toBe(false);
    }
    expect(isInsecureRemoteOrigin({ ...local, managementOrigin: 'http://core.example' })).toBe(false);
  });

  test('requires a complete remote target before saving', () => {
    expect(canSaveConnection(remote(''), local, false)).toBe(false);
    expect(canSaveConnection(remote('https://core.example', ''), local, false)).toBe(false);
    expect(canSaveConnection(remote('https://core.example'), local, false)).toBe(true);
    expect(canSaveConnection(local, remote('https://core.example'), true)).toBe(true);
  });

  test('blocks switching from a running local core but allows editing an existing remote target', () => {
    expect(canSaveConnection(remote('https://core.example'), local, true)).toBe(false);
    expect(canSaveConnection(remote('https://other.example'), remote('https://core.example'), true)).toBe(true);
  });
});
