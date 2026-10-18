/**
 * ProgressBar and QuotaBar: horizontal meters with role="progressbar".
 *
 * ProgressBar props:
 * - value: number 0–100 (clamped)
 * - tone: 'accent' (default) | 'ok' | 'warn' | 'danger' | 'provider' | 'auto'
 *   'auto' picks ok/warn/danger from value using the quota thresholds (see quotaTone).
 * - color?: any CSS colour (for example --ec-p-* for a provider); overrides the tone colour
 * - height?: px, default 6
 * - label?: accessible name
 * - trackSegments?: number of segments; draws dividers between them
 *
 * QuotaBar props: leftPct (number | null), plus color, height, label, trackSegments.
 *   >= 50 ok (--ec-st-available); 20 to under 50 warn (--ec-st-limited); under 20 danger (--ec-st-exhausted).
 *   null renders an empty hatched track with valuetext t('ui.status.notFetched').
 *
 * quotaTone(leftPct) returns 'ok' | 'warn' | 'danger', or null for null input.
 */
import type { CSSProperties } from 'react';
import { useI18n } from '../i18n';
import { cx } from './cx';
import './ProgressBar.css';

export type ProgressTone = 'ok' | 'warn' | 'danger' | 'accent' | 'provider';
export type ProgressBarTone = 'auto' | ProgressTone;
export type QuotaTone = 'ok' | 'warn' | 'danger';

interface BarOptions {
  color?: string;
  height?: number;
  label?: string;
  trackSegments?: number;
}

export interface ProgressBarProps extends BarOptions {
  value: number;
  tone?: ProgressBarTone;
}

export interface QuotaBarProps extends BarOptions {
  leftPct: number | null;
}

const QUOTA_COLOR: Record<QuotaTone, string> = {
  ok: 'var(--ec-st-available)',
  warn: 'var(--ec-st-limited)',
  danger: 'var(--ec-st-exhausted)',
};

export function quotaTone(leftPct: number | null): QuotaTone | null {
  if (leftPct == null) return null;
  if (leftPct >= 50) return 'ok';
  if (leftPct >= 20) return 'warn';
  return 'danger';
}

function clampPct(value: number): number {
  return Math.min(100, Math.max(0, value));
}

interface BarProps extends BarOptions {
  value: number | null;
  tone: ProgressTone;
  valueText?: string;
}

function Bar({ value, tone, color, height = 6, label, trackSegments, valueText }: BarProps) {
  const empty = value == null;
  const pct = value == null ? 0 : clampPct(value);
  const style = (color ? { height, '--ec-bar-c': color } : { height }) as CSSProperties;
  const ticks =
    trackSegments && trackSegments > 1
      ? Array.from({ length: trackSegments - 1 }, (_, i) => ((i + 1) / trackSegments) * 100)
      : [];

  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={empty ? undefined : Math.round(pct)}
      aria-valuetext={valueText}
      className={cx('ec-bar', `ec-bar--${tone}`, empty && 'ec-bar--hatched')}
      style={style}
    >
      <div className="ec-bar__track">
        {!empty && <div className="ec-bar__fill" style={{ width: `${pct}%` }} />}
        {ticks.map((left) => (
          <span key={left} className="ec-bar__tick" style={{ left: `${left}%` }} aria-hidden="true" />
        ))}
      </div>
    </div>
  );
}

export function ProgressBar({ value, tone = 'accent', ...rest }: ProgressBarProps) {
  const resolved: ProgressTone = tone === 'auto' ? (quotaTone(clampPct(value)) ?? 'accent') : tone;
  return <Bar value={value} tone={resolved} {...rest} />;
}

export function QuotaBar({ leftPct, ...rest }: QuotaBarProps) {
  const { t } = useI18n();
  const tone = quotaTone(leftPct);
  if (tone == null) {
    return <Bar value={null} tone="danger" valueText={t('ui.status.notFetched')} {...rest} />;
  }
  return <Bar value={leftPct} tone={tone} {...rest} color={rest.color ?? QUOTA_COLOR[tone]} />;
}
