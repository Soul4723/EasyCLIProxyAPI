/**
 * IconButton: square, icon-only button for toolbars, row actions and toggles.
 *
 * Props:
 * - label (required): accessible name and tooltip (sets both aria-label and title); pass a translated string
 * - icon (required): lucide icon node at 14-16px; rendered aria-hidden
 * - variant: 'ghost' (default) | 'outline' | 'primary'
 * - size: 'md' (default, --ec-ctrl-h) | 'sm' (--ec-ctrl-h-sm) | 'xs' (22px)
 * - active: boolean toggle state; when provided, sets aria-pressed
 * - ...native button attributes; ref is forwarded
 *
 * Use for icon-only commands. Use Button when the action needs a visible text label.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cx } from './cx';
import './IconButton.css';

export type IconButtonVariant = 'ghost' | 'outline' | 'primary';
export type IconButtonSize = 'xs' | 'sm' | 'md';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: ReactNode;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'ghost', size = 'md', active, type = 'button', disabled = false, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      className={cx(
        'ec-icon-btn',
        `ec-icon-btn--${variant}`,
        `ec-icon-btn--${size}`,
        active && 'ec-icon-btn--active',
        className,
      )}
      aria-pressed={active}
      {...rest}
      aria-label={label}
      title={label}
    >
      <span className="ec-icon-btn__icon" aria-hidden="true">
        {icon}
      </span>
    </button>
  );
});
