/**
 * StatTile: a single metric with label, large value, optional hint and trend slot.
 *
 * Props:
 * - label (required): small muted caption
 * - value (required): the figure, rendered in --ec-fs-stat, semibold, tabular-nums
 * - hint?: small muted note under the value
 * - trend?: any node such as a Sparkline, placed at the right of the footer
 * - icon?: decorative node before the label (aria-hidden)
 * - accent?: any CSS colour, painted as a small leading dot (usually a --ec-* token)
 * - onClick?: renders the tile as a button
 * - href?: renders the tile as a link (takes precedence over onClick)
 *
 * Min-width is 0, so tiles shrink inside grid or flex rows.
 */
import type { ReactNode } from 'react';
import { cx } from './cx';
import './StatTile.css';

export interface StatTileProps {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  trend?: ReactNode;
  icon?: ReactNode;
  accent?: string;
  onClick?: () => void;
  href?: string;
}

export function StatTile({ label, value, hint, trend, icon, accent, onClick, href }: StatTileProps) {
  const interactive = Boolean(href || onClick);
  const body = (
    <>
      <span className="ec-stat__head">
        {accent && <span className="ec-stat__dot" aria-hidden="true" style={{ background: accent }} />}
        {icon && (
          <span className="ec-stat__icon" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="ec-stat__label">{label}</span>
      </span>
      <span className="ec-stat__value">{value}</span>
      {(hint || trend) && (
        <span className="ec-stat__foot">
          {hint && <span className="ec-stat__hint">{hint}</span>}
          {trend && <span className="ec-stat__trend">{trend}</span>}
        </span>
      )}
    </>
  );

  const className = cx('ec-stat', interactive && 'ec-stat--interactive');
  if (href) {
    return (
      <a className={className} href={href}>
        {body}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" className={className} onClick={onClick}>
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}
