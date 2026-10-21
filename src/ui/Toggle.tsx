/**
 * Toggle: on/off switch, role="switch".
 *
 * Props:
 * - checked (required) and onChange(next: boolean)
 * - label (required): accessible name (aria-label); the visible text is the caller's job
 * - disabled: default false
 * - size: 'md' (default, 32x20) | 'sm' (26x16)
 * - ref is forwarded to the button
 *
 * Use for settings that apply immediately. Use a checkbox for form fields that are submitted later.
 */
import { forwardRef } from 'react';
import { cx } from './cx';
import './Toggle.css';

export interface ToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { checked, onChange, label, disabled = false, size = 'md' },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={cx('ec-toggle', `ec-toggle--${size}`, checked && 'ec-toggle--on')}
      onClick={() => onChange(!checked)}
    >
      <span className="ec-toggle__knob" aria-hidden="true" />
    </button>
  );
});
