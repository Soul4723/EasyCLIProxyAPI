import { useEffect, useState } from 'react';
import { Check, Copy, Eye, EyeOff, RadioTower, RefreshCw } from 'lucide-react';
import { Notice } from '../components/Notice';
import { ScopeLabel } from '../components/ScopeLabel';
import { Switch } from '../components/Switch';
import { useI18n } from '../i18n';
import { getGuiSettings } from '../services/appSettings';
import {
  getHostControlSettings, isValidListenAddress, saveHostControlSettings, type HostControlSettings as Settings,
} from '../services/hostControl';
import './CoreConnectionSettings.css';

// This computer as a remote host: an opt-in listener that lets EasyCLIProxyAPI elsewhere start, stop and restart
// the local core. Off by default; the key is generated here and only shown here.
export function HostControlSettings({ hidden }: { hidden?: boolean }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [address, setAddress] = useState('');
  const [corePort, setCorePort] = useState<number | undefined>(undefined);
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const load = (value: Settings) => { setSettings(value); setEnabled(value.enabled); setAddress(value.address); };
  useEffect(() => {
    void getHostControlSettings().then(load).catch((cause) => setError(String(cause)));
    void getGuiSettings().then((value) => setCorePort(value.port)).catch(() => undefined);
  }, []);

  const available = settings?.available === true;
  const disabled = busy || !available;
  // Empty keeps localhost-only access on this core's port + 100; LAN/VPN access needs an explicit address.
  const addressValid = address.trim() === '' ? Boolean(settings?.defaultAddress) : isValidListenAddress(address, corePort);
  const dirty = Boolean(settings && (enabled !== settings.enabled || address.trim() !== settings.address));

  const save = async (regenerateKey = false) => {
    setBusy(true); setError(''); setSaved('');
    try {
      load(await saveHostControlSettings({ enabled, address: address.trim(), regenerateKey }));
      setSaved(t(regenerateKey ? 'hostControl.regenerated' : 'hostControl.saved'));
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  const copyKey = async () => {
    if (!settings?.key) return;
    try { await navigator.clipboard.writeText(settings.key); setSaved(t('hostControl.copied')); }
    catch (cause) { setError(String(cause)); }
  };

  const status = !settings || !available ? null
    : settings.listening ? <Notice tone="success" variant="text">{t('hostControl.listening', { address: settings.listening })}</Notice>
    : settings.error ? <Notice tone="error" variant="text">{t('hostControl.notRunning', { error: settings.error })}</Notice>
    : <p className="core-connection-hint">{t('hostControl.off')}</p>;

  const heading = <div className="config-panel-heading">
    <div className="config-heading-title"><RadioTower size={18} aria-hidden="true" /><h2 id="host-control-title">{t('hostControl.title')}</h2><ScopeLabel scope="computer" /></div>
  </div>;
  // While this app uses a remote core there is no core here to control: only say so, without a form.
  if (settings && !available) return <section id="config-host-control" tabIndex={-1} hidden={hidden} className="panel surface-card core-connection-card" aria-labelledby="host-control-title">
    {heading}
    <p className="core-connection-hint">{t('hostControl.remoteUnavailable')}</p>
  </section>;

  return <section id="config-host-control" tabIndex={-1} hidden={hidden} className="panel surface-card core-connection-card" aria-labelledby="host-control-title">
    {heading}
    <div className="core-connection-form">
      <p className="core-connection-hint">{t('hostControl.description')}</p>
      <Switch label={t('hostControl.enable')} checked={enabled} disabled={disabled}
        onChange={(event) => { setEnabled(event.currentTarget.checked); setSaved(''); }} />
      <div className="core-connection-fields">
        <div className="host-control-field">
          <label className="config-management-field">
            <span>{t('hostControl.address')}</span>
            <input className="config-dialog-text-input" type="text" autoComplete="off" spellCheck={false} placeholder={settings?.defaultAddress ?? ''}
              value={address} disabled={disabled} aria-invalid={address.trim() !== '' && !addressValid}
              onChange={(event) => { setAddress(event.currentTarget.value); setSaved(''); }} />
          </label>
          <p className="core-connection-hint">{t('hostControl.addressHint')}{settings?.defaultAddress ? ` ${t('hostControl.addressDefault', { address: settings.defaultAddress })}` : ''}</p>
        </div>
        <div className="host-control-field">
          <label className="config-management-field">
            <span>{t('hostControl.key')}</span>
            <div className="config-secret-input">
              <input type={showKey ? 'text' : 'password'} readOnly autoComplete="off" spellCheck={false} value={settings?.key ?? ''}
                placeholder={t('hostControl.keyPending')} disabled={!settings?.key} />
              <button type="button" className="icon-button quiet" disabled={!settings?.key} onClick={() => setShowKey((value) => !value)}
                title={t(showKey ? 'config.keys.hide' : 'config.keys.show')} aria-label={t(showKey ? 'config.keys.hide' : 'config.keys.show')}>
                {showKey ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}
              </button>
              <button type="button" className="icon-button quiet" disabled={!settings?.key} onClick={() => void copyKey()}
                title={t('hostControl.copyKey')} aria-label={t('hostControl.copyKey')}>
                <Copy size={16} aria-hidden="true" />
              </button>
            </div>
          </label>
          <p className="core-connection-hint">{t('hostControl.keyHint')}</p>
        </div>
      </div>
      {address.trim() !== '' && !addressValid ? <Notice tone="error" variant="text" live={false}>{t('hostControl.invalidAddress')}</Notice> : null}
      {enabled && available ? <Notice tone="warn" variant="text">{t('hostControl.warning')}</Notice> : null}
      {status}
      {saved ? <Notice tone="success" variant="text">{saved}</Notice> : null}
      {error ? <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice> : null}
    </div>
    <div className="config-settings-save-row core-connection-footer">
      <div className="core-connection-actions">
        <button type="button" className="secondary-button compact-button" disabled={disabled || dirty || !settings?.enabled} onClick={() => void save(true)}>
          <RefreshCw size={15} aria-hidden="true" />{t('hostControl.regenerate')}
        </button>
        <button type="button" className="primary-button compact-button" disabled={disabled || !dirty || !addressValid} onClick={() => void save()}>
          <Check size={16} aria-hidden="true" />{busy ? t('common.saving') : t('common.save')}
        </button>
      </div>
    </div>
  </section>;
}
