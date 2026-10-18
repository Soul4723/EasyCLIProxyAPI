import { Trash2 } from 'lucide-react';
import { useI18n } from '../../../i18n';
import type { SessionIndexCleanupPreview } from '../../../services/codexSessionState';
import { Badge, Button, Dialog, Masked, RelativeTime } from '../../../ui';

type CleanupDialogProps = {
  preview: SessionIndexCleanupPreview;
  selectedIds: Set<string>;
  onSelectedIds: (ids: Set<string>) => void;
  applying: boolean;
  onApply: () => void;
  onClose: () => void;
};

/**
 * Session-index cleanup: lists the `session_index.jsonl`-only entries from `preview_codex_session_index_cleanup`.
 * Nothing is ticked by default; Apply sends the snapshot hash plus the ticked thread ids.
 */
export function CleanupDialog({ preview, selectedIds, onSelectedIds, applying, onApply, onClose }: CleanupDialogProps) {
  const { t } = useI18n();
  const all = preview.candidates.length > 0 && selectedIds.size === preview.candidates.length;
  const toggle = (id: string, checked: boolean) => {
    const next = new Set(selectedIds);
    if (checked) next.add(id);
    else next.delete(id);
    onSelectedIds(next);
  };
  return (
    <Dialog
      open
      size="lg"
      dismissible={!applying}
      onClose={onClose}
      title={(
        <span className="ec-sec-agents">
          <span className="ses-dialog-title">
            {t('agents.sessions.cleanupTitle')}
            <Badge tone="warn">{t('sec.agents.sessions.cleanupFound', { count: preview.candidates.length })}</Badge>
          </span>
        </span>
      )}
      footer={(
        <>
          <Button variant="secondary" disabled={applying} onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="danger" icon={<Trash2 size={14} />} loading={applying} disabled={selectedIds.size === 0} onClick={onApply}>
            {t('agents.sessions.cleanupConfirm', { count: selectedIds.size })}
          </Button>
        </>
      )}
    >
      <div className="ec-sec-agents ses-cleanup">
        <p className="ses-cleanup-hint ec-muted">{t('sec.agents.sessions.cleanupHint')}</p>
        <label className="ses-cleanup-all">
          <input type="checkbox" className="ses-check" checked={all} disabled={applying}
            onChange={(event) => onSelectedIds(event.currentTarget.checked ? new Set(preview.candidates.map((candidate) => candidate.id)) : new Set())} />
          <span>{t('agents.sessions.cleanupSelectAll')}</span>
        </label>
        <ul className="ses-cleanup-list">
          {preview.candidates.map((candidate) => (
            <li key={candidate.id}>
              <label className="ses-cleanup-row">
                <input type="checkbox" className="ses-check" checked={selectedIds.has(candidate.id)} disabled={applying}
                  onChange={(event) => toggle(candidate.id, event.currentTarget.checked)} />
                <span className="ses-cleanup-name ec-trunc"><Masked value={candidate.threadName || t('agents.sessions.untitled')} /></span>
                <Masked kind="identifier" mono className="ses-cleanup-id ec-trunc ec-muted" value={candidate.id} />
                <span className="ec-muted ses-cleanup-time"><RelativeTime value={candidate.updatedAt} /></span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
