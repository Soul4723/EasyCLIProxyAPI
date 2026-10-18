/**
 * SegmentedControl: single-choice segmented buttons (radio group) for mode or view switches inside a panel.
 *
 * Props:
 * - value (required) and onChange(v: T)
 * - options: { value: T; label: ReactNode; count?: number; icon?: ReactNode; title?: string }[]
 * - size: 'md' (default, --ec-ctrl-h) | 'sm' (--ec-ctrl-h-sm)
 * - ariaLabel (required): accessible name of the group
 *
 * Options are role="radio" with roving tabindex. Arrow keys, Home and End move focus and select.
 * Use Tabs when switching between tabpanels; use this for filters or modes within a panel.
 */
import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import { cx } from './cx';
import './SegmentedControl.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
  icon?: ReactNode;
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  size?: 'sm' | 'md';
  ariaLabel: string;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  ariaLabel,
}: SegmentedControlProps<T>) {
  const { formatNumber } = useI18n();
  const groupRef = useRef<HTMLDivElement>(null);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const tabStop = selectedIndex >= 0 ? selectedIndex : 0;

  function handleKeyDown(e: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = options.length - 1;
    let next: number;
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        next = index === last ? 0 : index + 1;
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        next = index === 0 ? last : index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    onChange(options[next].value);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }

  return (
    <div ref={groupRef} role="radiogroup" aria-label={ariaLabel} className={cx('ec-seg', `ec-seg--${size}`)}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={index === tabStop ? 0 : -1}
            title={option.title}
            className={cx('ec-seg__item', checked && 'ec-seg__item--on')}
            onClick={() => onChange(option.value)}
            onKeyDown={(e) => handleKeyDown(e, index)}
          >
            {option.icon && (
              <span className="ec-seg__icon" aria-hidden="true">
                {option.icon}
              </span>
            )}
            <span className="ec-seg__label">{option.label}</span>
            {option.count != null && <em className="ec-seg__count">{formatNumber(option.count)}</em>}
          </button>
        );
      })}
    </div>
  );
}
