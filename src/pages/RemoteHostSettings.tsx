import { useEffect, useState } from 'react';
import { Power, RadioTower } from 'lucide-react';
import { Notice } from '../components/Notice';
import { ScopeLabel } from '../components/ScopeLabel';
import { Switch } from '../components/Switch';
import { useCoreRuntime } from '../coreRuntime';
import { useI18n } from '../i18n';
import { getRemoteStartCoreOnLaunch, setRemoteStartCoreOnLaunch } from '../services/hostControl';

// Remote mode: settings of EasyCLIProxyAPI on the core's computer, changed there at once through remote host
// control. Its Start Core on Launch never touches this computer's own setting, which stays for Local mode.
export function RemoteHostSettings({ hidden }: { hidden?: boolean }) {
  const { t } = useI18n();
  const { status } = useCoreRuntime();
  const hostControl = status?.hostControl ?? null;
  const reachable = hostControl?.reachable === true;
  const [value, setValue] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!reachable) { setValue(null); return; }
    let disposed = false;
    void getRemoteStartCoreOnLaunch()
      .then((next) => { if (!disposed) setValue(next); })
      .catch((cause) => { if (!disposed) { setValue(null); setError(String(cause)); } });
    return () => { disposed = true; };
  }, [reachable]);

  const reason = !hostControl ? t('connection.hostApp.required') : !reachable ? t('connection.hostControlUnreachable') : null;
  return <section id="config-remote-host" tabIndex={-1} hidden={hidden} className="panel surface-card config-software-panel" aria-labelledby="remote-host-title">
    <div className="config-panel-heading">
      <div className="config-heading-title">
        <RadioTower size={18} aria-hidden="true" /><h2 id="remote-host-title">{t('connection.hostApp.title')}</h2><ScopeLabel scope="host" />
      </div>
    </div>
    <div className="config-software-content">
      <div className="config-software-settings-list">
        <div className="config-software-setting-row">
          <div className="config-software-setting-copy">
            <span className="config-software-setting-icon" aria-hidden="true"><Power size={18} /></span>
            <div><strong>{t('config.software.startCoreOnLaunch')}</strong><small>{t('connection.startCoreOnLaunchRemote')}</small></div>
          </div>
          <Switch title={reason ?? t('config.software.startCoreOnLaunch')} aria-label={t('config.software.startCoreOnLaunch')}
            checked={value ?? false} disabled={value === null || busy} onChange={(event) => {
              const enabled = event.currentTarget.checked;
              setBusy(true); setError('');
              void setRemoteStartCoreOnLaunch(enabled)
                .then(setValue)
                .catch((cause) => setError(t('config.error.saveFailed', { error: String(cause) })))
                .finally(() => setBusy(false));
            }} />
        </div>
      </div>
      {reason ? <Notice tone="info" variant="text">{reason}</Notice> : null}
      {error ? <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice> : null}
    </div>
  </section>;
}
