import { useEffect, useState } from 'react';
import { Check, Link2 } from 'lucide-react';
import { Notice } from '../components/Notice';
import { Select } from '../components/Select';
import { useCoreRuntime } from '../coreRuntime';
import { useI18n } from '../i18n';
import {
  canSaveConnection, getCoreConnection, isInsecureRemoteOrigin, saveCoreConnection, testCoreConnection,
  type ConnectionTestResult, type CoreConnection,
} from '../services/coreConnection';

export function CoreConnectionSettings({ hidden }: { hidden?: boolean }) {
  const { t } = useI18n();
  const { status } = useCoreRuntime();
  const [saved, setSaved] = useState<CoreConnection | null>(null);
  const [draft, setDraft] = useState<CoreConnection | null>(null);
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const localCoreRunning = Boolean(status?.managed && status.running);

  useEffect(() => {
    void getCoreConnection().then((value) => { setSaved(value); setDraft(value); }).catch((cause) => setError(String(cause)));
  }, []);

  const edit = (change: Partial<CoreConnection>) => {
    setDraft((value) => value && { ...value, ...change });
    setResult(null);
  };
  const test = async () => {
    if (!draft) return;
    setBusy('test'); setError(''); setResult(null);
    try { setResult(await testCoreConnection(draft)); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(null); }
  };
  const save = async () => {
    if (!draft) return;
    setBusy('save'); setError(''); setResult(null);
    try {
      const next = await saveCoreConnection(draft);
      if (JSON.stringify(next) !== JSON.stringify(saved)) window.location.reload();
      setSaved(next);
      setDraft(next);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(null); }
  };

  const remote = draft?.mode === 'remote';
  return <section hidden={hidden} className="surface-card config-network-section" aria-labelledby="core-connection-title">
    <div className="config-network-section-heading">
      <div className="config-network-section-title"><Link2 size={16} aria-hidden="true" /><h3 id="core-connection-title">{t('connection.title')}</h3></div>
    </div>
    {draft ? <div className="config-network-grid">
      <div className="config-network-field">
        <span className="config-field-label"><label htmlFor="core-connection-mode">{t('connection.mode')}</label></span>
        <Select id="core-connection-mode" className="config-network-input" value={draft.mode} disabled={busy !== null}
          onChange={(event) => edit({ mode: event.currentTarget.value as CoreConnection['mode'] })}>
          <option value="local">{t('connection.local')}</option>
          <option value="remote">{t('connection.remote')}</option>
        </Select>
      </div>
      {remote ? <>
        <div className="config-network-field">
          <span className="config-field-label"><label htmlFor="core-connection-origin">{t('connection.managementOrigin')}</label></span>
          <input id="core-connection-origin" className="config-network-input" type="text" placeholder={t('connection.originPlaceholder')}
            value={draft.managementOrigin} disabled={busy !== null} onChange={(event) => edit({ managementOrigin: event.currentTarget.value })} />
        </div>
        <div className="config-network-field">
          <span className="config-field-label"><label htmlFor="core-connection-key">{t('connection.managementKey')}</label></span>
          <input id="core-connection-key" className="config-network-input" type="password" autoComplete="off"
            value={draft.managementKey} disabled={busy !== null} onChange={(event) => edit({ managementKey: event.currentTarget.value })} />
        </div>
      </> : null}
    </div> : null}
    {draft && isInsecureRemoteOrigin(draft) ? <Notice tone="warn">{t('connection.httpWarning')}</Notice> : null}
    {remote && localCoreRunning && saved?.mode !== 'remote' ? <Notice tone="info">{t('connection.stopLocalHint')}</Notice> : null}
    {error ? <Notice tone="error" onDismiss={() => setError('')}>{error}</Notice> : null}
    {result ? <Notice tone={result.connected ? 'success' : 'error'}>
      {[result.connected ? t('connection.connected') : t('connection.failed'), result.version, result.message].filter(Boolean).join(' · ')}
    </Notice> : null}
    <div className="config-settings-save-row">
      {remote ? <button type="button" className="secondary-button compact-button" disabled={busy !== null || !draft.managementOrigin.trim() || !draft.managementKey} onClick={() => void test()}>
        {t('connection.test')}
      </button> : null}
      <button type="button" className="primary-button compact-button" disabled={!draft || !saved || busy !== null || !canSaveConnection(draft, saved, localCoreRunning)} onClick={() => void save()}>
        <Check size={16} aria-hidden="true" />{busy === 'save' ? t('common.saving') : t('common.save')}
      </button>
    </div>
  </section>;
}
