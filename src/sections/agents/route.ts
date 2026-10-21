import { Bot } from 'lucide-react';
import type { SectionRoute } from '../../shell/types';
import { lazySection } from '../../shell/lazySection';
import { agentsSubs } from './subs';

const section = lazySection(() => import('./index').then(({ AgentsSection }) => ({ default: AgentsSection })));

export const agentsRoute: SectionRoute = {
  id: 'agents',
  labelKey: 'shell.nav.agents',
  icon: Bot,
  group: 'secondary',
  subs: agentsSubs,
  alwaysAvailable: true,
  Page: section.Page,
  preload: section.preload,
  retry: section.retry,
};
