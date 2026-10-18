import { CircleAlert, CircleCheck, TriangleAlert, X } from 'lucide-react';
import { useI18n } from '../../../i18n';
import { IconButton, Masked } from '../../../ui';

/** Operation result line (success / warning / error) for the sessions page and editor; text may carry paths, so it is masked. */
export function SessionNotice({ kind, message, onDismiss }: { kind: 'success' | 'warning' | 'error'; message: string; onDismiss?: () => void }) {
  const { t } = useI18n();
  const Icon = kind === 'error' ? CircleAlert : kind === 'warning' ? TriangleAlert : CircleCheck;
  return (
    <div className={`ag-notice ses-notice ses-notice--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon size={14} aria-hidden />
      <span className="ag-notice-text"><Masked value={message} /></span>
      {onDismiss ? <IconButton size="xs" label={t('common.close')} icon={<X size={12} />} onClick={onDismiss} /> : null}
    </div>
  );
}
