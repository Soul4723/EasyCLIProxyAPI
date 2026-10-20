import { Network } from 'lucide-react';
import type { SectionRoute } from '../../shell/types';
import { lazySection } from '../../shell/lazySection';
import { providersSubs } from './subs';

const section = lazySection(() => import('./index').then(({ ProvidersSection }) => ({ default: ProvidersSection })));

export const providersRoute: SectionRoute = {
  id: 'providers',
  labelKey: 'shell.nav.providers',
  icon: Network,
  group: 'main',
  subs: providersSubs,
  Page: section.Page,
  preload: section.preload,
  retry: section.retry,
};
