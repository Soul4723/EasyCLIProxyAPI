import { describe, expect, test } from 'bun:test';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';
import { normalizedCoreConnection, remoteConfigFieldRequiresServer } from '../src/services/coreConnection';
import { assertConnectionCurrent, connectionGeneration, invalidateConnectionRequests } from '../src/services/connectionGeneration';
import { captureQuotaCacheGeneration, commitQuotaCacheIfCurrent, getQuotaCacheSnapshot, resetQuotaCache, updateQuotaCache } from '../src/services/quotaCache';
import { createOAuthLoginSuccessCache } from '../src/services/oauthLoginState';
import { managementApi } from '../src/services/managementApi';
import { createBrowserMockRuntime } from '../src/mocks/browserMockRuntime';

const remote = { mode: 'remote' as const, remoteManagementOrigin: ' http://100.64.0.1:8317/ ', remoteManagementKey: ' management-only ', clientApiOrigin: '', clientApiKey: '' };

describe('core attachment', () => {
  test('accepts HTTP, HTTPS and IPv6 origins without mixing client credentials', () => {
    expect(normalizedCoreConnection(remote)).toEqual({ ...remote, remoteManagementOrigin: 'http://100.64.0.1:8317', remoteManagementKey: 'management-only' });
    expect(normalizedCoreConnection({ ...remote, remoteManagementOrigin: 'https://[::1]:8317' }).remoteManagementOrigin).toBe('https://[::1]:8317');
    for (const url of ['file:///tmp/core', 'https://user:secret@host', 'https://host/v1', 'https://host/?key=secret', 'https://host/#key', 'invalid']) {
      expect(() => normalizedCoreConnection({ ...remote, remoteManagementOrigin: url })).toThrow();
    }
    expect(() => normalizedCoreConnection({ ...remote, remoteManagementKey: ' ' })).toThrow();
    expect(normalizedCoreConnection({ ...remote, mode: 'local', remoteManagementOrigin: '' }).mode).toBe('local');
    expect(normalizedCoreConnection({ ...remote, clientApiOrigin: ' https://client.example:8317/ ', clientApiKey: ' client-key ' })).toMatchObject({ clientApiOrigin: 'https://client.example:8317', clientApiKey: 'client-key' });
    expect(() => normalizedCoreConnection({ ...remote, clientApiOrigin: 'https://client.example:8317', clientApiKey: '' })).toThrow('client key');
    expect(() => normalizedCoreConnection({ ...remote, clientApiOrigin: '', clientApiKey: 'client-key' })).toThrow('origin');
    for (const path of ['server/host', 'server/port', 'server/tls/enabled', 'management/allow-remote', 'oauth/auth-dir']) expect(remoteConfigFieldRequiresServer(path.split('/'))).toBe(true);
    for (const path of ['routing/session-affinity', 'observability/logs/debug', 'requests/request-retry', 'oauth/providers/codex']) expect(remoteConfigFieldRequiresServer(path.split('/'))).toBe(false);
  });

  test('target invalidation clears quota and OAuth successes and rejects delayed results', async () => {
    const oauth = createOAuthLoginSuccessCache<string>();
    oauth.mark('codex');
    updateQuotaCache({ previous: { status: 'success', rows: [] } });
    const quotaGeneration = captureQuotaCacheGeneration();
    const generation = connectionGeneration();
    invalidateConnectionRequests(); resetQuotaCache();
    expect(getQuotaCacheSnapshot()).toEqual({});
    expect(oauth.snapshot()).toEqual([]);
    expect(commitQuotaCacheIfCurrent(quotaGeneration, () => { throw new Error('stale commit'); })).toBe(false);
    expect(() => assertConnectionCurrent(generation)).toThrow('Core connection changed');

    let finish!: (value: unknown) => void;
    const oldWindow = globalThis.window;
    globalThis.window = {} as Window & typeof globalThis;
    mockIPC(() => new Promise(resolve => { finish = resolve; }));
    try {
      const pending = managementApi.get('/config');
      invalidateConnectionRequests();
      finish({ previousTarget: true });
      await expect(pending).rejects.toThrow('Core connection changed');
    } finally { clearMocks(); globalThis.window = oldWindow; }
  });

  test('browser mock persists selection, tests failures without switching, and restores local runtime', async () => {
    const events: string[] = [];
    const runtime = createBrowserMockRuntime('running', event => { events.push(event); });
    const local = await runtime.invoke('get_core_connection') as typeof remote;
    await expect(runtime.invoke('test_core_connection', { connection: { ...remote, remoteManagementKey: 'invalid' } })).rejects.toThrow('401');
    await expect(runtime.invoke('test_core_connection', { connection: { ...remote, remoteManagementOrigin: 'https://offline.example' } })).rejects.toThrow('unreachable');
    expect(await runtime.invoke('get_core_connection')).toEqual(local);
    expect(await runtime.invoke('test_core_connection', { connection: remote })).toMatchObject({ version: '8.0.29' });
    await expect(runtime.invoke('save_core_connection', { connection: remote })).rejects.toThrow('Stop the app-managed local core');
    expect(await runtime.invoke('get_core_connection')).toEqual(local);
    await runtime.invoke('stop_core_process');
    await runtime.invoke('save_core_connection', { connection: remote });
    await runtime.invoke('save_core_connection', { connection: { ...remote, clientApiOrigin: 'https://client.example:8317', clientApiKey: 'client-key' } });
    expect(await runtime.invoke('get_core_connection')).toMatchObject({ mode: 'remote', remoteManagementOrigin: 'http://100.64.0.1:8317', clientApiOrigin: 'https://client.example:8317', clientApiKey: 'client-key' });
    expect(await runtime.invoke('get_core_status')).toMatchObject({ connectionMode: 'remote', installed: false, managed: false, processId: null, ready: true, currentVersion: '8.0.29', installDir: '', binaryPath: null });
    for (const command of ['start_core_process', 'stop_core_process', 'restart_core_process']) await expect(runtime.invoke(command)).rejects.toThrow('Local mode');
    expect(await runtime.invoke('management_request', { request: { method: 'GET', path: '/credentials' } })).toHaveProperty('files');
    for (const command of ['add_core_api_key', 'update_core_api_key']) await expect(runtime.invoke(command, { apiKey: 'sk-remote', remark: 'note' })).rejects.toThrow('notes are unsupported');
    expect(await runtime.invoke('add_core_api_key', { apiKey: 'sk-remote', remark: '' })).toHaveProperty('apiKeys');
    expect(events).toContain('core-connection-changed');
    await runtime.invoke('save_core_connection', { connection: { ...remote, remoteManagementKey: 'invalid' } });
    expect(await runtime.invoke('get_core_status')).toMatchObject({ connectionMode: 'remote', ready: false, running: false, currentVersion: null, message: 'Browser Mock: authentication failed (401)' });
    await runtime.invoke('save_core_connection', { connection: local });
    expect(await runtime.invoke('get_core_status')).toMatchObject({ connectionMode: 'local', installed: true, ready: false, running: false, processId: null });
    expect(await runtime.invoke('start_core_process')).toMatchObject({ ready: true, managed: true });
  });
});
