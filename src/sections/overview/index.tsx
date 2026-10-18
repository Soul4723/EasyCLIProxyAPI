import { refreshQuotaBatch } from '../../services/quotaBatch';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getVersion } from '../../services/platform';
import { invoke } from '../../services/documentTarget';
import { RefreshCw } from 'lucide-react';
import { useAppUpdate } from '../../appUpdate';
import { useCoreRuntime, type CoreStatus } from '../../coreRuntime';
import { useCoreUpdate } from '../../coreUpdate';
import { useI18n } from '../../i18n';
import { clientApiProfiles } from '../../services/clientAccess';
import { useQuotaCache } from '../../services/quotaCache';
import { PageHeader } from '../../shell/PageHeader';
import type { SectionPageProps } from '../../shell/types';
import { Button, useNow } from '../../ui';
import { useOverviewSnapshot, useRuntimeDetails } from './data';
import { buildComingUp, buildNeedsAction, summarizeProviders } from './model';
import { ConnectCard } from './ConnectCard';
import { HealthDialog } from './HealthDialog';
import { ComingUpCard, NeedsActionCard } from './Lists';
import { RuntimeCard, type RuntimeState } from './RuntimeCard';
import { Onboarding, ProviderRow, UsageTile } from './Summary';
import './overview.css';

type CoreProcessCommand = 'start_core_process' | 'stop_core_process' | 'restart_core_process';

const hostOf = (origin: string | null | undefined) => {
  if (!origin) return '';
  try { return new URL(origin).host; } catch { return origin; }
};
const displayVersion = (value: string) => (value && !value.startsWith('v') ? `v${value}` : value);

export function OverviewSection(_props: SectionPageProps) {
  const { t } = useI18n();
  const { status, statusError, refreshStatus, publishStatus } = useCoreRuntime();
  const { info: appUpdate } = useAppUpdate();
  const { latest, hasUpdate: coreHasUpdate } = useCoreUpdate();
  const details = useRuntimeDetails();
  const now = useNow(30_000);

  const remote = details.connection?.mode === 'remote' || status?.connectionMode === 'remote';
  const coreReady = Boolean(status?.ready);
  const healthContext = [details.connection?.mode, details.connection?.managementOrigin, details.port, details.tls, status?.processId, details.configRevision].join(':');
  const { snapshot, loading, refresh } = useOverviewSnapshot(coreReady);
  const quotas = useQuotaCache();

  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [healthOpen, setHealthOpen] = useState(false);
  const [refreshingQuota, setRefreshingQuota] = useState(false);
  const [installedApp, setInstalledApp] = useState('');
  useEffect(() => { void getVersion().then(setInstalledApp).catch(() => undefined); }, []);

  const runCommand = async (command: CoreProcessCommand) => {
    if (remote) return;
    setBusy(true);
    setActionError('');
    try {
      publishStatus(await invoke<CoreStatus>(command));
    } catch (error) {
      setActionError(String(error));
      await refreshStatus();
    } finally {
      setBusy(false);
    }
  };

  const refreshQuota = useCallback(async (onlyIdle = false) => {
    setRefreshingQuota(true);
    try { await refreshQuotaBatch(snapshot.files, onlyIdle); }
    finally { setRefreshingQuota(false); }
  }, [snapshot.files]);
  useEffect(() => {
    if (coreReady && snapshot.files.length) void refreshQuota(true);
  }, [coreReady, snapshot.files, refreshQuota]);

  const needs = useMemo(
    () => buildNeedsAction(snapshot.files, quotas, snapshot.schedules, now, snapshot.filesReceivedAt || now),
    [snapshot.files, quotas, snapshot.schedules, snapshot.filesReceivedAt, now],
  );
  const coming = useMemo(
    () => buildComingUp(snapshot.files, quotas, snapshot.schedules, now, snapshot.filesReceivedAt || now),
    [snapshot.files, quotas, snapshot.schedules, snapshot.filesReceivedAt, now],
  );
  const providers = useMemo(() => summarizeProviders(snapshot.files, quotas), [snapshot.files, quotas]);

  const state: RuntimeState = remote
    ? (coreReady ? 'remoteUp' : status ? 'remoteDown' : statusError ? 'error' : 'loading')
    : statusError ? 'error'
      : !status ? 'loading'
        : status.recovery?.phase === 'waiting' || status.recovery?.phase === 'restarting' ? 'recovering'
          : status.recovery?.phase === 'failed' ? 'recoveryFailed'
        : status.starting || busy ? 'starting'
          : status.running ? 'running'
            : status.installed ? 'stopped' : 'notInstalled';

  const profiles = useMemo(() => {
    const local = clientApiProfiles(details.port, details.tls, details.host);
    const origin = details.connection?.clientOrigin?.replace(/\/$/, '');
    if (!remote) return local;
    return origin ? local.map((profile) => ({ ...profile, baseUrl: origin + (profile.id === 'openai' ? '/v1' : '') })) : [];
  }, [details.port, details.tls, details.host, details.connection?.clientOrigin, remote]);

  const credentialsKnown = coreReady && !snapshot.credentialsError && !loading;
  const empty = credentialsKnown && snapshot.files.length === 0 && snapshot.providerKeys === 0;
  const firstRun = empty || (!remote && state === 'notInstalled');
  const appVersion = displayVersion(appUpdate?.currentVersion || installedApp);

  return (
    <>
      <PageHeader
        title={t('sec.overview.title')}
        actions={<Button size="sm" variant="outline" icon={<RefreshCw size={13} />} loading={loading && coreReady} onClick={() => { refresh(); void refreshStatus(); }}>{t('sec.overview.refresh')}</Button>}
      />
      <div className="ec-page-body ec-sec-overview" data-testid="overview-page">
        {details.error && <p role="alert">{details.error}</p>}
        {snapshot.blockErrors.map((error, index) => <p role="alert" key={index}>{error}</p>)}
        {firstRun && (
          <Onboarding remote={Boolean(remote)} coreReady={coreReady} coreInstalled={Boolean(status?.installed)} starting={state === 'starting'} hasCredentials={snapshot.files.length > 0} onStart={() => void runCommand('start_core_process')} />
        )}
        {!firstRun && coreReady && (
          <div className="ov-top">
            <ProviderRow providers={providers} loading={loading && snapshot.files.length === 0} refreshing={refreshingQuota} onRefresh={() => void refreshQuota(false)} />
            <UsageTile usage={snapshot.usage} series={snapshot.series} loading={loading && !snapshot.usage && !snapshot.usageError} error={snapshot.usageError} />
          </div>
        )}
        {!firstRun && !coreReady && state !== 'recovering' && state !== 'recoveryFailed' && <p className="ov-offline" data-testid="ov-offline">{t(state === 'error' ? 'sec.overview.offlineError' : remote ? 'sec.overview.offlineRemote' : 'sec.overview.offline')}</p>}
        {!firstRun && coreReady && (
          <div className="ov-grid ov-grid--lists">
            <NeedsActionCard rows={needs} loading={loading && coreReady && snapshot.files.length === 0 && !snapshot.credentialsError} error={coreReady ? snapshot.credentialsError : ''} />
            <ComingUpCard events={coming} loading={loading && coreReady && snapshot.files.length === 0 && !snapshot.credentialsError} nowMs={now} />
          </div>
        )}
        <div className="ov-grid ov-grid--runtime">
          <RuntimeCard
            state={state} status={status} statusError={actionError || statusError} remote={Boolean(remote)}
            remoteHost={hostOf(details.connection?.managementOrigin || status?.remoteOrigin)} port={details.port}
            appVersion={appVersion} busy={busy}
            coreUpdateTo={coreHasUpdate && latest?.version ? latest.version : null}
            appUpdateTo={appUpdate?.updateAvailable ? appUpdate.latestVersion : null}
            onStart={() => void runCommand('start_core_process')} onStop={() => void runCommand('stop_core_process')}
            onRestart={() => void runCommand('restart_core_process')} onRetry={() => { setActionError(''); void refreshStatus(); }}
            onHealth={() => setHealthOpen(true)}
          />
          <ConnectCard profiles={profiles} clientKey={details.clientKey} keyError={details.clientKeyError} connectable={coreReady} />
        </div>
        {!firstRun && !coreReady && (
          <UsageTile usage={snapshot.usage} series={snapshot.series} loading={false} error={snapshot.usageError} />
        )}
      </div>
      <HealthDialog open={healthOpen} onClose={() => setHealthOpen(false)} models={snapshot.models} ready={coreReady} contextKey={healthContext} />
    </>
  );
}
