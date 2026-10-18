import type { SectionSub } from '../../shell/types';

/** Sub-pages (tabs) of this section; subs[0] is the default. */
export const settingsSubs: readonly SectionSub[] = [
  { id: 'connection', labelKey: 'sec.settings.tab.connection' },
  { id: 'access', labelKey: 'sec.settings.tab.access' },
  { id: 'routing', labelKey: 'sec.settings.tab.routing' },
  { id: 'network', labelKey: 'sec.settings.tab.network' },
  { id: 'models', labelKey: 'sec.settings.tab.models' },
  { id: 'logs', labelKey: 'sec.settings.tab.logs' },
  { id: 'app', labelKey: 'sec.settings.tab.app' },
  { id: 'updates', labelKey: 'sec.settings.tab.updates' },
];
