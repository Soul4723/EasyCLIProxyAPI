/**
 * FilterChips: horizontally scrollable row of toggle chips for filtering a list.
 *
 * Props:
 * - value (required): the selected option value
 * - onChange(v: T)
 * - options: { value: T; label: string; count?: number; color?: string; icon?: ReactNode }[]
 *   The consumer supplies the "all" option itself (for example value 'all', label t('ui.filter.all')).
 * - ariaLabel (required): accessible name of the group
 *
 * Each chip is a button with aria-pressed. color (any CSS colour, usually a --ec-* token) paints a leading dot.
 */
import type { CSSProperties, ReactNode } from 'react';
import { useI18n } from '../i18n';
import { cx } from './cx';
import './FilterChips.css';

export interface FilterOption<T extends string> {
  value: T;
  label: string;
  count?: number;
  color?: string;
  icon?: ReactNode;
}

export interface FilterChipsProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  options: FilterOption<T>[];
  ariaLabel: string;
}

export function FilterChips<T extends string>({ value, onChange, options, ariaLabel }: FilterChipsProps<T>) {
  const { formatNumber } = useI18n();
  return (
    <div role="group" aria-label={ariaLabel} className="ec-filters">
      {options.map((option) => {
        const on = option.value === value;
        const style = option.color ? ({ '--ec-filter-c': option.color } as CSSProperties) : undefined;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            className={cx('ec-filters__chip', on && 'ec-filters__chip--on')}
            style={style}
            onClick={() => onChange(option.value)}
          >
            {option.color && <span className="ec-filters__dot" aria-hidden="true" />}
            {option.icon && (
              <span className="ec-filters__icon" aria-hidden="true">
                {option.icon}
              </span>
            )}
            <span className="ec-filters__label">{option.label}</span>
            {option.count != null && <em className="ec-filters__count">{formatNumber(option.count)}</em>}
          </button>
        );
      })}
    </div>
  );
}
