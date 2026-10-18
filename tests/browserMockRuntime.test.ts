import { describe, expect, test } from 'bun:test';
import {
  createBrowserMockRuntime,
  resolveBrowserMockOptions,
} from '../src/mocks/browserMockRuntime';

describe('browser mock options', () => {
  test('defaults to a running core and accepts stored scenarios', () => {
    expect(resolveBrowserMockOptions('', null)).toEqual({ mode: 'running', delayMs: 0 });
    expect(resolveBrowserMockOptions('', 'stopped')).toEqual({ mode: 'stopped', delayMs: 0 });
  });

  test('URL options override storage and clamp delay', () => {
    expect(resolveBrowserMockOptions('?mock=empty&mockDelay=9000', 'running'))
      .toEqual({ mode: 'empty', delayMs: 5000 });
    expect(resolveBrowserMockOptions('?mock=off&mockDelay=25', 'running'))
      .toEqual({ mode: 'off', delayMs: 25 });
  });
});

describe('browser mock runtime', () => {
  test('offers fast and standard request samples across the usage rows', async () => {
    const runtime = createBrowserMockRuntime('running');
    const page = await runtime.invoke('get_usage_events', { query: { page_size: 200 } }) as {
      items: Array<{ reasoning_effort: string; service_tier: string }>;
    };
    const tiers = new Set(page.items.map(({ service_tier }) => service_tier));
    expect(tiers.has('priority')).toBe(true);
    expect(tiers.has('')).toBe(true);
    expect(page.items.some(({ reasoning_effort }) => reasoning_effort === 'medium')).toBe(true);
  });

  test('offers a long failed request for the expanded error preview', async () => {
    const page = await createBrowserMockRuntime('running').invoke('get_usage_events', { query: { failed: true, page_size: 200 } }) as {
      items: Array<{ failed: boolean; failure_body: string }>;
    };
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((item) => item.failed)).toBe(true);
    expect(page.items.some((item) => item.failure_body.length > 300)).toBe(true);
  });

  test('empty scenario exposes empty credentials, providers and usage after installing the core', async () => {
    const runtime = createBrowserMockRuntime('empty');
    await runtime.invoke('install_bundled_core');
    await runtime.invoke('start_core_process');
    expect(await runtime.invoke('management_request', { request: { method: 'GET', path: '/credentials' } })).toMatchObject({ files: [] });
    const providers = await runtime.invoke('management_request', { request: { method: 'GET', path: '/config/api-keys' } }) as Record<string, unknown[]>;
    expect(Object.values(providers).every(groups => groups.length === 0)).toBe(true);
    expect(await runtime.invoke('get_usage_overview')).toMatchObject({ totalRequests: 0, totalTokens: 0, timeline: [] });
    expect(await runtime.invoke('get_usage_events')).toMatchObject({ items: [], total: 0 });
    expect(await runtime.invoke('get_usage_analysis')).toMatchObject({ models: [], providers: [], sources: [], apiKeys: [], upstreams: [] });
    expect(await runtime.invoke('get_usage_pricing')).toMatchObject({ rows: [], totalCost: 0 });
  });

  test('filters usage before pagination, including boolean and date filters', async () => {
    const runtime = createBrowserMockRuntime('running');
    const first = await runtime.invoke('get_usage_events', { query: { failed: true, page_size: 1 } }) as { items: Array<Record<string, unknown>>; total: number; totalPages: number };
    expect(first.total).toBeGreaterThan(2);
    expect(first.totalPages).toBe(first.total);
    expect(first.items).toHaveLength(1);
    expect(first.items[0].failed).toBe(true);
    const next = await runtime.invoke('get_usage_events', { query: { failed: true, page_size: 1, page: 2 } }) as typeof first;
    expect(next.items[0].id).not.toBe(first.items[0].id);
    const exact = await runtime.invoke('get_usage_events', { query: {
      start: first.items[0].timestamp, end: first.items[0].timestamp,
      provider: first.items[0].provider, model: first.items[0].model, source: first.items[0].source,
      api_key_hash: first.items[0].api_key_hash, failed: true, canceled: false,
    } }) as typeof first;
    expect(exact.items.map((item) => item.id)).toContain(first.items[0].id);
    expect(await runtime.invoke('get_usage_events', { query: { model: 'absent-model' } })).toMatchObject({ items: [], total: 0 });
    expect(await runtime.invoke('get_usage_events', { query: { canceled: true } })).toMatchObject({ total: expect.any(Number) });
    const canceled = await runtime.invoke('get_usage_events', { query: { canceled: true } }) as typeof first;
    expect(canceled.total).toBeGreaterThan(0);
    expect(canceled.items.every((item) => item.canceled)).toBe(true);
  });

  test('unknown routes fail explicitly and canceled OAuth sessions cannot create credentials', async () => {
    const runtime = createBrowserMockRuntime('running');
    await expect(runtime.invoke('management_request', { request: { method: 'GET', path: '/missing-route' } })).rejects.toThrow('not implemented');
    await expect(runtime.invoke('management_request', { request: { method: 'POST', path: '/requests/api-call', body: { url: 'https://example.test/missing', method: 'GET' } } })).rejects.toThrow('not implemented');
    const session = await runtime.invoke('start_oauth_login', { provider: 'kimi' }) as { state: string };
    await runtime.invoke('management_request', { request: { method: 'DELETE', path: '/oauth/session', query: { state: session.state } } });
    expect(await runtime.invoke('get_oauth_status', { state: session.state })).toMatchObject({ status: 'error' });
    const credentials = await runtime.invoke('management_request', { request: { method: 'GET', path: '/credentials' } }) as { files: Array<{ name: string }> };
    expect(credentials.files.some(file => file.name === 'kimi-mock-login.json')).toBe(false);
  });

  test('latency simulation also works outside a browser', async () => {
    expect(await createBrowserMockRuntime('running', undefined, 1).invoke('get_core_status')).toMatchObject({ ready: true });
  });

  for (const scenario of ['running', 'empty'] as const) {
    test(`installs the bundled version independently of the latest release (${scenario})`, async () => {
      const runtime = createBrowserMockRuntime(scenario);
      const bundled = await runtime.invoke('detect_bundled_core') as { version: string; assetName: string };
      const latest = await runtime.invoke('check_latest_core') as { version: string };
      expect(bundled.version).not.toBe(latest.version);

      if (scenario === 'running') {
        await runtime.invoke('install_core_version', { version: latest.version });
      }
      expect(await runtime.invoke('install_bundled_core')).toMatchObject(bundled);
      expect(await runtime.invoke('get_core_status')).toMatchObject({
        installed: true,
        currentVersion: bundled.version,
        running: scenario === 'running',
      });
    });
  }

  test('models the core process lifecycle and emits status events', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const runtime = createBrowserMockRuntime('stopped', (event, payload) => {
      events.push({ event, payload });
    });

    expect(await runtime.invoke('get_core_status')).toMatchObject({
      installed: true,
      running: false,
      ready: false,
    });
    expect(await runtime.invoke('start_core_process')).toMatchObject({
      running: true,
      ready: true,
      processId: 42817,
    });
    expect(events.at(-1)).toMatchObject({
      event: 'core-status-changed',
      payload: { running: true, ready: true },
    });
  });

  test('persists config and management mutations in memory', async () => {
    const runtime = createBrowserMockRuntime('running');

    await runtime.invoke('add_core_api_key', { apiKey: 'sk-test', remark: 'test' });
    expect(await runtime.invoke('get_core_config_settings')).toMatchObject({
      apiKeys: expect.arrayContaining([{ apiKey: 'sk-test', remark: 'test' }]),
    });

    await runtime.invoke('management_request', {
      request: {
        method: 'PUT',
        path: '/config/api-keys/gemini',
        body: [{ name: 'test', keys: [{ 'api-key': 'AIza-test' }], models: [{ name: 'gemini-test' }] }],
      },
    });
    expect(await runtime.invoke('management_request', {
      request: { method: 'GET', path: '/config/api-keys/gemini' },
    })).toEqual([{ name: 'test', keys: [{ 'api-key': 'AIza-test' }], models: [{ name: 'gemini-test' }] }]);
  });

  test('uses normalized ratios for percentage-based usage metrics', async () => {
    const runtime = createBrowserMockRuntime('running');
    expect(await runtime.invoke('get_usage_overview')).toMatchObject({
      successRate: 96.47,
      cacheHitRate: 0.386,
    });
  });

  test('provides an explicit error scenario', async () => {
    const runtime = createBrowserMockRuntime('error');
    await expect(runtime.invoke('get_core_status')).rejects.toThrow('Browser Mock error scenario');
    expect(await runtime.invoke('plugin:app|version')).toBe('0.2.97-mock');
  });
});

describe('browser mock native provider groups', () => {
  const providers = ['gemini', 'interactions', 'vertex', 'codex', 'claude', 'xai', 'meta', 'openai-compatibility'] as const;
  const request = (runtime: ReturnType<typeof createBrowserMockRuntime>, method: string, path: string, body?: unknown) =>
    runtime.invoke('management_request', { request: { method, path, body } });

  for (const provider of providers) {
    test(`preserves native ${provider} groups, overrides, and extensions across saves`, async () => {
      const runtime = createBrowserMockRuntime('running');
      const path = `/config/api-keys/${provider}`;
      const groups = [{
        name: `${provider} production`,
        'base-url': 'https://provider.example/v1',
        headers: { 'X-Team': 'shared' },
        models: [{ name: 'model', alias: 'primary', 'future-model-option': false }],
        'request-retry': 0,
        'future-group-option': { enabled: false, values: [] },
        keys: [
          { 'api-key': 'first', weight: 2, headers: null, models: [], 'future-key-option': 0 },
          { 'api-key': 'second', 'proxy-url': '', headers: {}, models: null },
        ],
      }, { name: `${provider} empty standby`, keys: [], 'future-group-option': null }];

      expect(await request(runtime, 'GET', path)).toBeArray();
      expect(await request(runtime, 'PUT', path, groups)).toEqual({ status: 'ok', 'config-version': 8 });
      expect(await request(runtime, 'GET', path)).toEqual(groups);
      expect(await request(runtime, 'GET', '/config')).toMatchObject({
        'config-version': 8, 'api-keys': { [provider]: groups },
      });

      // Reading the legacy view must not flatten the authoritative state.
      const legacyPath = provider === 'openai-compatibility' ? path.slice('/config/api-keys'.length) : `/${provider}-api-key`;
      await request(runtime, 'GET', legacyPath);
      expect(await request(runtime, 'GET', path)).toEqual(groups);

      // Both writes and reads isolate stored values from caller mutations.
      const expected = structuredClone(groups);
      groups[0].keys[0]['api-key'] = 'mutated request';
      const readBack = await request(runtime, 'GET', path) as typeof groups;
      readBack[0].keys[0]['api-key'] = 'mutated response';
      expect(await request(runtime, 'GET', path)).toEqual(expected);

      await request(runtime, 'PUT', path, []);
      expect(await request(runtime, 'GET', path)).toEqual([]);
    });
  }

  test('returns native groups without flattening inherited and explicit empty values', async () => {
    const runtime = createBrowserMockRuntime('running');
    const groups = [{
      name: 'preserve this group name',
      'base-url': 'https://provider.example',
      priority: 5,
      headers: { 'X-Team': 'shared' },
      models: [{ name: 'shared-model' }],
      keys: [
        { 'api-key': 'first', priority: 0, headers: null, models: [] },
        { 'api-key': 'second', headers: {}, models: null },
      ],
    }];
    await request(runtime, 'PUT', '/config/api-keys/interactions', groups);
    expect(await request(runtime, 'GET', '/config/api-keys/interactions')).toEqual(groups);
  });

  test('updates native OpenAI groups while preserving metadata and keys', async () => {
    const runtime = createBrowserMockRuntime('running');
    const group = {
      name: 'custom group', 'base-url': 'https://provider.example/v1', disabled: false,
      'future-option': { enabled: false },
      keys: [{ 'api-key': 'first', weight: 0, 'proxy-url': '' }, { 'api-key': 'second', weight: 3 }],
    };
    await request(runtime, 'PUT', '/config/api-keys/openai-compatibility', [group]);
    await request(runtime, 'PUT', '/config/api-keys/openai-compatibility', [{ ...group, disabled: true }]);
    expect(await request(runtime, 'GET', '/config/api-keys/openai-compatibility')).toEqual([{ ...group, disabled: true }]);
    await request(runtime, 'PUT', '/config/api-keys/openai-compatibility', [{ ...group, keys: [group.keys[1]] }]);
    expect(await request(runtime, 'GET', '/config/api-keys/openai-compatibility')).toEqual([{ ...group, keys: [group.keys[1]] }]);
  });
});

describe('remote agent client fixture', () => {
  const connection = {
    mode: 'remote', managementOrigin: 'http://management.example.test:8317', managementKey: 'fixture-management-key',
    clientOrigin: 'https://client.example.test', clientKey: 'fixture-client-key',
  };
  test('configures, inspects, fetches, launches and probes the client target without emitting credentials', async () => {
    const events: Array<{ event: string; payload: unknown }> = [];
    const runtime = createBrowserMockRuntime('stopped', (event, payload) => events.push({ event, payload }));
    await runtime.invoke('save_core_connection', { connection });
    const inspect = async () => (await runtime.invoke('get_agent_config_statuses') as Array<Record<string, unknown>>)
      .find(status => status.id === 'codex');
    expect(await inspect()).toMatchObject({ connectionState: 'needs-update' });
    expect(await runtime.invoke('get_agent_models', { client: 'codex' })).toBeArray();
    await runtime.invoke('update_agent_config', { client: 'codex', model: 'claude-sonnet-4-6' });
    expect(await inspect()).toMatchObject({ connectionState: 'configured', currentModel: 'claude-sonnet-4-6' });
    await runtime.invoke('launch_agent', { client: 'codex', target: 'cli' });
    await runtime.invoke('core_health_probe', { model: 'claude-sonnet-4-6' });
    const operations = events.filter(({ event }) => event === 'browser-mock-client-operation');
    expect(operations).toHaveLength(6);
    for (const { payload } of operations) expect(payload).toMatchObject({ origin: connection.clientOrigin });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(connection.managementKey);
    expect(serialized).not.toContain(connection.clientKey);
    await runtime.invoke('save_core_connection', { connection: { ...connection, mode: 'local' } });
    expect(await inspect()).toMatchObject({ connectionState: 'needs-update' });
    await runtime.invoke('update_agent_config', { client: 'codex', model: 'gpt-5.2-codex' });
    expect(await inspect()).toMatchObject({ connectionState: 'configured' });
    expect(events.at(-1)?.payload).toMatchObject({ origin: 'http://127.0.0.1:8317' });
  });
  test('does not substitute management credentials or local keys for a missing/wrong client key', async () => {
    const runtime = createBrowserMockRuntime('stopped');
    for (const clientKey of ['', 'fixture-management-key', 'wrong-client-key']) {
      await runtime.invoke('save_core_connection', { connection: { ...connection, clientKey } });
      await expect(runtime.invoke('get_agent_models', { client: 'codex' })).rejects.toThrow('client authentication rejected');
      await expect(runtime.invoke('core_health_probe', { model: 'gpt-5.2-codex' })).rejects.toThrow('client authentication rejected');
    }
  });
  test('fences an agent request when a preceding connection save changes target during its delay', async () => {
    const runtime = createBrowserMockRuntime('stopped', undefined, 5);
    const saving = runtime.invoke('save_core_connection', { connection });
    const pending = runtime.invoke('get_agent_models', { client: 'codex' });
    await saving;
    await expect(pending).rejects.toThrow('connection changed');
  });
});
