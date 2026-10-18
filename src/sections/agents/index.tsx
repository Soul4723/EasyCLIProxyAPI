import { LegacyHost } from '../../shell/LegacyHost';
import type { SectionPageProps } from '../../shell/types';
import { AgentsPage } from '../../pages/AgentsPage';
import { agentsSubs } from './subs';
import './agents.css';

/** PLACEHOLDER: renders the existing page inside the new shell until this section is rebuilt. */
export function AgentsSection({ sub, params: _params }: SectionPageProps) {

  return (
    <LegacyHost page="agents" titleKey="shell.nav.agents" subs={agentsSubs} sub={sub}>
      {<AgentsPage />}
    </LegacyHost>
  );
}
