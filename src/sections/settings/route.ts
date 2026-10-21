import { Settings } from 'lucide-react';
import type { SectionRoute } from '../../shell/types';
import { lazySection } from '../../shell/lazySection';
import { settingsSubs } from './subs';

const section = lazySection(() => import('./index').then(({ SettingsSection }) => ({ default: SettingsSection })));

export const settingsRoute: SectionRoute = {
  id: 'settings',
  labelKey: 'shell.nav.settings',
  icon: Settings,
  group: 'secondary',
  subs: settingsSubs,
  alwaysAvailable: true,
  Page: section.Page,
  preload: section.preload,
  retry: section.retry,
};
