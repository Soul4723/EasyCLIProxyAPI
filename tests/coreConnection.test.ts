import { describe, expect, test } from 'bun:test';
import {
  canSaveConnection, hasHostControl, hostControlDraftProblem, isCompleteRemoteDraft, isInsecureRemoteOrigin, isValidRemoteOrigin,
  type CoreConnection,
} from '../src/services/coreConnection';
import { isValidListenAddress } from '../src/services/hostControl';

const local: CoreConnection = { mode: 'local', managementOrigin: '', managementKey: '', hostControlOrigin: '', hostControlKey: '' };
const remote = (managementOrigin: string, managementKey = 'secret'): CoreConnection => ({
  mode: 'remote', managementOrigin, managementKey, hostControlOrigin: '', hostControlKey: '',
});
const hostKey = 'ehc_test-host-control-key-0123456789abcdef';
const controlled = (hostControlOrigin: string, hostControlKey = hostKey): CoreConnection => ({
  ...remote('https://core.example'), hostControlOrigin, hostControlKey,
});

describe('core connection settings', () => {
  test('warns only for remote HTTP origins outside loopback', () => {
    expect(isInsecureRemoteOrigin(remote('http://core.example:8317'))).toBe(true);
    expect(isInsecureRemoteOrigin(remote(' http://10.0.0.5:8317 '))).toBe(true);
    for (const origin of ['http://localhost:8317', 'http://127.0.0.1:8317', 'http://[::1]:8317', 'https://core.example', 'core.example', '']) {
      expect(isInsecureRemoteOrigin(remote(origin))).toBe(false);
    }
    expect(isInsecureRemoteOrigin({ ...local, managementOrigin: 'http://core.example' })).toBe(false);
  });

  test('accepts only an HTTP(S) origin without path, query or credentials', () => {
    for (const origin of ['https://core.example:8317', ' http://10.0.0.5:8317/ ', 'http://[::1]:8317']) expect(isValidRemoteOrigin(origin)).toBe(true);
    for (const origin of ['', 'core.example:8317', 'ftp://core.example', 'https://core.example/v8', 'https://core.example?x=1', 'https://user:pw@core.example', 'https://core.example#a']) {
      expect(isValidRemoteOrigin(origin)).toBe(false);
    }
  });

  test('requires a complete, valid and changed remote target before saving', () => {
    expect(canSaveConnection(remote(''), local, false)).toBe(false);
    expect(canSaveConnection(remote('https://core.example', ''), local, false)).toBe(false);
    expect(canSaveConnection(remote('https://core.example/path'), local, false)).toBe(false);
    expect(canSaveConnection(remote('https://core.example'), local, false)).toBe(true);
    expect(canSaveConnection(local, remote('https://core.example'), true)).toBe(true);
  });

  test('offers Save only when the draft differs from the saved connection', () => {
    expect(canSaveConnection(local, local, false)).toBe(false);
    expect(canSaveConnection({ ...local, managementOrigin: 'https://stale.example' }, { ...local, managementOrigin: 'https://kept.example' }, false)).toBe(false);
    expect(canSaveConnection(remote(' https://core.example '), remote('https://core.example'), false)).toBe(false);
    expect(canSaveConnection(remote('https://core.example', 'rotated'), remote('https://core.example'), false)).toBe(true);
  });

  test('blocks switching from a running local core but allows editing an existing remote target', () => {
    expect(canSaveConnection(remote('https://core.example'), local, true)).toBe(false);
    expect(canSaveConnection(remote('https://other.example'), remote('https://core.example'), true)).toBe(true);
  });

  test('remote host control is optional, complete and distinct from the management key', () => {
    expect(hostControlDraftProblem(remote('https://core.example'))).toBeNull();
    expect(hasHostControl(remote('https://core.example'))).toBe(false);
    expect(hostControlDraftProblem(controlled(' http://100.64.0.1:8318 ', ` ${hostKey} `))).toBeNull();
    expect(isCompleteRemoteDraft(controlled('http://100.64.0.1:8318'))).toBe(true);
    expect(hostControlDraftProblem(controlled('http://100.64.0.1:8318', ''))).toBe('incomplete');
    expect(hostControlDraftProblem(controlled('', hostKey))).toBe('incomplete');
    expect(hostControlDraftProblem(controlled('100.64.0.1:8318'))).toBe('invalidOrigin');
    expect(hostControlDraftProblem(controlled('http://host.example:8318/path'))).toBe('invalidOrigin');
    expect(hostControlDraftProblem(controlled('http://host.example:8318', 'secret'))).toBe('sameKey');
    expect(hostControlDraftProblem(controlled('http://host.example:8318', 'short'))).toBe('invalidKey');
    expect(hostControlDraftProblem(controlled('http://host.example:8318', `${hostKey} x`))).toBe('invalidKey');
    expect(isCompleteRemoteDraft(controlled('http://host.example:8318', 'short'))).toBe(false);
    expect(canSaveConnection(controlled('http://host.example:8318', 'short'), local, false)).toBe(false);
  });

  test('host control changes are saveable edits and HTTP host control gets the caution', () => {
    const saved = controlled('http://100.64.0.1:8318');
    expect(canSaveConnection(saved, saved, false)).toBe(false);
    expect(canSaveConnection(controlled(' http://100.64.0.1:8318 '), saved, false)).toBe(false);
    expect(canSaveConnection(controlled('http://100.64.0.2:8318'), saved, false)).toBe(true);
    expect(canSaveConnection(controlled('http://100.64.0.1:8318', `${hostKey}-rotated`), saved, false)).toBe(true);
    expect(canSaveConnection(remote('https://core.example'), saved, false)).toBe(true);
    expect(isInsecureRemoteOrigin(controlled('https://host.example:8318'))).toBe(false);
    expect(isInsecureRemoteOrigin(controlled('http://100.64.0.1:8318'))).toBe(true);
    expect(isInsecureRemoteOrigin(controlled('http://127.0.0.1:8318'))).toBe(false);
  });

  test('listen addresses mirror the native rules', () => {
    for (const value of ['0.0.0.0:8318', ' 100.64.0.1:8318 ', '[::]:9000', '127.0.0.1:65535']) expect(isValidListenAddress(value, 8317)).toBe(true);
    for (const value of ['', '8318', ':8318', 'localhost:8318', '0.0.0.0', '0.0.0.0:80', '0.0.0.0:65536', '256.0.0.1:8318', '0.0.0.0:8317', 'http://0.0.0.0:8318']) {
      expect(isValidListenAddress(value, 8317)).toBe(false);
    }
  });
});
