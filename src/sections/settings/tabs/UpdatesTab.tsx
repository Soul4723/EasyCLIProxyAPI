// Settings → Updates: app + core version cards, download sources (incl. custom HTTPS mirrors), release notes.
// Behaviour comes from the old Version page: same commands, task events and visit-triggered checks.
import { useEffect, useRef, useState } from 'react';
import { getVersion } from '../../../services/platform';
import { invoke } from '../../../services/platform';
import { useI18n } from '../../../i18n';
import { useCoreRuntime } from '../../../coreRuntime';
import { useCoreUpdate } from '../../../coreUpdate';
import { useAppUpdate } from '../../../appUpdate';
import { FloatingNotice, useAppNotice } from '../../../appNotice';
import { createVersionManagementVisitTracker } from '../../../services/versionManagementVisits';
import { ConfirmDialog } from '../../../ui';
import { APP_RELEASE_URL } from '../updates/model';
import { AppVersionCard, CoreVersionCard } from '../updates/VersionCards';
import { DownloadSources } from '../updates/DownloadSources';
import { ReleaseNotesPanel } from '../updates/ReleaseNotesPanel';
import { useCoreInstall } from '../updates/useCoreInstall';
import { useVersionSource } from '../updates/useVersionSource';
import './UpdatesTab.css';

const recordVersionManagementVisit = createVersionManagementVisitTracker();

export function UpdatesTab() {
  const { t } = useI18n();
  const feedback = useAppNotice();
  const { showNotice } = feedback;
  const { status: coreStatus, refreshStatus } = useCoreRuntime();
  const app = useAppUpdate();
  const core = useCoreUpdate();
  const [installedAppVersion, setInstalledAppVersion] = useState('');
  const [confirmCoreOpen, setConfirmCoreOpen] = useState(false);
  const visitRef = useRef({});

  const install = useCoreInstall(showNotice);
  const sources = useVersionSource(showNotice, core.reset, refreshStatus);

  // Same trigger as the old page: first visit in a session checks both the app and the core.
  useEffect(() => {
    if (!recordVersionManagementVisit(visitRef.current)) return;
    if (!app.checking && !app.task.running) void app.check();
    if (!core.checking) void core.check();
  }, [app.check, app.checking, app.task.running, core.check, core.checking]);

  useEffect(() => {
    let disposed = false;
    void getVersion().then((version) => { if (!disposed) setInstalledAppVersion(version); }).catch(() => undefined);
    return () => { disposed = true; };
  }, []);

  const remote = coreStatus?.connectionMode === 'remote';
  const latestVersion = core.latest?.version ?? '';

  const openAppRelease = async (url = app.info?.releaseUrl || APP_RELEASE_URL) => {
    try {
      await invoke('open_external_url', { url });
    } catch (error) {
      showNotice({ key: 'kernel.error.openUpdate', variables: { error: String(error) } }, 'error');
    }
  };

  return (
    <div className="ec-upd-page" data-remote={remote ? 'true' : undefined}>
      <div className="ec-upd-cards">
        <AppVersionCard
          info={app.info}
          error={app.error}
          checking={app.checking}
          task={app.task}
          installedVersion={installedAppVersion}
          onCheck={() => void app.check()}
          onInstall={app.requestInstall}
          onCancel={() => void app.cancel()}
          onOpenRelease={() => void openAppRelease()}
        />
        <CoreVersionCard
          status={coreStatus}
          remote={Boolean(remote)}
          latest={core.latest}
          latestError={core.error}
          checking={core.checking}
          hasUpdate={core.hasUpdate}
          installing={install.installing}
          progress={install.progress}
          cancelling={install.cancelling}
          bundled={install.bundledCore}
          bundledError={install.bundledCoreError}
          onCheck={() => void core.check(true)}
          onInstall={() => setConfirmCoreOpen(true)}
          onUseBundled={() => void install.install({ kind: 'bundled' })}
          onCancel={() => void install.cancel()}
          onDismiss={install.dismiss}
        />
      </div>

      <DownloadSources
        settings={sources.settings}
        saving={sources.saving}
        locked={app.task.running || install.installing}
        error={sources.error}
        addError={sources.addError}
        onSelect={(source) => void sources.select(source)}
        onAdd={sources.addMirror}
        onRemove={(url, wasSelected) => void sources.removeMirror(url, wasSelected)}
        onClearAddError={sources.clearAddError}
      />

      <ReleaseNotesPanel
        key={app.info?.latestVersion ?? 'pending'}
        info={app.info}
        checking={app.checking}
        failed={Boolean(app.error)}
        onOpenUrl={openAppRelease}
      />

      <ConfirmDialog
        open={confirmCoreOpen}
        title={t('kernel.versions.confirmUpdateTitle')}
        message={t('kernel.versions.stopAndConfirmDescription', { version: latestVersion })}
        confirmLabel={t('kernel.versions.installLatest')}
        onCancel={() => setConfirmCoreOpen(false)}
        onConfirm={() => {
          setConfirmCoreOpen(false);
          void install.install({ kind: 'release', version: latestVersion });
        }}
      />
      <FloatingNotice key={feedback.revision} notice={feedback.notice} onDismiss={feedback.clearNotice} />
    </div>
  );
}
