import { getCurrentLocale } from '../../i18n';
import { formatDuration, formatUsageNumber } from '../../services/usageNumber';
import type { UsageQuery, UsageRange } from './types';

export const RANGES: readonly UsageRange[] = ['4h', '24h', 'today', '7d', '30d', 'all'];

export const compactNumber = (value: number) => formatUsageNumber(value, getCurrentLocale());
export const compactDuration = (value: number) => formatDuration(value, getCurrentLocale());

export const formatStorageBytes = (value: number) => {
  const bytes = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

/** Estimated-cost formatting (more digits for tiny amounts). Always show with a "~" prefix in the UI. */
export const formatUsd = (amount: number) => {
  if (!Number.isFinite(amount) || amount <= 0) return '$0.00';
  const maximumFractionDigits = amount >= 100 ? 2 : amount >= 1 ? 3 : amount >= 0.01 ? 4 : amount >= 0.0001 ? 6 : 8;
  return `$${new Intl.NumberFormat(getCurrentLocale(), { minimumFractionDigits: 2, maximumFractionDigits }).format(amount)}`;
};

export const rangeQuery = (range: UsageRange, customStart: string, customEnd: string): Pick<UsageQuery, 'start' | 'end'> => {
  const now = new Date();
  if (range === 'all') return {};
  if (range === 'custom') {
    const start = customStart ? new Date(customStart) : null;
    const end = customEnd ? new Date(customEnd) : null;
    return {
      start: start && !Number.isNaN(start.getTime()) ? start.toISOString() : undefined,
      end: end && !Number.isNaN(end.getTime()) ? end.toISOString() : undefined,
    };
  }
  if (range === 'today') {
    return { start: new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString(), end: now.toISOString() };
  }
  const hours = range === '4h' ? 4 : range === '24h' ? 24 : range === '7d' ? 24 * 7 : 24 * 30;
  return { start: new Date(now.getTime() - hours * 3_600_000).toISOString(), end: now.toISOString() };
};
