/**
 * Dialog: centred modal (portal to body) with scrim, focus trap and Escape handling. ConfirmDialog: Dialog with a
 * confirm/cancel footer.
 *
 * Dialog props: open, onClose, title (ReactNode), children, footer?, size ('sm' 400px | 'md' 520px default | 'lg' 760px),
 * dismissible (default true). When dismissible is false, Escape, the scrim and the close button do nothing.
 * Focus is trapped with useDialogFocusTrap (which also locks body scroll while open).
 *
 * ConfirmDialog props: open, title, message?, confirmLabel? (common.confirm), cancelLabel? (common.cancel), danger?,
 * busy? (disables cancel, shows a spinner on confirm, not dismissible), onConfirm(), onCancel().
 */
import { useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useI18n } from '../i18n';
import { useDialogFocusTrap } from '../components/useDialogFocusTrap';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { cx } from './cx';
import { useUiText } from './uiText';
import './Dialog.css';

export type DialogProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  dismissible?: boolean;
};

export function Dialog({ open, onClose, title, children, footer, size = 'md', dismissible = true }: DialogProps) {
  const tu = useUiText();
  const titleId = useId();
  const ref = useDialogFocusTrap<HTMLDivElement>({
    active: open,
    onEscape: () => {
      if (dismissible) onClose();
    },
  });

  if (!open || typeof document === 'undefined') return null;

  const close = () => {
    if (dismissible) onClose();
  };

  return createPortal(
    <div className="ec-dialog-layer">
      <div
        className="ec-dialog-scrim"
        aria-hidden="true"
        onClick={(e) => {
          if (e.target === e.currentTarget) close();
        }}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx('ec-dialog', `ec-dialog--${size}`)}
      >
        <div className="ec-dialog__head">
          <h2 id={titleId} className="ec-dialog__title">
            {title}
          </h2>
          {dismissible ? (
            <IconButton label={tu('ui.dialog.close')} icon={<X size={16} />} onClick={close} />
          ) : null}
        </div>
        <div className="ec-dialog__body">{children}</div>
        {footer ? <div className="ec-dialog__foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

export type ConfirmDialogProps = {
  open: boolean;
  title: ReactNode;
  message?: ReactNode;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useI18n();

  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      size="sm"
      dismissible={!busy}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy}>
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      {message ? <div className="ec-dialog__message">{message}</div> : null}
    </Dialog>
  );
}
