import { generalTemplateGroups, requestTemplateGroups, routingTemplateGroups } from './generalTemplateFields';
import { oauthTemplateGroups } from './oauthTemplateFields';
import { extensionTemplateGroups } from './extensionTemplateFields';
import { payloadTemplateGroups } from './payloadTemplateFields';

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
/** Opens the Settings page. The field path is accepted for callers but Settings has no per-field deep link yet. */
export const openSettingField = (_path: readonly string[]) => {
  window.dispatchEvent(new CustomEvent('app:navigate', { detail: 'config' }));
};
