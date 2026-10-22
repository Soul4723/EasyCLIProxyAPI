import { useEffect, useState } from 'react';
import { Monitor, RadioTower, Server } from 'lucide-react';
import { useRemoteCoreHost } from '../coreRuntime';
import { useI18n } from '../i18n';
import { usePrivacyMask } from '../privacy';
import { getComputerName } from '../services/platform';

// The three places a control can act on: this computer (this app and its agent clients), the core this app
// uses, and EasyCLIProxyAPI on the core's computer through remote host control.
export type Scope = 'computer' | 'core' | 'host';

const icons = { computer: Monitor, core: Server, host: RadioTower };
const titles = { computer: 'scope.computerTitle', core: 'scope.coreTitle', host: 'scope.hostTitle' } as const;

export function useComputerName() {
  const [name, setName] = useState('');
  useEffect(() => {
    let live = true;
    void getComputerName().then((value) => { if (live) setName(value); });
    return () => { live = false; };
  }, []);
  return name;
}

// Says which machine a card or section acts on. In Local mode everything is this computer, so it is shown only
// where `always` asks for it.
export function ScopeLabel({ scope, always = false }: { scope: Scope; always?: boolean }) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const remoteHost = useRemoteCoreHost();
  const computerName = useComputerName();
  if (remoteHost === null && !always) return null;
  const host = remoteHost === null ? null : privacy.text(remoteHost);
  const computer = privacy.text(computerName);
  const label = scope === 'computer' ? computer ? t('scope.computer', { name: computer }) : t('scope.computerUnnamed')
    : scope === 'core' ? host === null ? t('scope.coreLocal') : t('scope.core', { host })
    : t('scope.host', { host: host ?? '' });
  const Icon = icons[scope];
  return <span className={`scope-label ${scope}`} title={t(titles[scope])}>
    <Icon size={12} aria-hidden="true" /><span>{label}</span>
  </span>;
}
