import type { SectionMockFactory, SectionMockHost } from '../../../mocks/sectionMockTypes';

type Group = Record<string, unknown>;
type ProviderConfig = Record<string, Group[]>;

const keyGroup = (name: string, baseUrl: string, apiKey: string, models: string[], extra: Group = {}): Group => ({
  name,
  'base-url': baseUrl,
  models: models.map((model) => ({ name: model })),
  ...extra,
  keys: [{ name, 'api-key': apiKey }],
});

/** Extra providers so every API-key kind has rows in the browser mock (the shared mock only seeds Codex/Claude/Gemini/OpenAI-compatible). */
function seedExtras(host: SectionMockHost) {
  const config = host.providerConfig as ProviderConfig | undefined;
  if (!config || host.scenario !== 'running') return;
  config['vertex-api-key'] = [keyGroup('Vertex Europe', 'https://europe-west4-aiplatform.googleapis.com', 'vx-mock-vertex-key', ['gemini-3-pro', 'gemini-3-flash'], { priority: 5 })];
  config['xai-api-key'] = [keyGroup('xAI Direct', 'https://api.x.ai/v1', 'xai-mock-key-1234', ['grok-5', 'grok-5-mini'])];
  config['meta-api-key'] = [keyGroup('Muse Preview', 'https://api.muse.example.com/v1', 'meta-mock-key-5678', ['muse-1'])];
  config['interactions-api-key'] = [keyGroup('Gemini Interactions', 'https://generativelanguage.googleapis.com', 'AIza-mock-interactions', ['gemini-3-pro'])];
  // A second Claude key whose upstream is down: the "check all" run and the failed status pill show up in the mock.
  config['claude-api-key'] = [
    ...(config['claude-api-key'] ?? []),
    keyGroup('Claude Backup', 'https://broken.mock.example.com', 'sk-ant-mock-broken', ['claude-sonnet-4-6'], { disabled: false }),
  ];
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('mockProviders') === 'many') {
    const many: Group[] = Array.from({ length: 24 }, (_, index) => ({
      name: `Gateway ${index + 1}`,
      'base-url': `https://gateway-${index + 1}.mock.example.com/v1`,
      priority: index,
      models: [{ name: `gw-${index + 1}-large` }, { name: `gw-${index + 1}-fast` }],
      keys: [{ 'api-key': `sk-mock-gateway-${index + 1}-aaaa` }, ...(index % 3 === 0 ? [{ 'api-key': `sk-mock-gateway-${index + 1}-bbbb`, 'excluded-models': ['*'] }] : [])],
    }));
    config['openai-compatibility'] = [...(config['openai-compatibility'] ?? []), ...many];
  }
}

/** Browser-mock handlers for the api part of Providers; chained from ../mock.ts. */
export const apiMock: SectionMockFactory = (host) => {
  seedExtras(host);
  return {
    handle(command, payload) {
      // Health probes against a "broken" upstream fail; every other probe succeeds (shared mock behaviour).
      if (command === 'provider_health_probe') {
        const request = (payload.request ?? {}) as { url?: string };
        if (String(request.url ?? '').includes('broken')) {
          return { handled: true, value: Promise.reject(new Error('HTTP 502 Bad Gateway: upstream connect error')) };
        }
      }
      return { handled: false };
    },
  };
};
