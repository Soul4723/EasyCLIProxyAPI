import { Settings } from 'lucide-react';
import type { SectionRoute } from '../../shell/types';
import { SettingsSection } from './index';
import { settingsSubs } from './subs';


export const settingsRoute: SectionRoute = {
  id: 'settings',
  labelKey: 'shell.nav.settings',
  icon: Settings,
  group: 'secondary',
  subs: settingsSubs,
  alwaysAvailable: true,
  Page: SettingsSection,
};
