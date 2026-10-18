import { Activity, Play, RotateCw, Square } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { CoreStatus } from '../../coreRuntime';
import { Button, Card, CardHeader, Chip, ProgressBar, Skeleton } from '../../ui';
import { routeHref } from '../../shell/router';

export type RuntimeState = 'loading' | 'starting' | 'running' | 'stopped' | 'notInstalled' | 'error' | 'remoteUp' | 'remoteDown' | 'recovering' | 'recoveryFailed';

export type RuntimeCardProps = {
  state: RuntimeState;
  status: CoreStatus | null;
  /** Message from a failed get_core_status. */
  statusError: string;
  remote: boolean;
  /** Management origin host for remote mode. */
  remoteHost: string;
  port: number;
  appVersion: string;
  coreUpdateTo: string | null;
  appUpdateTo: string | null;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onHealth: () => void;
  onRetry: () => void;
};

const TONE: Record<RuntimeState, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  loading: 'neutral', starting: 'warn', running: 'ok', stopped: 'neutral', notInstalled: 'neutral', error: 'danger',
  remoteUp: 'ok', remoteDown: 'danger', recovering: 'warn', recoveryFailed: 'danger',
};

const version = (value: string | null | undefined) => (value ? (value.startsWith('v') ? value : `v${value}`) : '');

function Fact({ label, children, testId }: { label: string; children: React.ReactNode; testId?: string }) {
  return (
    <div className="ov-fact" data-testid={testId}>
      <span className="ov-fact__label">{label}</span>
      <span className="ov-fact__value">{children}</span>
    </div>
  );
}

/** Supervisor recovery: attempt n/limit bar, wait countdown from the payload, exit detail. Limit and delay come from the status, never constants. */
function RecoveryBlock({ recovery }: { recovery: NonNullable<CoreStatus['recovery']> }) {
  const { t } = useI18n();
  const failed = recovery.phase === 'failed';
  const limit = recovery.limit && recovery.limit > 0 ? recovery.limit : null;
  const attemptText = limit ? t('sec.overview.recovery.attempt', { attempt: recovery.attempt, limit }) : t('sec.overview.recovery.attemptNoLimit', { attempt: recovery.attempt });
  const next = recovery.phase === 'restarting' ? t('sec.overview.recovery.restarting')
    : recovery.phase === 'waiting' ? t('sec.overview.recovery.next', { seconds: recovery.delaySeconds }) : '';
  return (
    <div className="ov-recovery" data-testid="ov-recovery" data-phase={recovery.phase} role={failed ? 'alert' : 'status'}>
      <div className="ov-recovery__line">
        <strong>{failed ? t('kernel.recovery.failed') : attemptText}</strong>
        {!failed && next && <span className="ec-muted">{next}</span>}
        {failed && limit && <span className="ec-muted">{attemptText}</span>}
      </div>
      {limit && <ProgressBar value={Math.min(100, (recovery.attempt / limit) * 100)} tone={failed ? 'danger' : 'warn'} label={t('sec.overview.recovery.progress')} />}
      {failed && <p className="ov-recovery__hint">{t('kernel.recovery.failedHint')}</p>}
      {recovery.detail && (
        <details className="ov-recovery__detail">
          <summary>{t('kernel.recovery.details')}</summary>
          <p className="ov-error">{recovery.detail}</p>
        </details>
      )}
    </div>
  );
}

/** Home of the core runtime: status, versions (+ update links), PID/port or remote host, process controls, health check. */
export function RuntimeCard(props: RuntimeCardProps) {
  const { t } = useI18n();
  const { state, status, remote, busy } = props;
  const running = state === 'running';
  const coreVersion = version(status?.currentVersion) || (state === 'notInstalled' ? '—' : t('sec.overview.unknown'));
  const ready = Boolean(status?.ready);
  const recovery = !remote && (state === 'recovering' || state === 'recoveryFailed') ? status?.recovery ?? null : null;
  const recovering = state === 'recovering';
  const chipLabel = recovering && recovery?.limit ? `${t('sec.overview.state.recovering')} · ${recovery.attempt}/${recovery.limit}` : t(`sec.overview.state.${state}`);
  return (
    <Card as="section" className="ov-runtime" aria-labelledby="ov-runtime-title" data-runtime-state={state}>
      <CardHeader
        title={<span id="ov-runtime-title">{t('sec.overview.runtime')}</span>}
        actions={
          <>
            <Chip tone={TONE[state]} icon={<span className={`ov-dot ov-dot--${TONE[state]}`} />}>
              {chipLabel}
            </Chip>
            <a className="ov-link" href={routeHref('settings', 'connection')}>{t('sec.overview.connectionSettings')} →</a>
          </>
        }
      />
      {state === 'loading' ? (
        <div className="ov-facts" aria-busy="true"><Skeleton height={34} /><Skeleton height={34} /><Skeleton height={34} /></div>
      ) : (
        <div className="ov-facts">
          <Fact label={t('sec.overview.coreVersion')} testId="ov-core-version">
            <span className="ec-mono">{coreVersion}</span>
            {props.coreUpdateTo && (
              <a className="ov-update" href={routeHref('settings', 'updates')} title={t('sec.overview.updateAvailable', { version: version(props.coreUpdateTo) })}>
                <Chip tone="info" size="sm">{`↑ ${version(props.coreUpdateTo)}`}</Chip>
              </a>
            )}
          </Fact>
          <Fact label={t('sec.overview.appVersion')} testId="ov-app-version">
            <span className="ec-mono">{props.appVersion || '—'}</span>
            {props.appUpdateTo && (
              <a className="ov-update" href={routeHref('settings', 'updates')} title={t('sec.overview.updateAvailable', { version: version(props.appUpdateTo) })}>
                <Chip tone="info" size="sm">{`↑ ${version(props.appUpdateTo)}`}</Chip>
              </a>
            )}
          </Fact>
          {remote ? (
            <Fact label={t('sec.overview.remoteHost')} testId="ov-remote-host"><span className="ec-mono ec-trunc" title={props.remoteHost}>{props.remoteHost || '—'}</span></Fact>
          ) : (
            <>
              <Fact label={t('sec.overview.port')} testId="ov-port"><span className="ec-mono">{props.port}</span></Fact>
              <Fact label={t('sec.overview.pid')} testId="ov-pid"><span className="ec-mono">{status?.processId ?? '—'}</span></Fact>
            </>
          )}
        </div>
      )}
      {recovery && <RecoveryBlock recovery={recovery} />}
      {(props.statusError || (remote && !ready && status?.message)) && (
        <p className="ov-error" role="alert" title={props.statusError || status?.message}>{props.statusError ? t('sec.overview.statusFailed') : status?.message}</p>
      )}
      <div className="ov-runtime__actions">
        {!remote && (
          <>
            {running || recovering ? (
              <Button variant="danger" size="sm" icon={<Square size={13} />} disabled={busy} onClick={props.onStop}>{t(recovering ? 'sec.overview.recovery.stop' : 'sec.overview.stop')}</Button>
            ) : state === 'error' ? (
              <Button variant="primary" size="sm" icon={<RotateCw size={13} />} loading={busy} onClick={props.onRetry}>{t('sec.overview.retry')}</Button>
            ) : (
              <Button
                variant={state === 'notInstalled' ? 'secondary' : 'primary'} size="sm" icon={<Play size={13} />} loading={busy || state === 'starting'}
                disabled={state === 'notInstalled' || state === 'loading'}
                title={state === 'notInstalled' ? t('sec.overview.notInstalledReason') : undefined}
                onClick={props.onStart}
              >{t('sec.overview.start')}</Button>
            )}
            <Button variant="secondary" size="sm" icon={<RotateCw size={13} />} disabled={!running || busy} title={!running ? t(state === 'notInstalled' ? 'sec.overview.notInstalledReason' : 'sec.overview.notRunningReason') : undefined} onClick={props.onRestart}>{t('sec.overview.restart')}</Button>
          </>
        )}
        {state === 'notInstalled' && !remote && (
          <a className="ov-link ov-link--primary" href={routeHref('settings', 'updates')}>{t('sec.overview.install')} →</a>
        )}
        <span className="ov-spacer" />
        <Button variant="outline" size="sm" icon={<Activity size={13} />} disabled={!ready} title={!ready ? t('sec.overview.healthOffline') : undefined} onClick={props.onHealth}>
          {t('sec.overview.healthCheck')}
        </Button>
      </div>
    </Card>
  );
}
