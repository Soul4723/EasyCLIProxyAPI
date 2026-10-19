import { describe, expect, it } from 'bun:test';
import { normalizePluginStore } from '../../../src/services/plugins';
import { getPluginStoreSources, pluginStoreSourceKey } from '../../../src/services/pluginStoreSources';
import { pluginText } from '../../../src/i18n/plugins';

describe('plugin store sources', () => {
  it('retains configured empty sources and merges card/error fallbacks by ID or URL', () => {
    const store = normalizePluginStore({ sources: [null, {},
      { id: 'empty', name: 'Empty', url: 'https://empty.test' },
      { id: 'one', name: 'Shared', url: 'https://one.test' },
      { name: 'Shared', url: 'https://two.test' },
    ], plugins: [
      { id: 'same-plugin', source_id: 'one', source_name: 'Shared', source_url: 'https://one.test' },
      { id: 'same-plugin', source_url: 'https://two.test', source_name: 'Shared' },
      { id: 'legacy', source_id: 'legacy' },
      { id: 'unknown' },
    ], source_errors: [{ source_id: 'failed', source_name: 'Offline', message: 'Unavailable' }] });
    expect(store.sources[1]).toEqual({ sourceId: 'empty', sourceName: 'Empty', sourceUrl: 'https://empty.test' });
    expect(getPluginStoreSources(store)).toEqual([
      { key: 'empty', label: 'Empty' },
      { key: 'one', label: 'Shared (one)' },
      { key: 'https://two.test', label: 'Shared (https://two.test)' },
      { key: 'legacy', label: 'legacy' },
      { key: 'failed', label: 'Offline' },
    ]);
    expect(store.plugins[1].storeId).toBe('https://two.test/same-plugin');
    expect(store.plugins.map(pluginStoreSourceKey)).toEqual(['one', 'https://two.test', 'legacy', '']);
    expect(getPluginStoreSources(null)).toEqual([]);
    expect(normalizePluginStore({ plugins: [] }).sources).toEqual([]);
  });

  it('localizes native selector labels using existing Traditional Chinese conversion', () => {
    expect((['en', 'zh-CN', 'zh-TW', 'ja'] as const).map(locale => pluginText('storeSource', locale)))
      .toEqual(['Store source', '商店来源', '商店來源', 'ストアのソース']);
    expect((['en', 'zh-CN', 'zh-TW', 'ja'] as const).map(locale => pluginText('allStores', locale)))
      .toEqual(['All stores', '全部商店', '全部商店', 'すべてのストア']);
  });
});
