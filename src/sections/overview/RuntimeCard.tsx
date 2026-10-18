import { Activity, Play, RotateCw, Square } from 'lucide-react';
import { useI18n } from '../../i18n';
import type { CoreStatus } from '../../coreRuntime';
import { Button, Card, CardHeader, Chip, Skeleton } from '../../ui';
import { routeHref } from '../../shell/router';

export type RuntimeState = 'loading' | 'starting' | 'running' | 'stopped' | 'notInstalled' | 'error' | 'remoteUp' | 'remoteDown';

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
  remoteUp: 'ok', remoteDown: 'danger',
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

/** Home of the core runtime: status, versions (+ update links), PID/port or remote host, process controls, health check. */
export function RuntimeCard(props: RuntimeCardProps) {
  const { t } = useI18n();
  const { state, status, remote, busy } = props;
  const running = state === 'running';
  const coreVersion = version(status?.currentVersion) || (state === 'notInstalled' ? '—' : t('sec.overview.unknown'));
  const ready = Boolean(status?.ready);
  return (
    <Card as="section" className="ov-runtime" aria-labelledby="ov-runtime-title" data-runtime-state={state}>
      <CardHeader
        title={<span id="ov-runtime-title">{t('sec.overview.runtime')}</span>}
        actions={
          <>
            <Chip tone={TONE[state]} icon={<span className={`ov-dot ov-dot--${TONE[state]}`} />}>
              {t(`sec.overview.state.${state}`)}
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
      {(props.statusError || (remote && !ready && status?.message)) && (
        <p className="ov-error" role="alert" title={props.statusError || status?.message}>{props.statusError ? t('sec.overview.statusFailed') : status?.message}</p>
      )}
      <div className="ov-runtime__actions">
        {!remote && (
          <>
            {running ? (
              <Button variant="danger" size="sm" icon={<Square size={13} />} disabled={busy} onClick={props.onStop}>{t('sec.overview.stop')}</Button>
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
