import type { SectionMockFactory } from '../../mocks/sectionMockTypes';

/**
 * Browser-mock handlers owned by the plugins section (see src/mocks/sectionMocks.ts). The shared plugin mock
 * (src/mocks/pluginMock.ts) answers every /plugins request, so this only adds states: `?mockPlugins=many` seeds
 * configuration-only plugins (they render as missing-file / config-only rows) to exercise long lists. It also answers the
 * local-install picker and `install_local_plugin`.
 */
export const pluginsMock: SectionMockFactory = (host) => {
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mockPlugins') === 'many' && host.scenario !== 'empty') {
    const names = ['quota-router', 'usage-exporter', 'cache-guard', 'prompt-shield', 'latency-probe', 'cost-capper', 'audit-trail', 'model-mapper', 'rate-smoother', 'retry-booster', 'trace-bridge', 'secret-scrubber'];
    const configs = Object.fromEntries(names.map((name, index) => [name, { enabled: index % 3 !== 0, priority: index }]));
    const extended = host.extendedConfig as Record<string, unknown> | undefined;
    if (extended) extended.plugins = { configs };
  }
  return {
    handle(command, payload) {
      // Local plugin install: the picker answers with a library file, the install copies it into `plugins/` (no overwrite, no disk effect in the mock).
      if (command === 'plugin:dialog|open') {
        const options = (payload.options ?? {}) as { filters?: { extensions?: string[] }[] };
        if (options.filters?.some(filter => filter.extensions?.includes('dll'))) return { handled: true, value: 'C:\\Users\\Mock\\Downloads\\request-tracer.dll' };
      }
      if (command === 'install_local_plugin') {
        const source = String(payload.source ?? '');
        return { handled: true, value: `plugins/${source.split(/[\\/]/).pop() ?? source}` };
      }
      // Latest GitHub releases for the installed-tab update check (the mock store lists request-inspector 1.0.0 → 1.1.0).
      if (command === 'get_plugin_latest_releases') {
        const repositories = (payload.repositories ?? []) as string[];
        return { handled: true, value: repositories.map(repository => ({ repository, version: repository.endsWith('request-inspector') ? '1.2.0' : null, error: null })) };
      }
      return { handled: false };
    },
  };
};
