import { Puzzle } from 'lucide-react';
import type { SectionRoute } from '../../shell/types';
import { lazySection } from '../../shell/lazySection';
import { pluginsSubs } from './subs';

const section = lazySection(() => import('./index').then(({ PluginsSection }) => ({ default: PluginsSection })));

export const pluginsRoute: SectionRoute = {
  id: 'plugins',
  labelKey: 'shell.nav.plugins',
  icon: Puzzle,
  group: 'secondary',
  subs: pluginsSubs,
  Page: section.Page,
  preload: section.preload,
  retry: section.retry,
};
