import { FolderOpen, RefreshCw, Trash2, RotateCcw, FileCog } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { Button, Card, Chip, Masked } from '../../ui';
import { routeHref } from '../../shell/router';
import type { AgentsController } from './useAgentsController';
import './manage.css';

/** Manage tab: program path overrides, template reset, Codex sign-in reset, clear integration, Pi extension. Renders ctl state, calls ctl handlers. */
export function ManageTab({ ctl }: { ctl: AgentsController }) {
  const { t } = useI18n();
  const { selected, activeStatus: status, busy, busyAction } = ctl;
  const pi = ctl.isPiClient;
  const codex = selected === 'codex';
  const dual = ctl.hasIndependentCliAndApp;
  const targets = ctl.activeLaunchTargets;
  // Same conditions the old page computed inline in its JSX.
  const canTemplate = ctl.canEnable && !ctl.nativeOauth;
  const canClearIntegration = !ctl.loading && Boolean(status?.configValid && status.supportedPlatform);
  const piInstalled = Boolean(status?.pluginInstalled);
  const canUpdatePi = ctl.canEnable && !ctl.configurationWriteBlocked && piInstalled;
  const canUninstallPi = ctl.launchEnabled && piInstalled;
  const templateReason = ctl.nativeOauth ? t('sec.agents.manage.reasonOauth') : !ctl.canEnable ? t('sec.agents.manage.reasonSetup') : undefined;
  const clearDisabled = busy || (!codex && !canClearIntegration);

  const pathRow = (desktop: boolean) => {
    const path = ctl.executablePaths[desktop ? `${selected}:app` as const : selected] ?? '';
    const detected = dual ? targets.some((target) => target.id === (desktop ? 'app' : 'cli')) : Boolean(status?.installed);
    const label = dual ? t(desktop ? 'sec.agents.manage.exeApp' : 'sec.agents.manage.exeCli') : t('sec.agents.manage.exe');
    return (
      <Row key={desktop ? 'app' : 'cli'} label={label} hint={t('sec.agents.manage.exeHint')} data-row={desktop ? 'path-app' : 'path'}
        value={<>
          {status ? <Chip tone={detected ? 'ok' : 'warn'} size="sm">{t(detected ? 'sec.agents.manage.detected' : 'sec.agents.manage.notDetected')}</Chip> : null}
          {path ? <Masked value={path} mono className="ag-mg-path" /> : <span className="ec-muted">{t('sec.agents.manage.auto')}</span>}
        </>}
        actions={<>
          <Button size="sm" icon={<FolderOpen size={14} />} disabled={busy} onClick={() => void ctl.chooseExecutablePath(desktop)}>
            {t('sec.agents.manage.choose')}
          </Button>
          {path ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => ctl.clearExecutablePath(desktop)}>{t('sec.agents.manage.clearPath')}</Button> : null}
        </>} />
    );
  };

  return (
    <div className="ag-mg">
      <Card padded={false} className="ag-mg-card">
        {pathRow(false)}
        {dual ? pathRow(true) : null}
        {!pi ? (
          <Row label={t('sec.agents.manage.template')} hint={t('sec.agents.manage.templateHint')} data-row="template"
            actions={<Button size="sm" icon={<FileCog size={14} />} loading={busyAction === 'default'} disabled={busy || !canTemplate}
              title={templateReason} onClick={() => void ctl.openDefaultConfirmation()}>
              {t('agents.modify.default')}
            </Button>} />
        ) : null}
        {codex ? (
          <Row label={t('agents.nativeOAuth.restoreTitle')} hint={t('sec.agents.manage.restoreHint')} data-row="restore"
            value={ctl.nativeOauth ? <Chip tone="info" size="sm">{t('agents.nativeOAuth.status')}</Chip> : null}
            actions={<Button id="agent-clear-integration" size="sm" icon={<RotateCcw size={14} />} loading={busyAction === 'native-oauth'}
              disabled={busy || !canClearIntegration} title={canClearIntegration ? undefined : t('sec.agents.manage.reasonNoConfig')}
              onClick={() => void ctl.clearCodexIntegration()}>
              {t('agents.nativeOAuth.restore')}
            </Button>} />
        ) : null}
        {!pi ? (
          <Row label={t(codex ? 'agents.modify.clear' : 'agents.clearIntegration.button')}
            hint={t(codex ? 'sec.agents.manage.clearHintCodex' : 'sec.agents.manage.clearHint')} data-row="clear"
            actions={<Button size="sm" variant="danger" icon={<Trash2 size={14} />} disabled={clearDisabled}
              title={!codex && !canClearIntegration ? t('sec.agents.manage.reasonNoConfig') : undefined}
              onClick={ctl.openClearConfirmation}>
              {t(codex ? 'agents.modify.clear' : 'agents.clearIntegration.button')}
            </Button>} />
        ) : null}
        {pi ? (
          <Row label={t('sec.agents.manage.pi')} data-row="pi"
            value={piInstalled ? <>
              <Chip tone="ok" size="sm">{t('sec.agents.manage.installed')}</Chip>
              <span className="ec-mono ec-muted">{status?.pluginVersion ?? t('agents.notFetched')}</span>
              {ctl.piPluginUpdateAvailable
                ? <span title={ctl.piPluginUpdateTitle ?? undefined}><Chip tone="warn" size="sm">{t('agents.pi.updateAvailableShort')}</Chip></span> : null}
            </> : <>
              <Chip tone="neutral" size="sm">{t('sec.agents.manage.notInstalled')}</Chip>
              <a className="ag-link" href={routeHref('agents', null, { client: selected })}>{t('sec.agents.manage.installInSetup')} →</a>
            </>}
            actions={piInstalled ? <>
              <Button size="sm" icon={<RefreshCw size={14} />} loading={busyAction === 'update-pi'} disabled={busy || !canUpdatePi}
                title={canUpdatePi ? undefined : t('sec.agents.manage.reasonSetup')} onClick={() => void ctl.updatePiProvider()}>
                {t(busyAction === 'update-pi' ? 'agents.pi.updating' : 'sec.agents.manage.update')}
              </Button>
              <Button size="sm" variant="danger" icon={<Trash2 size={14} />} loading={busyAction === 'uninstall-pi'} disabled={busy || !canUninstallPi}
                title={canUninstallPi ? undefined : t('sec.agents.manage.reasonNoClient')} onClick={() => void ctl.uninstallPiProvider()}>
                {t(busyAction === 'uninstall-pi' ? 'agents.pi.uninstalling' : 'sec.agents.manage.uninstall')}
              </Button>
            </> : null} />
        ) : null}
      </Card>
    </div>
  );
}

/** One management row: label (+ one-line hint) · current value · actions. */
function Row({ label, hint, value, actions, ...rest }: { label: string; hint?: string; value?: ReactNode; actions?: ReactNode; 'data-row'?: string }) {
  return (
    <div className="ag-mg-row" {...rest}>
      <div className="ag-mg-label">
        <strong>{label}</strong>
        {hint ? <span className="ec-muted">{hint}</span> : null}
      </div>
      <div className="ag-mg-value">{value}</div>
      <div className="ag-mg-actions">{actions}</div>
    </div>
  );
}
