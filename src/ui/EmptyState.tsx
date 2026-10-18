/**
 * EmptyState: dashed box for "nothing here yet" (no data, no results). ErrorState: solid box for a failed load, with
 * an optional retry action.
 *
 * EmptyState props: icon? (lucide node, rendered aria-hidden; default Inbox), title (string), action? (node, e.g. a Button),
 * compact? (smaller padding for inline use inside cards/tables), className?.
 * ErrorState props: title? (ui.error.title), message? (node), onRetry? (shows the retry button), retryLabel?
 * (common.retry), className?. Renders role="alert".
 */
import type { ReactNode } from 'react';
import { CircleAlert, Inbox, RotateCw } from 'lucide-react';
import { useI18n } from '../i18n';
import { Button } from './Button';
import { cx } from './cx';
import { useUiText } from './uiText';
import './EmptyState.css';

export type EmptyStateProps = {
  icon?: ReactNode;
  title: string;
  action?: ReactNode;
  compact?: boolean;
  className?: string;
};

export function EmptyState({ icon, title, action, compact = false, className }: EmptyStateProps) {
  return (
    <div className={cx('ec-empty', compact && 'ec-empty--compact', className)}>
      <span className="ec-empty__icon" aria-hidden="true">
        {icon ?? <Inbox size={20} />}
      </span>
      <p className="ec-empty__title">{title}</p>
      {action ? <div className="ec-empty__action">{action}</div> : null}
    </div>
  );
}

export type ErrorStateProps = {
  title?: string;
  message?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
};

export function ErrorState({ title, message, onRetry, retryLabel, className }: ErrorStateProps) {
  const tu = useUiText();
  const { t } = useI18n();

  return (
    <div role="alert" className={cx('ec-empty', 'ec-empty--error', className)}>
      <span className="ec-empty__icon" aria-hidden="true">
        <CircleAlert size={20} />
      </span>
      <p className="ec-empty__title">{title ?? tu('ui.error.title')}</p>
      {message ? <p className="ec-empty__message">{message}</p> : null}
      {onRetry ? (
        <div className="ec-empty__action">
          <Button size="sm" variant="secondary" icon={<RotateCw size={14} />} onClick={onRetry}>
            {retryLabel ?? t('common.retry')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
