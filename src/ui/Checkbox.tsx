/**
 * Checkbox: native <input type="checkbox"> with a drawn box and an optional visible label.
 *
 * Props (names mirror upstream #481's components/Checkbox):
 * - checked and onChange(event): the change event, like a native input
 * - indeterminate: shows the mixed state (set on the DOM node; checked still drives the next toggle)
 * - invalid: error styling + aria-invalid
 * - label: visible text next to the box (also its accessible name); pass `aria-label` via `ariaLabel` when omitted
 * - disabled, size: 'md' (default 16px) | 'sm' (14px)
 * - ref is forwarded to the input
 *
 * Use for form fields submitted later and for multi-select lists; use Toggle for settings that apply immediately.
 */
import { forwardRef, useCallback, useEffect, useRef, type ChangeEvent, type ReactNode } from 'react';
import { cx } from './cx';
import './Checkbox.css';

export interface CheckboxProps {
  checked: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  label?: ReactNode;
  ariaLabel?: string;
  indeterminate?: boolean;
  invalid?: boolean;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { checked, onChange, label, ariaLabel, indeterminate = false, invalid = false, disabled = false, size = 'md' },
  forwardedRef,
) {
  const inner = useRef<HTMLInputElement | null>(null);
  const setRef = useCallback((node: HTMLInputElement | null) => {
    inner.current = node;
    if (typeof forwardedRef === 'function') forwardedRef(node);
    else if (forwardedRef) forwardedRef.current = node;
  }, [forwardedRef]);
  useEffect(() => {
    if (inner.current) inner.current.indeterminate = indeterminate;
  }, [indeterminate, checked]);

  return (
    <label className={cx('ec-checkbox', `ec-checkbox--${size}`, invalid && 'ec-checkbox--invalid', disabled && 'ec-checkbox--disabled')}>
      <input
        ref={setRef}
        type="checkbox"
        className="ec-checkbox__input"
        checked={checked}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-label={label === undefined ? ariaLabel : undefined}
        onChange={onChange}
      />
      <span className="ec-checkbox__box" aria-hidden="true">
        <svg viewBox="0 0 16 16" className="ec-checkbox__mark ec-checkbox__mark--check"><path d="M3.5 8.5l3 3 6-7" /></svg>
        <svg viewBox="0 0 16 16" className="ec-checkbox__mark ec-checkbox__mark--mixed"><path d="M4 8h8" /></svg>
      </span>
      {label === undefined ? null : <span className="ec-checkbox__label">{label}</span>}
    </label>
  );
});
