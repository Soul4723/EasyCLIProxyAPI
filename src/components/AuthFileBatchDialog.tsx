import { useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { usePrivacyMask } from '../privacy';
import { isOAuthCredentialFile, setOAuthCredentialFileDisabled, type AuthFileRecord } from '../services/authFiles';
import { refreshAllCredentials, refreshCredential, runCredentialBatch, type CredentialResult } from '../services/authFileOperations';
import { managementApi, readString } from '../services/managementApi';
import { quotaKey } from '../services/quotaService';
import { Button, Checkbox, ConfirmDialog, Dialog } from '../ui';
import './AuthFileBatchDialog.css';

type Operation = 'enable' | 'disable' | 'delete' | 'refresh' | 'all';

export function AuthFileBatchDialog({ files, onClose, onChanged }: {
  /** Files already narrowed by the provider page's current search and filters. */
  files: AuthFileRecord[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const { t } = useI18n();
  const privacy = usePrivacyMask();
  const eligible = useMemo(() => files.filter(isOAuthCredentialFile), [files]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [confirm, setConfirm] = useState<Operation | null>(null);
  const [results, setResults] = useState<CredentialResult[]>([]);
  const [error, setError] = useState('');
  const targets = eligible.filter((file) => selected.has(quotaKey(file)));
  const refreshTargets = targets.filter((file) => file.disabled !== true);

  const run = async (operation: Operation) => {
    if (pending.current || (operation !== 'all' && (operation === 'refresh' ? !refreshTargets.length : !targets.length))) return;
    if (operation === 'delete' || operation === 'all') {
      setConfirm(operation);
      return;
    }
    await execute(operation);
  };

  const execute = async (operation: Operation) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setConfirm(null);
    setError('');
    setResults([]);
    try {
      // Capture once for this operation. Every request in a batch is fenced to
      // this document target, even if the owner switches Remote/local targets.
      const expectedRevision = await managementApi.getTargetRevision();
      const next = operation === 'all'
        ? await refreshAllCredentials({ expectedRevision })
        : await runCredentialBatch(operation === 'refresh' ? refreshTargets : targets, async (file) => {
          if (operation === 'refresh') return refreshCredential(file, { expectedRevision });
          if (operation === 'delete') {
            return managementApi.delete('/credentials', { query: { name: readString(file, 'name') }, expectedRevision });
          }
          return setOAuthCredentialFileDisabled(file, operation === 'disable', managementApi, { expectedRevision });
        });
      setResults(next);
      setSelected(new Set());
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  const confirmation = confirm;
  return <>
    <Dialog open title={t('authFiles.operations.title')} onClose={onClose} size="md" busy={busy}
      footer={<Button variant="secondary" disabled={busy} onClick={onClose}>{t('common.close')}</Button>}>
      <div className="ec-auth-batch-toolbar">
        <Checkbox ariaLabel={t('authFiles.operations.selectAll')} checked={eligible.length > 0 && selected.size === eligible.length}
          disabled={busy || !eligible.length} onChange={(event) => setSelected(new Set(event.currentTarget.checked ? eligible.map(quotaKey) : []))} />
        <span>{t('authFiles.operations.selectAll')} ({selected.size}/{eligible.length})</span>
      </div>
      <div className="ec-auth-batch-list">
        {eligible.map((file) => {
          const key = quotaKey(file);
          return <div className="ec-auth-batch-row" key={key}>
            <Checkbox ariaLabel={privacy.credentialName(file)} checked={selected.has(key)} disabled={busy}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSelected((current) => {
                  const next = new Set(current);
                  if (checked) next.add(key); else next.delete(key);
                  return next;
                });
              }} />
            <span>{privacy.credentialName(file)}</span>
          </div>;
        })}
        {!eligible.length ? <p>{t('authFiles.empty.filtered')}</p> : null}
        {error ? <p className="ec-auth-batch-error" role="alert">{privacy.text(error, files.flatMap((file) => [readString(file, 'email'), readString(file, 'name')]).filter(Boolean))}</p> : null}
        {results.length ? <div role="status">
          <p>{t('authFiles.operations.done', { success: results.filter((result) => result.success).length, failed: results.filter((result) => !result.success).length })}</p>
          {results.map((result, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Batch results never reorder and filenames may repeat.
            <p className="ec-auth-batch-result" key={`${result.id}:${index}`}>
              {privacy.text(result.id, [result.id])} · {result.success ? '✓' : '✗'}
              {result.error ? <small> · {privacy.text(result.error, [result.id, ...files.map((file) => readString(file, 'email'))].filter(Boolean))}</small> : null}
            </p>
          ))}
        </div> : null}
      </div>
      <div className="ec-auth-batch-actions">
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => void run('all')}>{t('authFiles.operations.refreshAll')}</Button>
        <Button size="sm" variant="secondary" disabled={busy || !refreshTargets.length} onClick={() => void run('refresh')}>{t('authFiles.operations.refresh')}</Button>
        <Button size="sm" variant="secondary" disabled={busy || !targets.length} onClick={() => void run('enable')}>{t('common.enable')}</Button>
        <Button size="sm" variant="secondary" disabled={busy || !targets.length} onClick={() => void run('disable')}>{t('common.disable')}</Button>
        <Button size="sm" variant="danger" disabled={busy || !targets.length} onClick={() => void run('delete')}>{t('common.delete')}</Button>
      </div>
    </Dialog>
    <ConfirmDialog open={confirmation !== null} title={t(confirmation === 'delete' ? 'common.delete' : 'authFiles.operations.refreshAll')}
      message={confirmation === 'delete'
        ? t('authFiles.operations.confirmDelete', { count: targets.length })
        : t('authFiles.operations.confirmRefresh')}
      confirmLabel={t(confirmation === 'delete' ? 'common.delete' : 'authFiles.operations.refreshAll')}
      danger={confirmation === 'delete'} busy={busy} onCancel={() => setConfirm(null)}
      onConfirm={() => { if (confirmation) void execute(confirmation); }} />
  </>;
}
