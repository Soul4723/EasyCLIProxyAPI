import { describe, expect, test } from 'bun:test';
import { createThemeApplicator } from '../src/themes/applyTheme';
import { emberBridgeProperties, themeEmberTokens } from '../src/themes/emberBridge';
import { themeRegistry } from '../src/themes/registry';

const fakeDocument = () => {
  const properties = new Map<string, string>();
  const root = {
    dataset: {} as Record<string, string>,
    style: {
      setProperty: (key: string, value: string) => { properties.set(key, value); },
      removeProperty: (key: string) => { properties.delete(key); },
      colorScheme: '', backgroundColor: '',
    },
  };
  const document = { documentElement: root, body: { style: { backgroundColor: '' } }, querySelector: () => null, head: { append() {} }, createElement: () => ({ dataset: {} }) };
  return { document: document as unknown as Document, properties };
};

describe('--ec-* theme bridge', () => {
  test('Ember dark and light keep the stylesheet tokens', () => {
    expect(themeEmberTokens(themeRegistry.get('dark')!)).toEqual({});
    expect(themeEmberTokens(themeRegistry.get('light')!)).toEqual({});
  });

  test.each(['warm-sand-light', 'graphite-dark', 'sakura-light', 'midnight-dark'])('%s drives the semantic layer', (id) => {
    const theme = themeRegistry.get(id)!;
    const tokens = themeEmberTokens(theme);
    for (const property of ['--ec-bg', '--ec-surface', '--ec-raised', '--ec-popover', '--ec-fg', '--ec-border', '--ec-accent', '--ec-accent-fg', '--ec-sidebar']) {
      expect(tokens[property]).toBeDefined();
    }
    expect(tokens['--ec-accent']).toBe(theme.tokens.accent!);
    expect(tokens['--ec-fg']).toBe(theme.tokens.textPrimary!);
    expect(tokens['--ec-bg']).toBe(theme.tokens.workspaceBackground ?? theme.windowBackground);
    expect(tokens['--ec-popover']).toMatch(/^#[\da-f]{6}$/i);
    for (const property of Object.keys(tokens)) expect(emberBridgeProperties).toContain(property);
  });

  test('applying a theme sets the variables and switching to Ember clears them', () => {
    const { document, properties } = fakeDocument();
    const apply = createThemeApplicator(document);
    apply(themeRegistry.get('graphite-dark')!);
    expect(properties.get('--ec-accent')).toBe(themeRegistry.get('graphite-dark')!.tokens.accent!);
    apply(themeRegistry.get('dark')!);
    expect([...properties.keys()].filter((key) => key.startsWith('--ec-'))).toEqual([]);
  });
});
