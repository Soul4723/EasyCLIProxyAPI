import { Gauge } from 'lucide-react';
import type { SectionRoute } from '../../shell/types';
import { lazySection } from '../../shell/lazySection';
import { quotaSubs } from './subs';

const section = lazySection(() => import('./index').then(({ QuotaSection }) => ({ default: QuotaSection })));

export const quotaRoute: SectionRoute = {
  id: 'quota',
  labelKey: 'shell.nav.quota',
  icon: Gauge,
  group: 'main',
  subs: quotaSubs,
  Page: section.Page,
  preload: section.preload,
  retry: section.retry,
};
