/**
 * Chip: small tag for labels, active filters and removable selections. Also exports Badge.
 *
 * Chip props:
 * - tone: 'neutral' (default) | 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'outline'
 * - size: 'md' (default) | 'sm'
 * - icon: leading icon node (aria-hidden)
 * - onRemove: when set, shows a remove button
 * - removeLabel: accessible name of the remove button; default t('ui.clear')
 * - children: already-translated text
 *
 * Badge props:
 * - count: number (formatted with the locale) or children: short label text
 * - tone: same tones as Chip
 * Badge is a tiny monospace count or label, for tab counts, headers and rows.
 */
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useI18n } from '../i18n';
import { cx } from './cx';
import './Chip.css';

export type ChipTone = 'neutral' | 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'outline';

export interface ChipProps {
  tone?: ChipTone;
  size?: 'sm' | 'md';
  icon?: ReactNode;
  onRemove?: () => void;
  removeLabel?: string;
  children?: ReactNode;
}

export function Chip({ tone = 'neutral', size = 'md', icon, onRemove, removeLabel, children }: ChipProps) {
  const { t } = useI18n();
  const removeText = removeLabel ?? t('ui.clear');
  return (
    <span className={cx('ec-chip', `ec-chip--${tone}`, `ec-chip--${size}`)}>
      {icon && (
        <span className="ec-chip__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      {children != null && <span className="ec-chip__text">{children}</span>}
      {onRemove && (
        <button
          type="button"
          className="ec-chip__remove"
          aria-label={removeText}
          title={removeText}
          onClick={onRemove}
        >
          <X aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

export interface BadgeProps {
  count?: number;
  children?: ReactNode;
  tone?: ChipTone;
}

export function Badge({ count, children, tone = 'neutral' }: BadgeProps) {
  const { formatNumber } = useI18n();
  return (
    <span className={cx('ec-badge', `ec-badge--${tone}`)}>
      {count != null ? formatNumber(count) : children}
    </span>
  );
}
