/**
 * Pure number and byte formatting helpers for the UI kit (no hooks, no React).
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
