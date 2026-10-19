import { useCoreRuntime } from '../coreRuntime';
import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { beginConnectionChange, restoreConnectionAfterSaveFailure } from '../services/connectionGeneration';
import { X } from 'lucide-react';
import { useCoreConnection } from '../coreConnection';
import { normalizedCoreConnection } from '../services/coreConnection';
import { useI18n } from '../i18n';
import { useDialogFocusTrap } from './useDialogFocusTrap';

export function CoreConnectionDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { connection, reload } = useCoreConnection();
  const { status } = useCoreRuntime();
  const [draft, setDraft] = useState(connection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const ref = useDialogFocusTrap<HTMLElement>({ onEscape: busy ? undefined : onClose, preventEscape: busy });
  const run = async (save: boolean) => {
    setError(''); setResult('');
    let next;
    try { next = normalizedCoreConnection(draft); }
    catch { setError(t('connection.invalid')); return; }
    setBusy(true);
    try {
      if (save) {
        beginConnectionChange();
        try { await invoke('save_core_connection', { connection: next }); }
        catch (cause) { restoreConnectionAfterSaveFailure(); throw cause; }
        if (alive.current) await reload();
      } else {
        const response = await invoke<{ version: string | null; message: string }>('test_core_connection', { connection: next });
        if (alive.current) setResult([response.message, response.version].filter(Boolean).join(' · '));
      }
    } catch (cause) { if (alive.current) setError(String(cause)); }
    finally { if (alive.current) setBusy(false); }
  };
  return <div className="install-dialog-backdrop"><section ref={ref} role="dialog" aria-modal="true" aria-labelledby="core-connection-title" className="panel core-connection-dialog">
    <div className="panel-heading"><h2 id="core-connection-title">{t('connection.title')}</h2><button type="button" className="icon-button quiet" disabled={busy} aria-label={t('common.close')} onClick={onClose}><X size={18} /></button></div>
    <form onSubmit={event => { event.preventDefault(); void run(true); }}>
      <fieldset disabled={busy} className="core-connection-fields"><legend>{t('connection.mode')}</legend>
        <div className="button-row">{(['local', 'remote'] as const).map(mode => <label key={mode}><input type="radio" name="core-mode" checked={draft.mode === mode} onChange={() => { setDraft({ ...draft, mode }); setResult(''); setError(''); }} /> {t(`connection.${mode}`)}</label>)}</div>
        {draft.mode === 'remote' ? <>
          <label>{t('connection.origin')}<input className="config-dialog-text-input" type="url" required value={draft.remoteManagementOrigin} onChange={event => { setDraft({ ...draft, remoteManagementOrigin: event.currentTarget.value }); setResult(''); setError(''); }} /></label>
          <label>{t('connection.key')}<input className="config-dialog-text-input" type="password" required autoComplete="off" value={draft.remoteManagementKey} onChange={event => { setDraft({ ...draft, remoteManagementKey: event.currentTarget.value }); setResult(''); setError(''); }} /></label>
          <fieldset className="core-connection-fields">
            <legend>{t('connection.clientTarget')}</legend>
            <p>{t('connection.clientTargetHint')}</p>
            <label>{t('connection.clientOrigin')}<input className="config-dialog-text-input" type="url" value={draft.clientApiOrigin} onChange={event => { setDraft({ ...draft, clientApiOrigin: event.currentTarget.value }); setResult(''); setError(''); }} /></label>
            <label>{t('connection.clientKey')}<input className="config-dialog-text-input" type="password" autoComplete="off" value={draft.clientApiKey} onChange={event => { setDraft({ ...draft, clientApiKey: event.currentTarget.value }); setResult(''); setError(''); }} /></label>
          </fieldset>
          <p>{t('connection.hint')}</p>
          {connection.mode === 'local' && status?.managed && status.running ? <p role="status">{t('connection.stopLocal')}</p> : null}
        </> : <p>{t('connection.localHint')}</p>}
      </fieldset>
      {error ? <p role="alert" className="home-runtime-error">{error}</p> : null}
      {result ? <p role="status">{result}</p> : null}
      <div className="button-row"><button type="button" className="secondary-button" disabled={busy} onClick={onClose}>{t('connection.back')}</button>{draft.mode === 'remote' ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void run(false)}>{t('connection.test')}</button> : null}<button type="submit" className="primary-button" disabled={busy}>{t(busy ? 'common.processing' : 'common.save')}</button></div>
    </form>
  </section></div>;
}
