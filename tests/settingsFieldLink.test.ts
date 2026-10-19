import { describe, expect, test } from 'bun:test';
import { allSettingsTemplateGroups, resolveSettingField, settingFieldRoute, settingsNativeFields, settingsTemplateGroups } from '../src/services/settingsNavigation';
import { settingsSubs } from '../src/sections/settings/subs';
import { parseRoute } from '../src/shell/router';

describe('settings field deep links', () => {
  test('resolves the plugin GitHub token to the Access tab', () => {
    expect(resolveSettingField(['server', 'github-token'])).toEqual({ tab: 'access', key: 'server.github-token', group: 'general' });
    expect(settingFieldRoute(['server', 'github-token'])).toBe('/settings/access?field=server.github-token');
  });

  test('every template field resolves to a real settings tab', () => {
    for (const group of allSettingsTemplateGroups) for (const field of group.fields) {
      const target = resolveSettingField(field.path);
      expect(target, field.path.join('.')).not.toBeNull();
      expect(settingsSubs.some((sub) => sub.id === target!.tab)).toBe(true);
    }
  });

  test('template groups resolve to the tab that renders them', () => {
    const tabOf = (group: keyof typeof settingsTemplateGroups) => resolveSettingField(settingsTemplateGroups[group][0].fields[0].path)?.tab;
    expect([tabOf('general'), tabOf('routing'), tabOf('requests'), tabOf('oauth'), tabOf('diagnostics')]).toEqual(['access', 'routing', 'models', 'models', 'logs']);
  });

  test('native fields resolve and name existing tabs', () => {
    expect(resolveSettingField('routing.strategy')?.tab).toBe('routing');
    expect(resolveSettingField(['observability', 'usage', 'redis-usage-queue-retention-seconds'])?.tab).toBe('logs');
    for (const tab of Object.values(settingsNativeFields)) expect(settingsSubs.some((sub) => sub.id === tab)).toBe(true);
  });

  test('unknown paths do not resolve', () => {
    expect(resolveSettingField(['nope', 'missing'])).toBeNull();
    expect(settingFieldRoute('nope')).toBeNull();
  });

  test('the route round-trips through the hash router', () => {
    const route = parseRoute(`#${settingFieldRoute(['server', 'github-token'])}`);
    expect([route.page, route.sub, route.params.get('field')]).toEqual(['settings', 'access', 'server.github-token']);
  });
});
