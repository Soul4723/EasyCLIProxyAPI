import { ArrowLeft } from 'lucide-react';
import { useCoreRuntime } from '../../coreRuntime';
import { useI18n } from '../../i18n';
import { Button, Chip, EmptyState, Tabs, tabPanelProps } from '../../ui';
import { navigate, routeHref, routePath } from '../../shell/router';
import { ClientLogo } from './ClientLogo';
import { clientState, clientVersion } from './clientState';
import { agentDetailTabs, type AgentDetailTab } from './subs';
import { RunControls } from './RunControls';
import { SetupTab } from './SetupTab';
import { BackupsTab } from './BackupsTab';
import { ManageTab } from './ManageTab';
import { AgentDialogs } from './AgentDialogs';
import { InlineNotice } from './InlineNotice';
import type { AgentsController } from './useAgentsController';

/** One client's page: identity header (state, version, launch controls) and Setup · Backups · Manage tabs. */
export function AgentDetail({ ctl, tab }: { ctl: AgentsController; tab: AgentDetailTab }) {
  const { t } = useI18n();
  const remote = useCoreRuntime().status?.connectionMode === 'remote';
  const { activeDefinition: definition } = ctl;
  const status = ctl.activeStatus ?? undefined;
  const state = clientState(definition, status);
  const version = clientVersion(status);
  const openTab = (next: string) => navigate(routePath('agents', null, { client: ctl.selected, tab: next === 'setup' ? undefined : next }), { replace: true });
  return (
    <div className="ag-detail">
      <div className="ag-detail-head">
        <a className="ag-back" href={routeHref('agents')}><ArrowLeft size={14} aria-hidden />{t('sec.agents.detail.back')}</a>
        <div className="ag-detail-id">
          <ClientLogo definition={definition} size={44} />
          <div className="ag-detail-title">
            <h2>{definition.name}</h2>
            <div className="ag-detail-meta">
              <Chip tone={state.tone} size="sm">{t(state.labelKey)}</Chip>
              {version ? <span className="ec-mono ec-muted">{version}</span> : null}
              {ctl.appliedModel ? <span className="ec-mono ec-trunc" title={ctl.appliedModel}>{ctl.appliedModel}</span> : null}
            </div>
          </div>
          <span className="ag-spacer" />
          {ctl.selected === 'codex' && !remote
            ? <a className="ag-link" href={routeHref('agents', 'sessions')}>{t('sec.agents.detail.sessions')} →</a> : null}
          <RunControls ctl={ctl} />
        </div>
        {status?.error || status?.warnings.length ? (
          <InlineNotice tone={status.error ? 'error' : 'info'} message={status.error || status.warnings.join('；')} />
        ) : null}
        {ctl.launchError ? <InlineNotice tone="error" message={ctl.launchError} onDismiss={() => ctl.setLaunchError('')} /> : null}
      </div>
      <Tabs idBase="agent-detail" ariaLabel={t('sec.agents.detail.tabs')} active={tab} onChange={openTab}
        tabs={agentDetailTabs.map((id) => ({ id, label: t(`sec.agents.detail.tab.${id}` as const) }))} />
      <div className="ag-detail-body" {...tabPanelProps('agent-detail', tab)}>
        {tab === 'setup' ? <SetupTab ctl={ctl} /> : null}
        {tab === 'backups' ? <BackupsTab ctl={ctl} /> : null}
        {tab === 'manage' ? <ManageTab ctl={ctl} /> : null}
        <div className="ag-notices" aria-live="polite">
          {ctl.configurationErrorMessage ? <InlineNotice tone="error" message={ctl.configurationErrorMessage} onDismiss={ctl.dismissMessages} /> : null}
          {!ctl.configurationErrorMessage && (ctl.configurationNotice || ctl.clearNotice)
            ? <InlineNotice tone="success" message={ctl.configurationNotice || ctl.clearNotice} onDismiss={ctl.dismissNotices} /> : null}
        </div>
      </div>
      <AgentDialogs ctl={ctl} />
    </div>
  );
}

export function AgentNotFound() {
  const { t } = useI18n();
  return <EmptyState title={t('sec.agents.detail.notFound')} action={<Button onClick={() => navigate('/agents')}>{t('sec.agents.detail.back')}</Button>} />;
}
