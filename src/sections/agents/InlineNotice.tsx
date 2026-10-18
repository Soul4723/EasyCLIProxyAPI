import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useI18n } from '../../i18n';
import { IconButton, Masked } from '../../ui';

/** Inline status line (error / success / info) with optional dismiss. Messages may carry paths, so they go through privacy masking. */
export function InlineNotice({ tone, message, onDismiss }: { tone: 'error' | 'success' | 'info'; message: ReactNode; onDismiss?: () => void }) {
  const { t } = useI18n();
  if (!message) return null;
  const Icon = tone === 'error' ? CircleAlert : tone === 'success' ? CircleCheck : Info;
  return (
    <div className={`ag-notice ag-notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon size={14} aria-hidden />
      <span className="ag-notice-text">{typeof message === 'string' ? <Masked value={message} /> : message}</span>
      {onDismiss ? <IconButton size="xs" label={t('common.close')} icon={<X size={12} />} onClick={onDismiss} /> : null}
    </div>
  );
}
