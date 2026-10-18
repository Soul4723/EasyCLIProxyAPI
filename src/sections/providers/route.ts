import { Network } from 'lucide-react';
import type { SectionRoute } from '../../shell/types';
import { ProvidersSection } from './index';
import { providersSubs } from './subs';


export const providersRoute: SectionRoute = {
  id: 'providers',
  labelKey: 'shell.nav.providers',
  icon: Network,
  group: 'main',
  subs: providersSubs,
  Page: ProvidersSection,
};
