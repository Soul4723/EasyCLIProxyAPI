/**
 * SetupTab: the "Setup" tab of a client's detail page.
 *
 * Props: ctl (AgentsController) — everything is read from it; this component only renders and calls handlers.
 *
 * Top to bottom: detection strip (installed, versions, extension status), model picker + catalog button
 * (not for the Claude clients, which render their own mapping editor), Codex connection method, and the
 * sticky save bar holding the single primary Apply action.
 */
import { BadgeCheck, ChevronDown, SlidersHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { CopilotPluginStatus } from '../../components/copilot/CopilotPluginStatus';
import { AgentModelPicker } from '../../components/AgentModelPicker';
import { useI18n } from '../../i18n';
import { routeHref } from '../../shell/router';
import { Button, Card, Chip, SegmentedControl, Skeleton } from '../../ui';
import { ClaudeCodeMapping } from './ClaudeCodeMapping';
import { ClaudeDesktopMapping } from './ClaudeDesktopMapping';
import type { AgentsController } from './useAgentsController';
import './setup.css';

type Fact = { key: string; label: ReactNode; value: ReactNode; title?: string };

/** One label/value cell of the detection strip. */
function FactCell({ fact }: { fact: Fact }) {
  return (
    <div className="ag-fact">
      <span className="ag-fact-label">{fact.label}</span>
      <strong className="ag-fact-value ec-mono" title={fact.title}>{fact.value}</strong>
    </div>
  );
}

function DetectionStrip({ ctl }: { ctl: AgentsController }) {
  const { t } = useI18n();
  const { activeStatus: status, selected } = ctl;
  const notFetched = t('agents.notFetched');
  const facts: Fact[] = [];
  if (ctl.hasIndependentCliAndApp) {
    facts.push(
      { key: 'cli', label: t('agents.cliVersion'), value: status?.cliVersion ?? notFetched, title: status?.cliVersion ?? undefined },
      { key: 'app', label: t('agents.appVersion'), value: status?.appVersion ?? notFetched, title: status?.appVersion ?? undefined },
    );
  } else {
    facts.push({ key: 'client', label: t('agents.clientVersion'), value: status?.version ?? notFetched, title: status?.version ?? undefined });
  }
  if (ctl.isPiClient) {
    facts.push({
      key: 'plugin',
      label: (
        <>
          {t('agents.pluginVersion')}
          {ctl.piPluginUpdateAvailable ? (
            <Chip tone="warn" size="sm"><span role="status" aria-label={ctl.piPluginUpdateTitle} title={ctl.piPluginUpdateTitle}>{t('agents.pi.updateAvailableShort')}</span></Chip>
          ) : null}
        </>
      ),
      value: status?.pluginVersion ?? notFetched,
      title: ctl.piPluginUpdateTitle,
    });
  }
  const installed = Boolean(status?.installed);
  return (
    <Card className="ag-setup-detect" aria-label={t('sec.agents.setup.detection')}>
      <div className="ag-detect-row">
        <div className="ag-fact">
          <span className="ag-fact-label"><BadgeCheck size={14} aria-hidden />{t('agents.installStatus')}</span>
          <Chip tone={installed ? 'ok' : 'outline'} size="sm">
            {t(!status ? 'sec.agents.state.detecting' : installed ? 'agents.clientDetected' : 'agents.clientNotDetected')}
          </Chip>
        </div>
        {facts.map((fact) => <FactCell key={fact.key} fact={fact} />)}
        {selected === 'vscode-copilot' ? (
          <div className="ag-fact ag-fact--copilot">
            <CopilotPluginStatus standalone={false} installed={Boolean(status?.pluginInstalled)} version={status?.pluginVersion ?? null} />
          </div>
        ) : null}
      </div>
      {status && !status.installed ? (
        <div className="ag-detect-hint" role="status">
          <span>{t('agents.executablePath.notDetected')}</span>
          <a className="ag-link" href={routeHref('agents', null, { client: selected, tab: 'manage' })}>{t('agents.executablePath.openManagement')} →</a>
        </div>
      ) : null}
    </Card>
  );
}

function ModelSection({ ctl }: { ctl: AgentsController }) {
  const { t } = useI18n();
  const { selected, busy } = ctl;
  const catalogButton = selected === 'codex' ? (
    <Button variant="secondary" icon={<SlidersHorizontal size={14} />} disabled={busy} onClick={() => ctl.setCodexCatalogDialogOpen(true)}>
      {t('agents.catalog.button')}
    </Button>
  ) : ctl.isDeepSeekHarnessClient ? (
    <Button variant="secondary" icon={<SlidersHorizontal size={14} />} disabled={busy || ctl.configurationWriteBlocked}
      onClick={() => ctl.setHarnessCatalogDialogOpen(true)}>
      {t('agents.harness.button')}
    </Button>
  ) : null;
  return (
    <Card as="section" className="ag-setup-model">
      <div className="ag-section-head">
        <strong>{t(ctl.isDeepSeekHarnessClient ? 'agents.harness.defaultModel' : 'agents.useModel')}</strong>
        {ctl.nativeOauth ? <Chip tone="info" size="sm">{t('agents.nativeOAuth.status')}</Chip> : null}
      </div>
      <div className="ag-model-row">
        <div className="ag-model-picker">
          <AgentModelPicker
            models={ctl.models}
            value={ctl.savedSelectedModel}
            preserveValue
            loading={ctl.modelLoading}
            error={ctl.modelError}
            disabled={busy || !ctl.canConfigureActiveClient}
            onChange={ctl.selectModel}
            onRefresh={ctl.refreshModels}
          />
        </div>
        {catalogButton}
      </div>
      {ctl.modelHint ? <span className="ag-hint" title={ctl.modelHint} aria-live="polite">{ctl.modelHint}</span> : null}
      {ctl.missingModelHint ? <span className="ag-hint" role="status">{ctl.missingModelHint}</span> : null}
      {ctl.isDeepSeekHarnessClient ? <span className="ag-hint">{t('agents.harness.defaultHint')}</span> : null}
    </Card>
  );
}

function CodexConnection({ ctl }: { ctl: AgentsController }) {
  const { t } = useI18n();
  const { oauthConfiguration, connectionHelpOpen, busyAction } = ctl;
  const locked = ctl.busy || ctl.loading || ctl.modelLoading;
  return (
    <Card as="section" className="ag-setup-connection">
      <div className="ag-section-head">
        <strong id="ag-connection-label">{t('agents.modify.authMethod')}</strong>
        {ctl.nativeOauth ? <Chip tone="info" size="sm">{t('agents.nativeOAuth.status')}</Chip> : null}
        <button type="button" className="ag-help-toggle" aria-expanded={connectionHelpOpen} aria-controls="ag-connection-help"
          onClick={() => ctl.updateViewState({ connectionHelpOpen: !connectionHelpOpen })}>
          {t(connectionHelpOpen ? 'agents.modify.authHelpHide' : 'agents.modify.authHelpShow')}
          <ChevronDown size={14} aria-hidden />
        </button>
      </div>
      <div className={`ag-connection-control${locked ? ' is-locked' : ''}`} aria-busy={busyAction === 'oauth-check'}>
        <SegmentedControl<'apikey' | 'oauth'>
          ariaLabel={t('agents.modify.authMethod')}
          value={oauthConfiguration ? 'oauth' : 'apikey'}
          onChange={(value) => { if (!locked) void ctl.changeOauthConfiguration(value === 'oauth'); }}
          options={[
            { value: 'apikey', label: t('agents.modify.authApiKey') },
            { value: 'oauth', label: <>{busyAction === 'oauth-check' ? <span className="ag-spin" aria-hidden /> : null}{t('agents.modify.authOAuth')}</> },
          ]}
        />
      </div>
      {ctl.nativeOauth ? <span className="ag-hint" role="status">{t('agents.nativeOAuth.activeHint')}</span> : null}
      <dl id="ag-connection-help" className="ag-help" hidden={!connectionHelpOpen}>
        <div><dt>{t('agents.modify.authApiKey')}</dt><dd>{t('agents.modify.authApiKeyHint')}</dd></div>
        <div><dt>{t('agents.modify.authOAuth')}</dt><dd>{t('agents.modify.authOAuthHint')}</dd></div>
      </dl>
    </Card>
  );
}

function SaveBar({ ctl }: { ctl: AgentsController }) {
  const { t } = useI18n();
  const { selected, busy, busyAction, activeStatus: status } = ctl;
  const state = ctl.hasPendingChanges ? t('agents.modify.pending')
    : ctl.modelLoading || !status ? t('agents.modify.checking')
    : status.modificationState === 'invalid' ? t('agents.modify.invalidState') : '';
  const applying = ['apply', 'install-pi', 'repair-pi'].includes(busyAction ?? '');
  return (
    <div className="ag-savebar" role="group" aria-label={t('sec.agents.setup.saveBar')}>
      <div className="ag-save-feedback" aria-live="polite">
        {state ? <span className={`ag-save-state${ctl.hasPendingChanges ? ' is-pending' : ''}`}>{state}</span> : null}
        {ctl.modificationDescription ? <span className="ag-hint ag-trunc" title={ctl.modificationDescription}>{ctl.modificationDescription}</span> : null}
        {selected === 'vscode-copilot' && busyAction === 'apply'
          ? <span className="ag-hint" role="status">{t('agents.copilotSetup.pending')}</span> : null}
      </div>
      <div className="ag-save-actions">
        {ctl.canCloseConfiguration ? (
          <Button variant="secondary" loading={busyAction === 'close-config'} disabled={busy || ctl.configurationWriteBlocked}
            title={t(selected === 'codex' ? 'agents.modify.closeHint' : 'agents.clearIntegration.description')}
            onClick={() => void ctl.closeConfigurationChanges()}>
            {t('agents.modify.close')}
          </Button>
        ) : null}
        <Button variant="primary" loading={applying} disabled={busy || !ctl.canEnable || ctl.configurationWriteBlocked}
          onClick={() => void ctl.applySelectedConfiguration()}>
          {ctl.isPiClient && !status?.pluginInstalled ? t('agents.pi.install') : ctl.configurationActionLabel}
        </Button>
      </div>
    </div>
  );
}

export function SetupTab({ ctl }: { ctl: AgentsController }) {
  if (ctl.loading && !ctl.activeStatus) {
    return (
      <div className="ag-setup" aria-busy="true">
        <Card><Skeleton lines={2} /></Card>
        <Card><Skeleton height={32} /></Card>
      </div>
    );
  }
  return (
    <div className="ag-setup">
      <DetectionStrip ctl={ctl} />
      {!ctl.isClaudeModelMappingClient ? <ModelSection ctl={ctl} /> : null}
      {ctl.selected === 'codex' ? <CodexConnection ctl={ctl} /> : null}
      {ctl.selected === 'claude-code' ? <ClaudeCodeMapping ctl={ctl} /> : null}
      {ctl.selected === 'claude-desktop' ? <ClaudeDesktopMapping ctl={ctl} /> : null}
      <SaveBar ctl={ctl} />
    </div>
  );
}
