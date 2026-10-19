/** Shared pure display formatters. Distinct names preserve distinct output contracts. */
import type { UiKey, UiTranslate } from '../ui/uiText';

/**
 * Pure number and byte formatting helpers (no hooks, no React).
 *
 * formatCompactNumber(n, locale?)  -> "1.2K", "3.4M"
 * formatPercent(n, digits = 0)     -> "42%" (expects n already on a 0-100 scale)
 * formatBytes(n)                   -> "0 B", "1.5 MB" (binary units, one decimal above bytes)
 * clamp(n, min, max)               -> n limited to [min, max]
 */

export function formatCompactNumber(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function formatPercent(n: number, digits = 0, locale?: string): string {
  const formatted = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(n);
  return `${formatted}%`;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const index = Math.min(Math.floor(Math.log(n) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = n / 1024 ** index;
  return `${value.toFixed(index === 0 ? 0 : 1)} ${BYTE_UNITS[index]}`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

const THOUSAND = 1_000;
const MILLION = 1_000_000;
const BILLION = 1_000_000_000;

export const formatUsageNumber = (value: number, locale: string) => {
  const amount = Number.isFinite(value) ? value : 0;
  const absolute = Math.abs(amount);
  const roundedThousands = Math.round((absolute / THOUSAND) * 10) / 10;
  const roundedMillions = Math.round((absolute / MILLION) * 10) / 10;
  const useBillions = absolute >= BILLION || roundedMillions >= 1_000;
  const useMillions = !useBillions && (absolute >= MILLION || roundedThousands >= 1_000);
  const useThousands = !useBillions && !useMillions && absolute >= THOUSAND;
  const divisor = useBillions ? BILLION : useMillions ? MILLION : useThousands ? THOUSAND : 1;
  const unit = useBillions ? "B" : useMillions ? "M" : useThousands ? "K" : "";
  const formatted = new Intl.NumberFormat(locale, {
    maximumFractionDigits: divisor === 1 ? 0 : 1,
  }).format(amount / divisor);

  return `${formatted}${unit}`;
};

export const formatLatency = (value: number, locale: string) => {
  const milliseconds = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (milliseconds < 1_000) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(milliseconds)} ms`;
  }
  const seconds = milliseconds / 1_000;
  const maximumFractionDigits = seconds >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat(locale, {
    maximumFractionDigits,
    minimumFractionDigits: seconds >= 10 ? 0 : 1,
  }).format(seconds)} s`;
};

const DURATION_UNITS: Array<{ key: UiKey; size: number }> = [
  { key: 'ui.time.d', size: 86_400_000 },
  { key: 'ui.time.h', size: 3_600_000 },
  { key: 'ui.time.m', size: 60_000 },
  { key: 'ui.time.s', size: 1_000 },
];

/** Formats a duration with at most `maxParts` consecutive units, e.g. "1h 48m". Pure; no hooks. */
export function formatDurationParts(ms: number, t: UiTranslate, maxParts = 2): string {
  let rest = Math.max(0, Math.floor(ms / 1000)) * 1000;
  const parts: string[] = [];
  for (const unit of DURATION_UNITS) {
    const n = Math.floor(rest / unit.size);
    if (n > 0) {
      parts.push(t(unit.key, { n }));
      rest -= n * unit.size;
      if (parts.length >= maxParts) break;
    }
  }
  return parts.length > 0 ? parts.join(' ') : t('ui.time.s', { n: 0 });
}

/** Month/day and local clock, used by quota-window tooltips and lighting details. */
export function formatShortDateTime(value: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value);
}

/** Numeric month/day and 24-hour clock; deliberately omits the year. */
export function formatNumericDateTime24(value: Date | number, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(value);
}
