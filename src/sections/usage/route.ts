import { ChartNoAxesColumn } from 'lucide-react';
import type { SectionRoute } from '../../shell/types';
import { lazySection } from '../../shell/lazySection';
import { usageSubs } from './subs';

const section = lazySection(() => import('./index').then(({ UsageSection }) => ({ default: UsageSection })));

export const usageRoute: SectionRoute = {
  id: 'usage',
  labelKey: 'shell.nav.usage',
  icon: ChartNoAxesColumn,
  group: 'main',
  subs: usageSubs,
  alwaysAvailable: true,
  Page: section.Page,
  preload: section.preload,
  retry: section.retry,
};
