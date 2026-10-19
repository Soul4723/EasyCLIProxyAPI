import { describe, expect, test } from 'bun:test';
import { parseRoute, routeHref, routePath } from '../src/shell/router';
import { legacyPagePaths } from '../src/shell/legacyPaths';

describe('hash router', () => {
  test('parses page, sub and query', () => {
    const route = parseRoute('#/usage/requests?model=gpt-5&page=2');
    expect(route.page).toBe('usage');
    expect(route.sub).toBe('requests');
    expect(route.params.get('model')).toBe('gpt-5');
    expect(route.path).toBe('/usage/requests?model=gpt-5&page=2');
  });
  test('empty and page-only hashes', () => {
    expect(parseRoute('').page).toBe('');
    expect(parseRoute('#/quota')).toMatchObject({ page: 'quota', sub: null, path: '/quota' });
    expect(parseRoute('#/settings/')).toMatchObject({ page: 'settings', sub: null });
  });
  test('builds hrefs and encodes segments', () => {
    expect(routeHref('settings', 'connection')).toBe('#/settings/connection');
    expect(routePath('quota', null, { cred: 'a b', none: undefined })).toBe('/quota?cred=a+b');
  });
  test('legacy page ids map to routes', () => {
    expect(legacyPagePaths.easy).toBe('/overview');
    expect(legacyPagePaths.config).toBe('/settings');
    expect(legacyPagePaths['usage-records']).toBe('/usage');
  });
});
