import { CircleAlert, CircleCheck, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { Button, ConfirmDialog, IconButton, Masked } from '../../ui';
import './catalog.css';

/** Shared pieces of the Codex / Harness catalog dialogs (portal-rendered, so styles are scoped under `.cd-root`). */

/** Labelled form control; `wide` spans both grid columns, `hint` is a one-line note, `badge` marks a customized value. */
export function CatalogField({ label, wide, hint, badge, children }: {
  label: ReactNode; wide?: boolean; hint?: ReactNode; badge?: ReactNode; children: ReactNode;
}) {
  return (
    <label className={`cd-field${wide ? ' cd-field--wide' : ''}`}>
      <span className="cd-label">{label}{badge}</span>
      {children}
      {hint ? <small className="cd-hint">{hint}</small> : null}
    </label>
  );
}

/** Inline error / success line with dismiss. Messages may carry paths, so they pass through privacy masking. */
export function CatalogNotice({ tone, message, onDismiss }: { tone: 'error' | 'success'; message: string | null; onDismiss: () => void }) {
  const { t } = useI18n();
  if (!message) return null;
  const Icon = tone === 'error' ? CircleAlert : CircleCheck;
  return (
    <div className={`cd-notice cd-notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon size={14} aria-hidden />
      <span className="cd-notice-text"><Masked value={message} /></span>
      <IconButton size="xs" label={t('common.close')} icon={<X size={12} />} onClick={onDismiss} />
    </div>
  );
}

/** Dialog footer: notices + dirty/save hint on the left, reset / cancel / save on the right. */
export function CatalogFooter({ error, notice, dirty, saveHint, busy, canSave, saving, canReset, onDismissError, onDismissNotice, onResetAll, onCancel, onSave }: {
  error: string; notice: string; dirty: boolean; saveHint: string; busy: boolean; canSave: boolean; saving: boolean; canReset: boolean;
  onDismissError: () => void; onDismissNotice: () => void; onResetAll: () => void; onCancel: () => void; onSave: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="cd-root cd-foot">
      <div className="cd-foot-msgs">
        <CatalogNotice tone="error" message={error || null} onDismiss={onDismissError} />
        <CatalogNotice tone="success" message={!error && notice ? notice : null} onDismiss={onDismissNotice} />
        <span className={`cd-foot-hint${dirty ? ' is-dirty' : ''}`}>{dirty ? t('agents.catalog.unsaved') : saveHint}</span>
      </div>
      <div className="cd-foot-actions">
        <Button variant="ghost" disabled={!canReset || busy} onClick={onResetAll}>{t('agents.catalog.resetAll')}</Button>
        <Button variant="secondary" disabled={saving} onClick={onCancel}>{t('common.cancel')}</Button>
        <Button variant="primary" disabled={!canSave} loading={saving} onClick={onSave}>{saving ? t('common.saving') : t('common.save')}</Button>
      </div>
    </div>
  );
}

/** Confirm dialog shown before closing / reloading with unsaved edits. */
export function CatalogDiscardConfirm({ open, onKeep, onDiscard }: { open: boolean; onKeep: () => void; onDiscard: () => void }) {
  const { t } = useI18n();
  return (
    <ConfirmDialog open={open} danger title={t('agents.catalog.unsaved')} message={t('agents.catalog.discardHint')}
      confirmLabel={t('agents.catalog.discard')} cancelLabel={t('agents.catalog.keepEditing')} onCancel={onKeep} onConfirm={onDiscard} />
  );
}
