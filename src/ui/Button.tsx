/**
 * Button: the primary command control for actions.
 *
 * Props:
 * - variant: 'primary' (accent fill, one per view) | 'secondary' (default) | 'ghost' | 'danger' | 'outline'
 * - size: 'md' (default, --ec-ctrl-h) | 'sm' (--ec-ctrl-h-sm) | 'xs' (22px, dense toolbars)
 * - icon: leading icon node, rendered aria-hidden at 14px (12px for xs)
 * - loading: replaces the icon with a spinner, disables the button and sets aria-busy
 * - ...native button attributes; `type` defaults to "button"; ref is forwarded
 *
 * Use for text actions. Use IconButton for icon-only controls and Chip for tags.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cx } from './cx';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
export type ButtonSize = 'xs' | 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon, loading = false, disabled = false, type = 'button', className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('ec-btn', `ec-btn--${variant}`, `ec-btn--${size}`, loading && 'ec-btn--loading', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <LoaderCircle className="ec-btn__spin" aria-hidden="true" />
      ) : icon ? (
        <span className="ec-btn__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      {children != null && <span className="ec-btn__label">{children}</span>}
    </button>
  );
});
