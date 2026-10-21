/**
 * Skeleton: shimmering placeholder block for loading states.
 *
 * Props:
 * - width?: CSS length or number (px). Default '100%'.
 * - height?: CSS length or number (px). Default 12.
 * - radius?: any CSS border-radius. Default var(--ec-r-sm).
 * - lines?: number of stacked lines. The last line is 60% wide unless width is set explicitly.
 * - className?: added to the wrapper
 *
 * Decorative only (aria-hidden). Put aria-busy="true" on the region that is loading.
 * The shimmer stops under prefers-reduced-motion.
 */
import type { CSSProperties } from 'react';
import { cx } from './cx';
import './Skeleton.css';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: string;
  lines?: number;
  className?: string;
}

function toCss(value: number | string): string {
  return typeof value === 'number' ? `${value}px` : value;
}

export function Skeleton({ width, height = 12, radius = 'var(--ec-r-sm)', lines, className }: SkeletonProps) {
  const blockStyle = (w: number | string): CSSProperties => ({
    width: toCss(w),
    height: toCss(height),
    borderRadius: radius,
  });

  if (!lines || lines <= 1) {
    return <span aria-hidden="true" className={cx('ec-skel', className)} style={blockStyle(width ?? '100%')} />;
  }

  return (
    <span aria-hidden="true" className={cx('ec-skel-lines', className)}>
      {Array.from({ length: lines }, (_, index) => {
        const isLast = index === lines - 1;
        const w = width ?? (isLast ? '60%' : '100%');
        return <span key={index} className="ec-skel" style={blockStyle(w)} />;
      })}
    </span>
  );
}
