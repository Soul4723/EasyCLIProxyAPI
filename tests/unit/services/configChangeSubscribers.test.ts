import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../../../src/', import.meta.url).pathname;
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const sourceFiles = (dir = ''): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap(entry =>
  entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);

// Hook subscribers listen through listenConfigChange, so the runtime behaviour is the one tested in configChange.test.ts.
test.each([
  'sections/overview/data.ts',
  'sections/settings/updates/useVersionSource.ts',
  'sections/settings/tabs/NetworkTab.tsx',
])('%s filters config-files-changed by scope', file => {
  const text = read(file);
  expect(text).toContain('listenConfigChange(CORE_CONFIG_SCOPES,');
  expect(text).not.toMatch(/listen(<[^>]*>)?\('config-files-changed'/);
});

test('every data source on config-files-changed carries a scope filter', () => {
  for (const file of ['services/coreConfig.ts', 'services/credentials.ts', 'sections/overview/data.ts']) {
    const text = read(file);
    const sources = text.match(/events: \['config-files-changed'\]/g)?.length ?? 0;
    const filters = text.match(/eventFilter: configChangeFilter\(CORE_CONFIG_SCOPES\)/g)?.length ?? 0;
    expect(sources).toBeGreaterThan(0);
    expect(filters).toBe(sources);
  }
});

test('no new unfiltered config-files-changed subscriber appears', () => {
  const raw = sourceFiles().filter(file => read(file).includes("'config-files-changed'")).sort();
  expect(raw).toEqual([
    'mocks/browserMockRuntime.ts',
    'sections/agents/useAgentsController.ts', // statuses and models depend on gui, core and agent files alike
    'sections/overview/data.ts',
    'services/configChange.ts',
    'services/coreConfig.ts',
    'services/credentials.ts',
  ]);
});
