/**
 * StatusPill: credential or account status as a tinted pill with a leading dot.
 *
 * Props:
 * - status (required): 'available' | 'limited' | 'cooldown' | 'exhausted' | 'disabled' | 'expired' | 'error' | 'notFetched'
 * - label: override text; default t('ui.status.<status>')
 * - size: 'md' (default) | 'sm' (dense tables)
 * - dot: leading dot, default true. notFetched always renders a hollow dashed dot.
 *
 * Also exports: type CredentialStatus, statusColor(status) (a css var string for --ec-st-*),
 * and STATUS_ORDER (the canonical display order).
 * Use for every status display so colours stay on the --ec-st-* vocabulary. The text always carries the meaning.
 */
import type { CSSProperties } from 'react';
import { useI18n } from '../i18n';
import { cx } from './cx';
import './StatusPill.css';

export type CredentialStatus =
  | 'available'
  | 'limited'
  | 'cooldown'
  | 'exhausted'
  | 'disabled'
  | 'expired'
  | 'error'
  | 'notFetched';

export const STATUS_ORDER: readonly CredentialStatus[] = [
  'available',
  'limited',
  'cooldown',
  'exhausted',
  'disabled',
  'expired',
  'error',
  'notFetched',
];

const STATUS_KEY = {
  available: 'ui.status.available',
  limited: 'ui.status.limited',
  cooldown: 'ui.status.cooldown',
  exhausted: 'ui.status.exhausted',
  disabled: 'ui.status.disabled',
  expired: 'ui.status.expired',
  error: 'ui.status.error',
  notFetched: 'ui.status.notFetched',
} as const;

/** CSS colour (solid) for a status, e.g. 'var(--ec-st-available)'. */
export function statusColor(status: CredentialStatus): string {
  return `var(--ec-st-${status.toLowerCase()})`;
}

export interface StatusPillProps {
  status: CredentialStatus;
  label?: string;
  size?: 'sm' | 'md';
  dot?: boolean;
}

export function StatusPill({ status, label, size = 'md', dot = true }: StatusPillProps) {
  const { t } = useI18n();
  const text = label ?? t(STATUS_KEY[status]);
  const key = status.toLowerCase();
  const style = {
    '--ec-pill-c': `var(--ec-st-${key})`,
    '--ec-pill-fg': `var(--ec-st-${key}-fg)`,
  } as CSSProperties;

  return (
    <span className={cx('ec-pill', `ec-pill--${size}`, `ec-pill--${status}`)} style={style}>
      {dot && (
        <span
          className={cx('ec-pill__dot', status === 'notFetched' && 'ec-pill__dot--hollow')}
          aria-hidden="true"
        />
      )}
      <span className="ec-pill__text">{text}</span>
    </span>
  );
}
