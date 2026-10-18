import type { SectionMockFactory } from '../../mocks/sectionMockTypes';

/**
 * Browser-mock handlers owned by the plugins section (see src/mocks/sectionMocks.ts). The shared plugin mock
 * (src/mocks/pluginMock.ts) answers every /plugins request, so this only adds states: `?mockPlugins=many` seeds
 * configuration-only plugins (they render as missing-file / config-only rows) to exercise long lists.
 */
export const pluginsMock: SectionMockFactory = (host) => {
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mockPlugins') === 'many' && host.scenario !== 'empty') {
    const names = ['quota-router', 'usage-exporter', 'cache-guard', 'prompt-shield', 'latency-probe', 'cost-capper', 'audit-trail', 'model-mapper', 'rate-smoother', 'retry-booster', 'trace-bridge', 'secret-scrubber'];
    const configs = Object.fromEntries(names.map((name, index) => [name, { enabled: index % 3 !== 0, priority: index }]));
    const extended = host.extendedConfig as Record<string, unknown> | undefined;
    if (extended) extended.plugins = { configs };
  }
  return { handle: () => ({ handled: false }) };
};
