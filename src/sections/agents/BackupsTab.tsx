import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { ArchiveRestore, ArrowRight, Eye, Plus, Trash2 } from 'lucide-react';
import { useI18n } from '../../i18n';
import {
  Badge, Button, Card, Chip, ConfirmDialog, Dialog, EmptyState, ErrorState, IconButton, Masked, RelativeTime, Skeleton,
} from '../../ui';
import { InlineNotice } from './InlineNotice';
import type { AgentsController } from './useAgentsController';
import './manage.css';

type FileSummary = { path: string; exists: boolean | null; size: number | null };
type Version = { id: string; createdAt: string | null; fileCount: number; location: string; files: FileSummary[]; restorable: boolean; error: string | null };
type Listing = { versions: Version[] };
type Preview = { revision: string; files: FileSummary[]; differences: { file: string; field: string; before: string; after: string }[] };
/** Open preview/restore dialog: `preview` is cleared after a failed restore so the revision must be fetched again. */
type Review = { version: Version; preview: Preview | null; step: 'preview' | 'confirm'; busy: boolean; error: string };

/** Backups tab: create a manual backup, list versions (newest first), preview / restore / delete. Same commands as the old dialog. */
export function BackupsTab({ ctl }: { ctl: AgentsController }) {
  const { t, formatDate } = useI18n();
  const { selected, busy, busyAction } = ctl;
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [rowError, setRowError] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [removal, setRemoval] = useState<{ version: Version; busy: boolean; error: string } | null>(null);
  const request = useRef(0);

  const load = useCallback(async () => {
    const mine = ++request.current;
    setLoadError('');
    try {
      const listing = await invoke<Listing>('list_agent_config_backups', { client: selected });
      if (mine !== request.current) return;
      setVersions([...listing.versions].sort((a, b) => Date.parse(b.createdAt ?? '') - Date.parse(a.createdAt ?? '') || 0));
    } catch (cause) {
      if (mine === request.current) { setLoadError(String(cause)); setVersions((current) => current ?? []); }
    }
  }, [selected]);

  useEffect(() => {
    setVersions(null); setReview(null); setRemoval(null); setRowError('');
    if (!ctl.isPiClient) void load();
    return () => { request.current += 1; };
  }, [load, ctl.isPiClient]);

  // The controller owns the create call; reload the list when it finishes.
  const wasCreating = useRef(false);
  useEffect(() => {
    if (wasCreating.current && busyAction === null) void load();
    wasCreating.current = busyAction === 'backup';
  }, [busyAction, load]);

  const date = (version: Version) => version.createdAt
    ? formatDate(version.createdAt, { dateStyle: 'short', timeStyle: 'medium' }) : version.id;

  const open = async (version: Version, step: Review['step']) => {
    setPendingId(`${version.id}:${step}`); setRowError('');
    try {
      const preview = await invoke<Preview>('preview_agent_config_backup', { client: selected, id: version.id });
      setReview({ version, preview, step, busy: false, error: '' });
    } catch (cause) { setRowError(String(cause)); }
    finally { setPendingId(null); }
  };

  const restore = async () => {
    if (!review?.preview) return;
    const { version, preview } = review;
    setReview({ ...review, busy: true, error: '' });
    try {
      await invoke('restore_agent_config_backup', { client: selected, id: version.id, revision: preview.revision });
      await ctl.afterBackupRestored();
      setReview(null);
      await load();
    } catch (cause) {
      setReview({ version, preview: null, step: 'preview', busy: false, error: String(cause) });
    }
  };

  const remove = async () => {
    if (!removal) return;
    setRemoval({ ...removal, busy: true, error: '' });
    try {
      await invoke('delete_agent_config_backup', { client: selected, id: removal.version.id });
      setRemoval(null);
      await load();
    } catch (cause) { setRemoval({ version: removal.version, busy: false, error: String(cause) }); }
  };

  if (ctl.isPiClient) return <EmptyState icon={<ArchiveRestore size={20} />} title={t('sec.agents.backups.unsupported')} />;

  const create = (
    <Button variant="primary" size="sm" icon={<Plus size={14} />} loading={busyAction === 'backup'} disabled={busy}
      data-action="create-backup" onClick={() => void ctl.createManualBackup()}>
      {t('sec.agents.backups.create')}
    </Button>
  );

  return (
    <div className="ag-bk">
      <div className="ag-bk-bar">
        <h3>{t('sec.agents.backups.title')}</h3>
        {versions ? <Badge count={versions.length} /> : null}
        <span className="ag-spacer" />
        {create}
      </div>
      {rowError ? <InlineNotice tone="error" message={rowError} onDismiss={() => setRowError('')} /> : null}
      {versions === null ? (
        <Card padded={false} aria-busy="true">
          {[0, 1, 2].map((index) => <div className="ag-bk-row" key={index}><Skeleton lines={2} height={12} /></div>)}
        </Card>
      ) : loadError && !versions.length ? (
        <ErrorState title={t('sec.agents.backups.loadFailed')} message={<Masked value={loadError} />} onRetry={() => void load()} />
      ) : !versions.length ? (
        <EmptyState icon={<ArchiveRestore size={20} />} title={t('sec.agents.backups.empty')} action={create} />
      ) : (
        <Card padded={false} as="section">
          {loadError ? <InlineNotice tone="error" message={loadError} /> : null}
          <ul className="ag-bk-list">
            {versions.map((version) => (
              <li className="ag-bk-row" key={version.id} data-backup={version.id}>
                <div className="ag-bk-main">
                  <div className="ag-bk-time">
                    <strong>{version.createdAt ? <RelativeTime value={version.createdAt} /> : <Masked value={version.id} kind="identifier" mono />}</strong>
                    <Chip tone={version.restorable ? 'ok' : 'danger'} size="sm">
                      {t(version.restorable ? 'sec.agents.backups.restorable' : 'agents.backup.invalid')}
                    </Chip>
                    <span className="ec-muted ec-mono">{t('agents.backup.files', { count: version.fileCount })}</span>
                  </div>
                  <Masked value={version.location} mono className="ag-bk-loc" />
                  {version.error ? <span className="ag-bk-err"><Masked value={version.error} /></span> : null}
                </div>
                <div className="ag-bk-actions">
                  <Button size="sm" icon={<Eye size={14} />} loading={pendingId === `${version.id}:preview`}
                    disabled={busy || !version.restorable || pendingId !== null} onClick={() => void open(version, 'preview')}>
                    {t('sec.agents.backups.preview')}
                  </Button>
                  <Button size="sm" icon={<ArchiveRestore size={14} />} loading={pendingId === `${version.id}:confirm`}
                    disabled={busy || !version.restorable || pendingId !== null} onClick={() => void open(version, 'confirm')}>
                    {t('sec.agents.backups.restore')}
                  </Button>
                  <IconButton size="sm" label={t('common.delete')} icon={<Trash2 size={14} />} disabled={busy}
                    onClick={() => setRemoval({ version, busy: false, error: '' })} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {review ? (
        <Dialog open size="lg" dismissible={!review.busy} onClose={() => setReview(null)}
          title={review.step === 'confirm' ? t('agents.backup.restoreConfirm', { version: date(review.version) }) : t('agents.backup.preview')}
          footer={review.step === 'confirm' ? <>
            <Button variant="secondary" disabled={review.busy} onClick={() => setReview({ ...review, step: 'preview', error: '' })}>{t('common.cancel')}</Button>
            <Button variant="danger" loading={review.busy} disabled={!review.preview} onClick={() => void restore()}>{t('agents.backup.confirmRestore')}</Button>
          </> : <>
            <Button variant="secondary" onClick={() => setReview(null)}>{t('common.close')}</Button>
            <Button variant="primary" disabled={!review.preview} onClick={() => setReview({ ...review, step: 'confirm' })}>{t('sec.agents.backups.restore')}</Button>
          </>}>
          <div className="ag-dlg ag-bk-review">
            <div className="ag-dlg-line ec-muted">
              <RelativeTime value={review.version.createdAt} />
              <span aria-hidden>·</span>
              <Masked value={review.version.location} mono />
            </div>
            {review.step === 'confirm' ? <p className="ag-dlg-warn">{t('agents.backup.restoreWarning')}</p> : null}
            <h4 className="ag-dlg-sub">{t('sec.agents.backups.files')}</h4>
            <ul className="ag-bk-files">
              {review.version.files.map((file) => (
                <li key={file.path}>
                  <Masked value={file.path} mono />
                  <span className="ec-muted">{file.exists === null ? t('agents.backup.invalid')
                    : file.exists ? `${t('agents.backup.present')} · ${file.size ?? 0} B` : t('agents.backup.missing')}</span>
                </li>
              ))}
            </ul>
            {review.preview ? (
              review.preview.differences.length ? <>
                <h4 className="ag-dlg-sub">{t('sec.agents.backups.changes')}</h4>
                <ul className="ag-bk-diffs">
                  {review.preview.differences.map((diff) => (
                    <li key={`${diff.file}:${diff.field}`}>
                      <div className="ag-bk-diff-head"><Masked value={diff.file} mono /><span className="ec-muted ec-mono">{diff.field}</span></div>
                      <div className="ag-bk-diff-vals">
                        <span title={t('sec.agents.backups.current')}><Masked value={diff.before} mono /></span>
                        <ArrowRight size={12} aria-hidden />
                        <span title={t('sec.agents.backups.backup')}><Masked value={diff.after} mono /></span>
                      </div>
                    </li>
                  ))}
                </ul>
              </> : <p className="ec-muted">{t('agents.backup.unchanged')}</p>
            ) : null}
            {review.error ? <InlineNotice tone="error" message={review.error} /> : null}
          </div>
        </Dialog>
      ) : null}

      <ConfirmDialog open={removal !== null} danger busy={removal?.busy}
        title={t('agents.backup.deleteConfirm', { version: removal ? date(removal.version) : '' })}
        message={<>
          {t('agents.backup.deleteWarning')}
          {removal?.error ? <InlineNotice tone="error" message={removal.error} /> : null}
        </>}
        confirmLabel={t('agents.backup.confirmDelete')} onConfirm={() => void remove()} onCancel={() => setRemoval(null)} />
    </div>
  );
}
