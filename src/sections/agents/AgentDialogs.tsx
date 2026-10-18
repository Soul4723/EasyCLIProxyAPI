import type { ReactNode } from 'react';
import { Check, FolderOpen, TriangleAlert } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { DeepSeekHarnessLaunchMode } from '../../services/deepSeekHarnessLaunch';
import { Button, ConfirmDialog, Dialog, Masked } from '../../ui';
import { CodexCatalogDialog, HarnessCatalogDialog } from './CatalogDialogs';
import { InlineNotice } from './InlineNotice';
import type { AgentsController } from './useAgentsController';
import './manage.css';

const harnessModes: { mode: DeepSeekHarnessLaunchMode; key: string }[] = [
  { mode: 'web', key: 'web' },
  { mode: 'headless', key: 'headless' },
  { mode: 'acp', key: 'acp' },
  { mode: 'sdk', key: 'sdk' },
  { mode: 'sdk-minimal', key: 'sdkMinimal' },
  { mode: 'custom', key: 'custom' },
];

/** Every modal of the client detail page, all driven by `ctl`: template/clear confirms, OAuth-required, CLI restart, launch directory (+ DeepSeek Harness options) and the model-catalog dialogs. */
export function AgentDialogs({ ctl }: { ctl: AgentsController }) {
  const { t } = useI18n();
  const { selected, activeDefinition: definition, busy, busyAction } = ctl;
  const codex = selected === 'codex';
  const warn = <TriangleAlert size={16} aria-hidden className="ag-dlg-icon" />;

  const oauthAction = ctl.oauthLoginRequiredAction;
  const oauthDescription: ReactNode = oauthAction === 'enable' ? (
    <>
      {t('agents.oauthLoginRequired.enableDescription')}
      <strong>{t('sec.agents.detail.tab.manage')}</strong>
      {t('agents.oauthLoginRequired.enableManagementConnector')}
      <strong>{t('agents.oauthLoginRequired.enableClearConfiguration')}</strong>
      {t('agents.oauthLoginRequired.enableDescriptionSuffix')}
    </>
  ) : oauthAction ? t(`agents.oauthLoginRequired.${oauthAction}Description`) : '';

  return (
    <>
      <ConfirmDialog open={ctl.defaultConfirmOpen && ctl.templatePreview !== null} danger busy={busyAction === 'default'}
        title={<span className="ag-dlg-title">{warn}{t('agents.default.title')}</span>}
        message={<div className="ag-dlg">
          <p>{t('agents.default.description', { name: definition.name })}</p>
          {ctl.templatePreview ? (
            <ul className="ag-dlg-files">
              {ctl.templatePreview.files.map((file) => <li key={file}><Masked value={file} mono /></li>)}
            </ul>
          ) : null}
          {ctl.defaultError ? <InlineNotice tone="error" message={ctl.defaultError} /> : null}
        </div>}
        confirmLabel={t('agents.default.confirm')} onConfirm={() => void ctl.resetConfigurationToDefault()}
        onCancel={ctl.closeDefaultConfirmation} />

      <ConfirmDialog open={ctl.clearConfirmOpen} danger busy={busyAction === 'clear'}
        title={<span className="ag-dlg-title">{warn}{codex ? t('agents.clear.title') : t('agents.clearIntegration.title', { name: definition.name })}</span>}
        message={<div className="ag-dlg">
          <p>{t(codex ? 'agents.clear.description' : 'agents.clearIntegration.description')}</p>
          {ctl.clearError ? <InlineNotice tone="error" message={ctl.clearError} /> : null}
        </div>}
        confirmLabel={t(codex ? 'agents.clear.confirm' : 'agents.clearIntegration.confirm')}
        onConfirm={() => void ctl.clearConfiguration()} onCancel={ctl.closeClearConfirmation} />

      <Dialog open={oauthAction !== null} size="sm" onClose={() => ctl.setOauthLoginRequiredAction(null)}
        title={<span className="ag-dlg-title">{warn}{t('agents.oauthLoginRequired.title')}</span>}
        footer={<>
          <Button variant={oauthAction === 'launch' ? 'primary' : 'secondary'} onClick={() => ctl.setOauthLoginRequiredAction(null)}>
            {t('agents.oauthLoginRequired.confirm')}
          </Button>
          {oauthAction !== 'launch'
            ? <Button variant="primary" onClick={ctl.openClearIntegrationGuide}>{t('agents.oauthLoginRequired.openManagement')}</Button> : null}
        </>}>
        <div className="ag-dlg"><p>{oauthDescription}</p></div>
      </Dialog>

      <ConfirmDialog open={ctl.cliRestartConfirm} danger
        title={t('agents.launch.restartCliTitle')}
        message={<div className="ag-dlg">
          <p>{t('agents.launch.restartCliMessage')}</p>
          <p className="ag-dlg-warn">{t('agents.launch.restartCliWarning')}</p>
        </div>}
        confirmLabel={t('agents.launch.restartCliConfirm')}
        onConfirm={() => ctl.answerCliRestartConfirmation(true)} onCancel={() => ctl.answerCliRestartConfirmation(false)} />

      <LaunchDirectoryDialog ctl={ctl} busy={busy} />

      {ctl.codexCatalogDialogOpen
        ? <CodexCatalogDialog onClose={() => ctl.setCodexCatalogDialogOpen(false)} onSaved={() => ctl.loadModels('codex', ctl.savedSelectedModel)} /> : null}
      {ctl.harnessCatalogDialogOpen
        ? <HarnessCatalogDialog onClose={() => ctl.setHarnessCatalogDialogOpen(false)}
            onSaved={async () => { await ctl.loadModels('deepseek-harness', ctl.selectedModelOption?.name ?? ''); await ctl.loadStatuses(true); }} /> : null}
    </>
  );
}

/** Working-directory picker shown before a launch; for DeepSeek Harness it also carries the runtime-mode options form. */
function LaunchDirectoryDialog({ ctl, busy }: { ctl: AgentsController; busy: boolean }) {
  const { t } = useI18n();
  const { activeDefinition: definition, busyAction, isDeepSeekHarnessClient: harness } = ctl;
  const draft = ctl.deepSeekHarnessLaunchDraft;
  const update = ctl.updateDeepSeekHarnessLaunchDraft;
  const close = () => { ctl.setLaunchDirectoryDialogOpen(false); ctl.setLaunchDirectoryTarget(null); };
  const launching = busyAction === 'launch' || busyAction === 'launch-cli';
  return (
    <Dialog open={ctl.launchDirectoryDialogOpen} size="md" dismissible={!busy} onClose={close}
      title={harness ? t('agents.deepseekLaunch.dialogTitle') : t('agents.launchDirectory.dialogTitle', { client: definition.name })}
      footer={<>
        <Button variant="secondary" disabled={busy} onClick={close}>{t('common.cancel')}</Button>
        <Button variant="primary" loading={launching} data-action="launch-confirm"
          disabled={busy || !ctl.launchDirectory.trim() || !ctl.launchDirectoryTarget} onClick={() => void ctl.launchFromDirectoryDialog()}>
          {harness ? t('agents.deepseekLaunch.launch', { mode: ctl.deepSeekHarnessLaunchModeLabel })
            : t('agents.launchDirectory.launch', { client: definition.name })}
        </Button>
      </>}>
      <div className="ag-dlg ag-dlg-launch">
        {harness ? (
          <div className="ag-dlg-options">
            <label className="ag-field">
              <span>{t('agents.deepseekLaunch.mode.label')}</span>
              <select value={draft.mode} disabled={busy} onChange={(event) => update({ mode: event.currentTarget.value as DeepSeekHarnessLaunchMode })}>
                {harnessModes.map(({ mode, key }) => <option key={mode} value={mode}>{t(`agents.deepseekLaunch.mode.${key}` as 'agents.deepseekLaunch.mode.web')}</option>)}
              </select>
              <small className="ec-muted">{ctl.deepSeekHarnessLaunchModeDescription}</small>
            </label>
            {draft.mode === 'web' ? (
              <>
                <div className="ag-field-row">
                  <label className="ag-field">
                    <span>{t('agents.deepseekLaunch.web.host')}</span>
                    <input type="text" value={draft.webHost} disabled={busy} placeholder={t('agents.deepseekLaunch.web.hostPlaceholder')}
                      onChange={(event) => update({ webHost: event.currentTarget.value })} />
                  </label>
                  <label className="ag-field">
                    <span>{t('agents.deepseekLaunch.web.port')}</span>
                    <input type="text" inputMode="numeric" value={draft.webPort} disabled={busy} placeholder={t('agents.deepseekLaunch.web.portPlaceholder')}
                      onChange={(event) => update({ webPort: event.currentTarget.value })} />
                  </label>
                </div>
                <label className="ag-check">
                  <input type="checkbox" checked={draft.openBrowser} disabled={busy} onChange={(event) => update({ openBrowser: event.currentTarget.checked })} />
                  <span>
                    <strong>{t('agents.deepseekLaunch.web.openBrowser')}</strong>
                    <small className="ec-muted">{t('agents.deepseekLaunch.web.openBrowserDescription')}</small>
                  </span>
                </label>
                <label className="ag-field">
                  <span>{t('agents.deepseekLaunch.web.trustedHosts')}</span>
                  <textarea value={draft.trustedHosts} disabled={busy} placeholder={t('agents.deepseekLaunch.web.trustedHostsPlaceholder')}
                    onChange={(event) => update({ trustedHosts: event.currentTarget.value })} />
                </label>
              </>
            ) : null}
            {draft.mode === 'headless' ? (
              <label className="ag-field">
                <span>{t('agents.deepseekLaunch.headless.task')}</span>
                <input type="text" value={draft.task} disabled={busy} placeholder={t('agents.deepseekLaunch.headless.taskPlaceholder')}
                  onChange={(event) => update({ task: event.currentTarget.value })} />
              </label>
            ) : null}
            {draft.mode === 'custom' ? (
              <label className="ag-field">
                <span>{t('agents.deepseekLaunch.custom.profile')}</span>
                <input type="text" value={draft.profile} disabled={busy} placeholder={t('agents.deepseekLaunch.custom.profilePlaceholder')}
                  onChange={(event) => update({ profile: event.currentTarget.value })} />
              </label>
            ) : null}
            <label className="ag-field">
              <span>{t('agents.deepseekLaunch.patches')}</span>
              <textarea value={draft.patches} disabled={busy} placeholder={t('agents.deepseekLaunch.patchesPlaceholder')}
                onChange={(event) => update({ patches: event.currentTarget.value })} />
            </label>
          </div>
        ) : null}
        <div className="ag-field">
          <span>{t('agents.launchDirectory.workingDirectory')}</span>
          <button type="button" className="ag-dir-pick" autoFocus disabled={busy} onClick={() => void ctl.chooseLaunchDirectory()}>
            <FolderOpen size={14} aria-hidden />
            {ctl.launchDirectory
              ? <Masked value={ctl.launchDirectory} mono className="ag-dir-path" />
              : <span className="ec-muted ag-dir-path">{t('agents.launchDirectory.noDirectory')}</span>}
            <b>{t(busyAction === 'directory' ? 'agents.launchDirectory.choosing' : ctl.launchDirectory ? 'agents.launchDirectory.browse' : 'agents.launchDirectory.chooseDirectory')}</b>
          </button>
        </div>
        {ctl.activeLaunchDirectoryHistory.length ? (
          <div className="ag-field">
            <span>{t('agents.launchDirectory.historyTitle')}</span>
            <div className="ag-dir-history">
              {ctl.activeLaunchDirectoryHistory.map((directory) => {
                const active = directory === ctl.launchDirectory;
                return (
                  <button type="button" key={directory} className={`ag-dir-chip${active ? ' ag-dir-chip--on' : ''}`} aria-pressed={active} disabled={busy}
                    onClick={() => { ctl.setLaunchDirectory(directory); ctl.setLaunchDirectoryError(''); }}>
                    {active ? <Check size={12} aria-hidden /> : null}
                    <Masked value={directory} mono />
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        {ctl.launchDirectoryError ? <InlineNotice tone="error" message={ctl.launchDirectoryError} onDismiss={() => ctl.setLaunchDirectoryError('')} /> : null}
      </div>
    </Dialog>
  );
}
