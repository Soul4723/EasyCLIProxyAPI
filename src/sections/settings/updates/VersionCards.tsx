// The two version cards on top of Settings → Updates: desktop app and proxy core.
import type { ReactNode } from 'react';
import { ArrowRight, Download, ExternalLink, Info, Monitor, Package, RefreshCw, Server, X } from 'lucide-react';
import { useI18n } from '../../../i18n';
import type { MessageKey } from '../../../i18n/resources';
import type { AppUpdateInfo, AppUpdateTask } from '../../../appUpdate';
import type { CoreStatus } from '../../../coreRuntime';
import type { CoreLatest } from '../../../coreUpdate';
import { Button, Card, Chip, IconButton, Masked, ProgressBar, formatBytes, type ChipTone } from '../../../ui';
import { displayAppVersion, latestCheckText, localizeInstallPhase, taskPercent, type BundledCoreInfo, type CoreInstallTask } from './model';

function VersionFlow({ currentLabel, current, latestLabel, latest, highlight, currentTitle }: {
  currentLabel: string; current: string; latestLabel: string; latest: string; highlight: boolean; currentTitle?: string;
}) {
  return (
    <dl className={`ec-upd-flow${highlight ? ' has-update' : ''}`}>
      <div className="ec-upd-ver">
        <dt>{currentLabel}</dt>
        <dd className={`ec-mono${/\d/.test(current) ? '' : ' is-placeholder'}`} title={currentTitle ?? current}>{current}</dd>
      </div>
      <ArrowRight size={16} className="ec-upd-arrow" aria-hidden="true" />
      <div className="ec-upd-ver is-latest">
        <dt>{latestLabel}</dt>
        <dd className={`ec-mono${/\d/.test(latest) ? '' : ' is-placeholder'}`} title={latest}>{latest}</dd>
      </div>
    </dl>
  );
}

function Progress({ percent, label, detail, indeterminate }: { percent: number | null; label: string; detail: string; indeterminate?: boolean }) {
  return (
    <div className="ec-upd-progress" aria-live="polite">
      <div className={`ec-upd-progress-bar${percent === null && indeterminate ? ' is-indeterminate' : ''}`}>
        <ProgressBar value={percent ?? 100} tone="accent" height={6} label={label} />
      </div>
      <div className="ec-upd-progress-meta">
        <strong>{label}</strong>
        <span className="ec-num">{percent === null ? detail : `${percent.toFixed(1)}%${detail ? ` · ${detail}` : ''}`}</span>
      </div>
    </div>
  );
}

function CardShell({ icon, title, chips, children, actions }: { icon: ReactNode; title: string; chips: ReactNode; children: ReactNode; actions: ReactNode }) {
  return (
    <Card as="section" className="ec-upd-card" aria-label={title}>
      <header className="ec-upd-card-head">
        <span className="ec-upd-card-icon" aria-hidden="true">{icon}</span>
        <h3>{title}</h3>
        <span className="ec-upd-card-chips">{chips}</span>
      </header>
      <div className="ec-upd-card-body">{children}</div>
      <footer className="ec-upd-card-actions">{actions}</footer>
    </Card>
  );
}

export function AppVersionCard({ info, error, checking, task, installedVersion, onCheck, onInstall, onCancel, onOpenRelease }: {
  info: AppUpdateInfo | null; error: string; checking: boolean; task: AppUpdateTask; installedVersion: string;
  onCheck: () => void; onInstall: () => void; onCancel: () => void; onOpenRelease: () => void;
}) {
  const { t } = useI18n();
  const resolved = info?.currentVersion || installedVersion;
  const current = resolved ? displayAppVersion(resolved) : t('common.detecting');
  const latest = info?.latestVersion ? displayAppVersion(info.latestVersion) : '';
  const hasUpdate = Boolean(info?.updateAvailable);
  const canAutoUpdate = Boolean(info?.autoUpdateSupported);

  let status: { tone: ChipTone; label: string };
  if (task.running) status = { tone: 'info', label: t(`appUpdate.phase.${task.phase}` as MessageKey) };
  else if (error) status = { tone: 'danger', label: t('sec.settings.updates.checkFailed') };
  else if (checking) status = { tone: 'info', label: t('sec.settings.updates.checking') };
  else if (!info) status = { tone: 'neutral', label: t('sec.settings.updates.notChecked') };
  else if (hasUpdate) status = { tone: 'accent', label: t('sec.settings.updates.available') };
  else status = { tone: 'ok', label: t('sec.settings.updates.upToDate') };

  const percent = taskPercent({ percent: task.percent, downloaded: task.downloadedBytes, total: task.totalBytes });
  const latestText = latestCheckText(checking, error, info ? (latest || current) : '', t);

  return (
    <CardShell
      icon={<Monitor size={16} />}
      title={t('sec.settings.updates.app.title')}
      chips={<span title={error || status.label}><Chip tone={status.tone}>{status.label}</Chip></span>}
      actions={(
        <>
          <Button size="sm" icon={<RefreshCw size={14} className={checking ? 'ec-upd-spin' : undefined} />} disabled={checking || task.running} onClick={onCheck}>
            {checking ? t('appUpdate.checking') : t('appUpdate.check')}
          </Button>
          {hasUpdate && canAutoUpdate ? (
            <Button size="sm" variant="primary" icon={<Download size={14} />} disabled={task.running} onClick={onInstall}>{t('appUpdate.installNow')}</Button>
          ) : null}
          {task.running && task.cancellable ? (
            <Button size="sm" variant="danger" icon={<X size={14} />} onClick={onCancel}>{t('sec.settings.updates.cancelApp')}</Button>
          ) : null}
          {hasUpdate && !canAutoUpdate ? (
            <Button size="sm" variant="primary" icon={<ExternalLink size={14} />} onClick={onOpenRelease}>{t('appUpdate.openRelease')}</Button>
          ) : (
            <IconButton size="sm" label={t('appUpdate.openRelease')} icon={<ExternalLink size={14} />} onClick={onOpenRelease} />
          )}
        </>
      )}
    >
      <VersionFlow currentLabel={t('sec.settings.updates.current')} current={current} latestLabel={t('sec.settings.updates.latest')} latest={latestText} highlight={hasUpdate} />
      <div className="ec-upd-meta">
        {info ? <Chip size="sm" tone="outline">{canAutoUpdate ? t('sec.settings.updates.autoUpdate') : t('sec.settings.updates.manualUpdate')}</Chip> : null}
        {hasUpdate && info?.downloadSizeBytes ? <Chip size="sm" tone="outline">{t('sec.settings.updates.downloadSize', { size: formatBytes(info.downloadSizeBytes) })}</Chip> : null}
        {info && !canAutoUpdate ? (
          <span className="ec-upd-note" title={info.unsupportedReason ?? undefined}><Info size={13} aria-hidden="true" />{t('appUpdate.manualFallback')}</span>
        ) : null}
      </div>
      {task.running ? (
        <Progress percent={percent} label={t(`appUpdate.phase.${task.phase}` as MessageKey)} detail={task.totalBytes ? `${formatBytes(task.downloadedBytes)} / ${formatBytes(task.totalBytes)}` : ''} indeterminate />
      ) : null}
      {error ? <p className="ec-upd-error" role="alert">{error}</p> : null}
    </CardShell>
  );
}

export function CoreVersionCard({
  status, remote, latest, latestError, checking, hasUpdate, installing, progress, cancelling, bundled, bundledError,
  onCheck, onInstall, onUseBundled, onCancel, onDismiss,
}: {
  status: CoreStatus | null; remote: boolean; latest: CoreLatest | null; latestError: string; checking: boolean; hasUpdate: boolean;
  installing: boolean; progress: CoreInstallTask | null; cancelling: boolean; bundled: BundledCoreInfo | null; bundledError: string;
  onCheck: () => void; onInstall: () => void; onUseBundled: () => void; onCancel: () => void; onDismiss: () => void;
}) {
  const { t } = useI18n();
  const installed = Boolean(status?.installed);
  const current = status?.currentVersion || '';
  const latestVersion = latest?.version ?? '';
  const processBusy = Boolean(status?.starting);
  const working = installing || Boolean(progress?.running);
  const busy = checking || working || processBusy;
  const finished = progress && !progress.running ? progress : null;

  let chip: { tone: ChipTone; label: string } | null;
  if (working) chip = { tone: 'info', label: cancelling ? t('kernel.install.cancelling') : progress?.phase ? localizeInstallPhase(progress.phase, t) : t('kernel.install.inProgress') };
  else if (latestError) chip = { tone: 'danger', label: t('sec.settings.updates.checkFailed') };
  else if (checking) chip = { tone: 'info', label: t('sec.settings.updates.checking') };
  else if (!remote && !installed) chip = { tone: 'warn', label: t('sec.settings.updates.notInstalled') };
  else if (hasUpdate) chip = { tone: 'accent', label: t('sec.settings.updates.available') };
  else if (latestVersion && (current || !remote)) chip = { tone: 'ok', label: t('sec.settings.updates.upToDate') };
  else chip = null;

  const currentText = current || (remote ? t('common.detecting') : t('sec.settings.updates.notInstalled'));
  const latestText = latestCheckText(checking, latestError, latestVersion, t);
  const percent = taskPercent(progress);
  const detail = progress
    ? progress.phase === 'Extracting' ? t('kernel.progress.extracting')
      : progress.total ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}`
        : progress.downloaded > 0 ? formatBytes(progress.downloaded) : t('kernel.progress.waiting')
    : '';

  const installReason = remote ? t('sec.settings.updates.core.remoteReason')
    : processBusy || working ? t('sec.settings.updates.core.busyReason')
      : !latestVersion ? t('sec.settings.updates.core.noLatestReason') : '';
  const bundledReason = remote ? t('sec.settings.updates.core.remoteReason')
    : !bundled ? (bundledError || t('kernel.versions.noBundled'))
      : processBusy || working ? t('sec.settings.updates.core.busyReason') : '';
  const installLabel = latestVersion
    ? (installed && hasUpdate ? t('sec.settings.updates.core.update', { version: latestVersion }) : t('sec.settings.updates.core.install', { version: latestVersion }))
    : t('kernel.versions.installLatestMissing');
  const installDisabled = !status || remote || !latestVersion || busy;

  return (
    <CardShell
      icon={<Server size={16} />}
      title={t('sec.settings.updates.core.title')}
      chips={(
        <>
          <Chip size="sm" tone={remote ? 'info' : 'neutral'}>{remote ? t('sec.settings.updates.core.remote') : t('sec.settings.updates.core.local')}</Chip>
          {!remote && installed ? <Chip size="sm" tone={status?.running ? 'ok' : 'outline'}>{status?.running ? t('sec.settings.updates.core.running') : t('sec.settings.updates.core.stopped')}</Chip> : null}
          {chip ? <span title={latestError || chip.label}><Chip tone={chip.tone}>{chip.label}</Chip></span> : null}
        </>
      )}
      actions={(
        <>
          <Button size="sm" icon={<RefreshCw size={14} className={checking ? 'ec-upd-spin' : undefined} />} disabled={busy} onClick={onCheck}>
            {checking ? t('kernel.update.checking') : t('kernel.versions.check')}
          </Button>
          <span title={installReason || undefined}>
            <Button size="sm" variant={latestVersion && (!installed || hasUpdate) ? 'primary' : 'secondary'} icon={<Download size={14} />} disabled={installDisabled} onClick={onInstall}>
              {installLabel}
            </Button>
          </span>
          {working && progress?.cancellable ? (
            <Button size="sm" variant="danger" icon={<X size={14} />} disabled={cancelling} onClick={onCancel}>
              {cancelling ? t('kernel.install.cancellingShort') : t('kernel.install.cancel')}
            </Button>
          ) : null}
        </>
      )}
    >
      <VersionFlow
        currentLabel={remote ? t('sec.settings.updates.core.remote') : t('sec.settings.updates.current')}
        current={currentText}
        currentTitle={remote ? t('sec.settings.updates.core.remoteVersion') : currentText}
        latestLabel={t('sec.settings.updates.latest')}
        latest={latestText}
        highlight={hasUpdate}
      />
      <div className="ec-upd-meta">
        {remote && status?.remoteOrigin ? <Chip size="sm" tone="outline"><Masked value={status.remoteOrigin} mono /></Chip> : null}
        {!remote ? (
          <span className="ec-upd-bundled" title={bundledReason || undefined}>
            <Package size={13} aria-hidden="true" />
            <span>{t('sec.settings.updates.core.bundled')}</span>
            <span className="ec-mono">{bundled ? bundled.version : t('kernel.versions.notIncluded')}</span>
            <Button size="xs" variant="outline" disabled={Boolean(bundledReason)} onClick={onUseBundled}>{t('sec.settings.updates.core.useBundled')}</Button>
          </span>
        ) : null}
      </div>
      {remote ? <p className="ec-upd-note"><Info size={13} aria-hidden="true" />{t('sec.settings.updates.core.remoteReason')}</p> : null}
      {working && progress ? (
        <Progress percent={percent} label={cancelling ? t('kernel.install.cancelling') : localizeInstallPhase(progress.phase, t)} detail={detail} indeterminate />
      ) : null}
      {finished ? (
        <div className={`ec-upd-result ${finished.phase === 'Installation failed' ? 'is-error' : ''}`} role="status">
          <span>{finished.phase === 'Canceled' ? t('kernel.install.titleCancelled') : finished.phase === 'Installation failed' ? t('kernel.install.titleFailed') : localizeInstallPhase(finished.phase, t)}</span>
          {finished.message ? <span className="ec-upd-result-msg">{finished.message}</span> : null}
          <Button size="xs" variant="ghost" onClick={onDismiss}>{t('sec.settings.updates.core.dismiss')}</Button>
        </div>
      ) : null}
      {latestError ? <p className="ec-upd-error" role="alert">{latestError}</p> : null}
    </CardShell>
  );
}
