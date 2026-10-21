import { useEffect } from 'react';
import { RefreshCw } from 'lucide-react';
import { useCoreConnectionMode } from '../../coreRuntime';
import { useI18n } from '../../i18n';
import { PageHeader } from '../../shell/PageHeader';
import { RouteTabs } from '../../shell/RouteTabs';
import { navigate, replaceRoute, routePath } from '../../shell/router';
import type { SectionPageProps } from '../../shell/types';
import { Button } from '../../ui';
import { AgentDetail, AgentNotFound } from './AgentDetail';
import { AgentsGrid } from './AgentsGrid';
import { agentDefinitions, type AgentClientId } from './model';
import { SessionsView } from './sessions/SessionsView';
import { agentDetailTabs, agentsSubs, agentsSubsFor, type AgentDetailTab } from './subs';
import { useAgentsController } from './useAgentsController';
import './agents.css';

/** Agents: client grid → per-client detail (`?client=<id>&tab=`), plus the Codex sessions sub-page. */
export function AgentsSection({ sub, params }: SectionPageProps) {
  const { t } = useI18n();
  const mode = useCoreConnectionMode();
  // Codex sessions are read from the local disk, so Remote has no such tab; wait for the first status before mounting it.
  const remote = mode === 'remote';
  const subs = agentsSubsFor(remote);
  const active = sub ?? agentsSubs[0].id;
  const sessionsBlocked = active === 'sessions' && (remote || mode === undefined);
  useEffect(() => {
    if (active === 'sessions' && remote) replaceRoute(routePath('agents'));
  }, [active, remote]);
  const rawClient = params.get('client');
  const clientId = active === 'clients' && agentDefinitions.some((agent) => agent.id === rawClient) ? (rawClient as AgentClientId) : null;
  const unknownClient = active === 'clients' && rawClient !== null && clientId === null;
  const rawTab = params.get('tab');
  const tab: AgentDetailTab = agentDetailTabs.find((id) => id === rawTab) ?? 'setup';
  const ctl = useAgentsController(clientId, {
    onOpenManage: () => navigate(routePath('agents', null, { client: clientId ?? undefined, tab: 'manage' }), { replace: true }),
  });
  const detected = ctl.statuses.filter((status) => status.installed || status.configExists).length;
  return (
    <div className="ec-sec-agents">
      <PageHeader title={t('shell.nav.agents')} count={clientId || active === 'sessions' ? undefined : detected}
        tabs={<RouteTabs page="agents" subs={subs} active={active} ariaLabel={t('shell.nav.agents')} />}
        actions={active === 'clients' ? (
          <Button variant="secondary" icon={<RefreshCw size={14} />} loading={ctl.loading} disabled={ctl.busy}
            onClick={() => void ctl.refresh()}>{t('sec.agents.rescan')}</Button>
        ) : undefined} />
      <div className="ec-page-body">
        {sessionsBlocked ? null
          : active === 'sessions' ? <SessionsView />
          : clientId ? <AgentDetail ctl={ctl} tab={tab} />
          : unknownClient ? <AgentNotFound />
          : <AgentsGrid ctl={ctl} />}
      </div>
    </div>
  );
}
