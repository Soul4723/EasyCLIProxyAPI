import { ChartNoAxesColumn } from 'lucide-react';
import type { SectionRoute } from '../../shell/types';
import { UsageSection } from './index';
import { usageSubs } from './subs';


export const usageRoute: SectionRoute = {
  id: 'usage',
  labelKey: 'shell.nav.usage',
  icon: ChartNoAxesColumn,
  group: 'main',
  subs: usageSubs,
  alwaysAvailable: true,
  Page: UsageSection,
};
