import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle, X } from 'lucide-react';
import { useDialogFocusTrap } from '../components/useDialogFocusTrap';
import { useI18n } from '../i18n';
import { useCoreRuntime } from '../coreRuntime';
import { getCoreConnection, saveCoreConnection, testCoreConnection, type CoreConnection, type ConnectionTestResult } from '../services/coreConnection';
import './CoreConnectionSettings.css';

export function CoreConnectionSettings({ onClose, onSaved, initialDraft, onDraftChange }: {
  onClose: () => void; onSaved: (connection: CoreConnection) => void;
  initialDraft: CoreConnection | null; onDraftChange: (connection: CoreConnection) => void;
}) {
  const { t } = useI18n();
  const { status } = useCoreRuntime();
  const ownedLocalRunning = status?.connectionMode !== 'remote' && status?.managed && status.running;
  const [draft, setDraft] = useState<CoreConnection | null>(initialDraft);
  const [busy, setBusy] = useState<'load' | 'test' | 'save' | null>(initialDraft ? null : 'load');
  const [error, setError] = useState('');
  const [result, setResult] = useState<ConnectionTestResult | null>(null);
  const inFlight = useRef(false);
  const dialogRef = useDialogFocusTrap<HTMLElement>({ onEscape: busy ? undefined : onClose, preventEscape: Boolean(busy) });
  useEffect(() => {
    if (initialDraft) return;
    let active = true;
    getCoreConnection().then(value => { if (active) setDraft(value); })
      .catch(cause => { if (active) setError(String(cause)); })
      .finally(() => { if (active) setBusy(null); });
    return () => { active = false; };
  }, []);
  const change = (field: keyof CoreConnection, value: string) => {
    if (!draft) return;
    const next = { ...draft, [field]: value };
    setDraft(next);
    onDraftChange(next);
    setResult(null);
    setError('');
  };
  const run = async (action: 'test' | 'save') => {
    if (!draft || inFlight.current) return;
    inFlight.current = true;
    setBusy(action); setError(''); setResult(null);
    try {
      if (action === 'test') setResult(await testCoreConnection(draft));
      else onSaved(await saveCoreConnection(draft));
    } catch (cause) { setError(String(cause)); }
    finally { inFlight.current = false; setBusy(null); }
  };
  return createPortal(<div className="config-dialog-backdrop" onMouseDown={event => {
    if (event.currentTarget === event.target && !busy) onClose();
  }}>
    <section ref={dialogRef} className="config-dialog core-connection-dialog" role="dialog" aria-modal="true" aria-labelledby="core-connection-title" aria-describedby="core-connection-description" aria-busy={Boolean(busy)} tabIndex={-1}>
      <div className="config-dialog-heading"><h2 id="core-connection-title">{t('connection.title')}</h2>
        <button type="button" className="icon-button quiet" disabled={Boolean(busy)} onClick={onClose} aria-label={t('common.close')}><X size={18} /></button>
      </div>
      <form onSubmit={event => { event.preventDefault(); void run('save'); }}>
        <div className="core-connection-body">
          <p id="core-connection-description">{t('connection.description')}</p>
          {busy === 'load' && <LoaderCircle className="spin" aria-label={t('common.loading')} />}
          {draft && <>
            <label><span>{t('connection.mode')}</span><select aria-label={t('connection.mode')} disabled={Boolean(busy)} value={draft.mode} onChange={event => change('mode', event.target.value)}><option value="local">{t('connection.local')}</option><option value="remote">{t('connection.remote')}</option></select></label>
            {draft.mode === 'remote' ? <>
              {ownedLocalRunning && <p className="core-connection-hint" role="status">{t('connection.stopLocalHint')}</p>}
              <label><span>{t('connection.managementOrigin')}</span><input type="url" required disabled={Boolean(busy)} value={draft.managementOrigin} placeholder="http://core.example:8317" onChange={event => change('managementOrigin', event.target.value)} /></label>
              <label><span>{t('connection.managementKey')}</span><input type="password" autoComplete="off" required disabled={Boolean(busy)} value={draft.managementKey} onChange={event => change('managementKey', event.target.value)} /></label>
              <p className="core-connection-hint">{t('connection.keysHint')}</p>
              <label><span>{t('connection.clientOrigin')}</span><input type="url" required disabled={Boolean(busy)} value={draft.clientOrigin} placeholder="http://core.example:8317" onChange={event => change('clientOrigin', event.target.value)} /></label>
              <label><span>{t('connection.clientKey')}</span><input type="password" autoComplete="off" disabled={Boolean(busy)} value={draft.clientKey} onChange={event => change('clientKey', event.target.value)} /></label>
              <p className="core-connection-hint">{t('connection.remoteHint')}</p>
            </> : <p>{t('connection.localHint')}</p>}
          </>}
          {error && <p role="alert" className="core-connection-error">{error}</p>}
          {result && <p role="status" className={result.connected ? 'core-connection-success' : 'core-connection-error'}>{result.connected ? t('connection.connected') : t('connection.failed')}{result.version ? ` · ${result.version}` : ''}{result.message ? ` — ${result.message}` : ''}</p>}
        </div>
        <div className="config-dialog-actions button-row">
          {draft?.mode === 'remote' && <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => void run('test')}>{busy === 'test' && <LoaderCircle size={14} className="spin" />}{t('connection.test')}</button>}
          <button type="submit" className="primary-button" disabled={!draft || Boolean(busy)}>{busy === 'save' && <LoaderCircle size={14} className="spin" />}{t('connection.save')}</button>
        </div>
      </form>
    </section>
  </div>, document.body);
}
