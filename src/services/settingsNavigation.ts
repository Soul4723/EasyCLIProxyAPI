import { generalTemplateGroups, requestTemplateGroups, routingTemplateGroups } from './generalTemplateFields';
import { oauthTemplateGroups } from './oauthTemplateFields';
import { extensionTemplateGroups } from './extensionTemplateFields';
import { payloadTemplateGroups } from './payloadTemplateFields';
import type { TemplateConfigGroup } from './templateConfig';
import { navigate, routePath } from '../shell/router';

export const settingsTemplateGroups = {
  general: generalTemplateGroups.filter(group => group.id === 'management'),
  aliases: [],
  routing: [...routingTemplateGroups, ...extensionTemplateGroups.filter(group => group.id === 'extensions-concurrency')],
  requests: [...requestTemplateGroups, ...payloadTemplateGroups],
  oauth: ['oauth-common', 'oauth-codex', 'oauth-others', 'oauth-claude', 'oauth-models', 'oauth-media']
    .map(id => oauthTemplateGroups.find(group => group.id === id)!),
  diagnostics: [...generalTemplateGroups.filter(group => group.id === 'diagnostics'), ...extensionTemplateGroups.filter(group => group.id === 'extensions-inflight')],
  software: [],
};
export const allSettingsTemplateGroups = Object.values(settingsTemplateGroups).flat();
/** Settings tab that renders each template group set above (the tab ids are `settingsSubs`). */
const templateGroupTabs: Partial<Record<keyof typeof settingsTemplateGroups, string>> = {
  general: 'access', routing: 'routing', requests: 'models', oauth: 'models', diagnostics: 'logs',
};

/** Fields the tabs render natively (not from a template group): dotted config path → tab. Rows carry the same path in `data-field-path`. */
export const settingsNativeFields: Readonly<Record<string, string>> = {
  'routing.strategy': 'routing',
  'routing.session-affinity': 'routing',
  'routing.session-affinity-ttl': 'routing',
  'observability.usage.redis-usage-queue-retention-seconds': 'logs',
};

export type SettingFieldTarget = { tab: string; key: string; group: keyof typeof settingsTemplateGroups | null };

/** Resolves a config field path to the tab (and template group set) that renders it; null when no tab does. */
export function resolveSettingField(path: readonly string[] | string): SettingFieldTarget | null {
  const key = typeof path === 'string' ? path : path.join('.');
  const native = settingsNativeFields[key];
  if (native) return { tab: native, key, group: null };
  for (const [group, groups] of Object.entries(settingsTemplateGroups) as [keyof typeof settingsTemplateGroups, readonly TemplateConfigGroup[]][]) {
    const tab = templateGroupTabs[group];
    if (tab && groups.some((entry) => entry.fields.some((field) => field.path.join('.') === key))) return { tab, key, group };
  }
  return null;
}

/** `/settings/<tab>?field=<path>` for a field, or null when it has no tab. */
export function settingFieldRoute(path: readonly string[] | string): string | null {
  const target = resolveSettingField(path);
  return target ? routePath('settings', target.tab, { field: target.key }) : null;
}

/** Opens Settings on the tab that renders the field; Settings then scrolls to, focuses and highlights it. Goes through the navigation guard. */
export const openSettingField = (path: readonly string[]) => {
  const route = settingFieldRoute(path);
  if (route) navigate(route);
  else window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'config' }));
};
