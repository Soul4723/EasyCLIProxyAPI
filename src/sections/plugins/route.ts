import { Puzzle } from 'lucide-react';
import type { SectionRoute } from '../../shell/types';
import { PluginsSection } from './index';
import { pluginsSubs } from './subs';


export const pluginsRoute: SectionRoute = {
  id: 'plugins',
  labelKey: 'shell.nav.plugins',
  icon: Puzzle,
  group: 'secondary',
  subs: pluginsSubs,
  Page: PluginsSection,
};
