import { useEffect, useState } from 'react';
import { Switch } from '../components/Switch';
import { useRemoteHostControl } from '../coreRuntime';
import { useI18n } from '../i18n';
import { getRemoteStartCoreOnLaunch, setRemoteStartCoreOnLaunch } from '../services/hostControl';

// Remote mode: Start Core on Launch is the remote host app's own setting, changed at once through remote host
// control. It never touches this computer's saved Start Core on Launch, which stays for Local mode.
export function RemoteStartCoreOnLaunchSwitch({ onError }: { onError: (message: string) => void }) {
  const { t } = useI18n();
  const reachable = useRemoteHostControl();
  const [value, setValue] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!reachable) { setValue(null); return; }
    let disposed = false;
    void getRemoteStartCoreOnLaunch()
      .then((next) => { if (!disposed) setValue(next); })
      .catch(() => { if (!disposed) setValue(null); });
    return () => { disposed = true; };
  }, [reachable]);

  const unavailable = !reachable || value === null;
  return <Switch title={unavailable ? t('connection.hostControlRequired') : t('connection.startCoreOnLaunchRemote')}
    aria-label={t('config.software.startCoreOnLaunch')} checked={value ?? false} disabled={unavailable || busy}
    onChange={(event) => {
      const enabled = event.currentTarget.checked;
      setBusy(true);
      void setRemoteStartCoreOnLaunch(enabled)
        .then(setValue)
        .catch((error) => onError(String(error)))
        .finally(() => setBusy(false));
    }} />;
}
