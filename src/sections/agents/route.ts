import { Bot } from 'lucide-react';
import type { SectionRoute } from '../../shell/types';
import { AgentsSection } from './index';
import { agentsSubs } from './subs';


export const agentsRoute: SectionRoute = {
  id: 'agents',
  labelKey: 'shell.nav.agents',
  icon: Bot,
  group: 'secondary',
  subs: agentsSubs,
  alwaysAvailable: true,
  Page: AgentsSection,
};
