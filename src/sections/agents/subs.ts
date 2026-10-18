import type { SectionSub } from '../../shell/types';

/** Sub-pages (tabs) of this section; subs[0] is the default. A client's detail lives at `#/agents?client=<id>&tab=<tab>`. */
export const agentsSubs: readonly SectionSub[] = [
  { id: 'clients', labelKey: 'sec.agents.tab.clients' },
  { id: 'sessions', labelKey: 'sec.agents.tab.sessions' },
];

export const agentDetailTabs = ['setup', 'backups', 'manage'] as const;
export type AgentDetailTab = (typeof agentDetailTabs)[number];
