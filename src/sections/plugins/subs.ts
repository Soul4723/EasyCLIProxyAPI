import type { SectionSub } from '../../shell/types';

/** Sub-pages (tabs) of this section; subs[0] is the default. */
export const pluginsSubs: readonly SectionSub[] = [
  { id: 'installed', labelKey: 'sec.plugins.tab.installed' },
  { id: 'store', labelKey: 'sec.plugins.tab.store' },
  { id: 'settings', labelKey: 'sec.plugins.tab.settings' },
];

export type PluginTab = 'installed' | 'store' | 'settings';
