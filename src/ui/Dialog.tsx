/**
 * Dialog: centred modal (portal to body) with scrim, focus trap and Escape handling. ConfirmDialog: Dialog with a
 * confirm/cancel footer.
 *
 * Dialog props: open, onClose, title (ReactNode), children, footer?, size ('sm' 400px | 'md' 520px default | 'lg' 760px),
 * dismissible (default true), initialFocusRef?, alert? (role=alertdialog), busy? (aria-busy, not dismissible).
 * When not dismissible, Escape, the scrim and the close button do nothing.
 * Focus is trapped with useDialogFocusTrap (which also locks body scroll while open), mounted in an inner body that
 * exists only while open; the prop names mirror upstream PR #481's controls/theme refactor in components/Dialog (initialFocusRef, alert, busy).
 *
 * ConfirmDialog props: open, title, message?, confirmLabel? (common.confirm), cancelLabel? (common.cancel), danger?,
 * busy? (disables cancel, shows a spinner on confirm, not dismissible), onConfirm(), onCancel().
 */
import { useId, type ReactNode, type RefObject } from 'react';
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
  /** Element focused on open instead of the first control. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** role="alertdialog" for interruptions that need an answer. */
  alert?: boolean;
  /** Work in flight: sets aria-busy and blocks dismissal. */
  busy?: boolean;
};

/**
 * The focus-trap hook runs in this body, which only exists while the dialog is open, so the hook never needs its
 * `active` option (mount = open, unmount = close and restore focus).
 */
function DialogBody({
  onClose, title, children, footer, size = 'md', dismissible = true, initialFocusRef, alert = false, busy = false,
}: Omit<DialogProps, 'open'>) {
  const tu = useUiText();
  const titleId = useId();
  const canDismiss = dismissible && !busy;
  const close = () => {
    if (canDismiss) onClose();
  };
  const ref = useDialogFocusTrap<HTMLDivElement>({ onEscape: close, initialFocusRef });

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
        role={alert ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-busy={busy || undefined}
        tabIndex={-1}
        className={cx('ec-dialog', `ec-dialog--${size}`)}
      >
        <div className="ec-dialog__head">
          <h2 id={titleId} className="ec-dialog__title">
            {title}
          </h2>
          {canDismiss ? (
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

export function Dialog({ open, ...rest }: DialogProps) {
  if (!open || typeof document === 'undefined') return null;
  return <DialogBody {...rest} />;
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
      alert={danger}
      busy={busy}
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
