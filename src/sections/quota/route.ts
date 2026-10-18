import { Gauge } from 'lucide-react';
import type { SectionRoute } from '../../shell/types';
import { QuotaSection } from './index';
import { quotaSubs } from './subs';


export const quotaRoute: SectionRoute = {
  id: 'quota',
  labelKey: 'shell.nav.quota',
  icon: Gauge,
  group: 'main',
  subs: quotaSubs,
  Page: QuotaSection,
};
