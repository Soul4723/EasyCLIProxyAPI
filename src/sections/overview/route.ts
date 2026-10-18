import { LayoutDashboard } from 'lucide-react';
import type { SectionRoute } from '../../shell/types';
import { OverviewSection } from './index';
import { overviewSubs } from './subs';


export const overviewRoute: SectionRoute = {
  id: 'overview',
  labelKey: 'shell.nav.overview',
  icon: LayoutDashboard,
  group: 'main',
  subs: overviewSubs,
  alwaysAvailable: true,
  Page: OverviewSection,
};
