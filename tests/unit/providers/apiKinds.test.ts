import { describe, expect, it } from 'bun:test';
import { API_KINDS, brandOfKind, kindLabel, kindsOfBrand } from '../../../src/sections/providers/api/kinds';
import { healthOptionsFor, healthRowForKey } from '../../../src/sections/providers/api/health';
import { providerRowsFromGroups, providerSectionOrder } from '../../../src/sections/providers/api/logic';
import { providerInfo } from '../../../src/ui/providers';

describe('API key kinds', () => {
  it('lists every provider category once, in the old page order, with a kit brand', () => {
    expect(API_KINDS.map((kind) => kind.id)).toEqual(providerSectionOrder);
    expect(new Set(API_KINDS.map((kind) => kind.id)).size).toBe(API_KINDS.length);
    for (const kind of API_KINDS) {
      expect(providerInfo(kind.brand).id).toBe(kind.brand);
      expect(kind.label.length).toBeGreaterThan(0);
      expect(brandOfKind(kind.id)).toBe(kind.brand);
    }
  });

  it('groups the Gemini API and Interactions kinds under one brand and marks OpenAI-compatible as a key group', () => {
    expect(kindsOfBrand('gemini').map((kind) => kind.id)).toEqual(['gemini-api-key', 'interactions-api-key']);
    expect(kindsOfBrand('codex').map((kind) => kind.id)).toEqual(['codex-api-key']);
    expect(kindsOfBrand('deepseek').map((kind) => kind.id)).toEqual(['deepseek']);
    expect(kindsOfBrand('nope')).toEqual([]);
    expect(API_KINDS.filter((kind) => kind.openAi).map((kind) => kind.id)).toEqual(['openai-compatibility']);
    expect(kindLabel('vertex-api-key')).toBe('Vertex AI');
  });
});

// OpenAI-compatible services stay one row per group; the health dialog resolves the group's keys one at a time.
describe('API key health helpers', () => {
  const group = {
    name: 'Relay', 'base-url': 'https://relay.example.test/v1', headers: { 'X-Group': 'shared' }, 'proxy-url': 'direct',
    models: [{ name: 'shared-model' }],
    keys: [
      { 'api-key': 'key-one' },
      { 'api-key': 'key-two', 'auth-index': 'idx-2', headers: { 'X-Key': 'second' }, models: [{ name: 'private-model' }] },
    ],
  };
  const [first] = providerRowsFromGroups('openai-compatibility', [group]);

  it('builds the probe options from the row connection', () => {
    const options = healthOptionsFor(first);
    expect(options.provider).toBe('openai');
    expect(options.baseUrl).toBe('https://relay.example.test/v1');
    expect(options.apiKeys).toEqual(['key-one', 'key-two']); // the dialog narrows a group to one key via healthRowForKey
  });

  it('resolves one key of a group with its own overrides and inherited shared settings', () => {
    const second = healthRowForKey(first, 1);
    expect(second.apiKey).toBe('key-two');
    expect(second.apiKeys).toEqual(['key-two']);
    expect(second.authIndex).toBe('idx-2');
    expect(second.models.map((model) => model.name)).toEqual(['private-model']);
    expect(healthOptionsFor(second).customHeaders).toMatchObject({ 'X-Key': 'second' });
    expect(healthOptionsFor(second).proxyUrl).toBe('direct');
    const inherited = healthRowForKey(first, 0);
    expect(inherited.models.map((model) => model.name)).toEqual(['shared-model']);
    expect(healthOptionsFor(inherited).customHeaders).toMatchObject({ 'X-Group': 'shared' });
  });

  it('returns the row unchanged when the key index does not exist', () => {
    expect(healthRowForKey(first, 9)).toBe(first);
  });
});
